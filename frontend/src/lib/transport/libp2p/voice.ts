import type { Libp2p } from "libp2p";
import type { VoiceTransport, VoiceEvents } from "../types";
import type { AppServices, LibP2PTransport } from "./transport";
import type { DtlnProcessor } from "$lib/audio/dtln-processor";
import { getIceServers } from "../ice-server-list";
import { MessageType } from "$lib/types/message";
import { encode } from "$lib/utils";
import { CallAudioMixer } from "$lib/audio/call-audio-mixer";

/** Same ceiling as the output slider in audio settings. */
export const MAX_PEER_VOLUME = 2.5;
/** How often the roster and the actual voice links are compared. */
const VOICE_RECONCILE_MS = 4_000;
/**
 * Per-peer redial backoff: a flat step up to a low ceiling, not doubling.
 * It exists only to stop a hot loop (an RTCPeerConnection with no working ICE
 * fails instantly, tears itself down and redials, at ~20 dials a second) - and
 * a flat 2s step does that just as well as doubling. Doubling to 30s meant
 * four benign failures, of the "peer not in the peerstore yet" sort, bought a
 * half-minute of silence.
 */
const VOICE_DIAL_STEP_MS = 2_000;
const VOICE_DIAL_MAX_MS = 8_000;
/**
 * How long a link may sit in a non-connected state before we call it wedged
 * and rebuild it. Covers a handshake in flight and an ICE restart; past this
 * the connection never comes back on its own.
 */
const VOICE_LINK_GRACE_MS = 20_000;
/**
 * Hard deadline for a link that has NEVER connected. The grace above is
 * measured from the last sign of progress - and ICE re-entering "checking"
 * counts as progress, so a broken pair that flaps checking/disconnected
 * refreshes it forever and the wedge timer never fires. A handshake that
 * has not completed once in 30s is not slow, it is not going to happen.
 */
const VOICE_SETUP_DEADLINE_MS = 30_000;
/** Age past which a never-connected link stops overriding the peer's redial ask. */
const VOICE_ASK_TRUMPS_HANDSHAKE_MS = 10_000;
/**
 * Ceiling on ICE candidates buffered per peer while waiting on their remote
 * description: an admitted peer that never completes offer/answer should not
 * be able to grow this without bound.
 */
const MAX_PENDING_CANDIDATES = 256;
/** Rate limit on asking the other side to dial us. */
const VOICE_REDIAL_ASK_MS = 5_000;
/**
 * How long a blip on an ESTABLISHED link may still recover by itself before
 * the repair machinery treats the link as dead. An ICE restart that is going
 * anywhere shows progress ("checking" refreshes okAt) well inside this; the
 * full VOICE_LINK_GRACE_MS was gating repair decisions on it too, which
 * added up to twenty silent seconds on each side of a rebuild - the
 * "disconnects take forever to come back" experience.
 */
const VOICE_BLIP_GRACE_MS = 5_000;
/**
 * Zero-growth window for the inbound-media watchdog (finding 3). A link can
 * read "connected" - ICE never reports trouble - while the audio it is
 * supposed to be carrying has stopped arriving entirely: a dead DTLN
 * worklet, a replaceTrack that rejected mid-switch, a dropped renegotiation.
 * Nothing but bytesReceived on the inbound-rtp report can tell the
 * difference between that and a peer who is simply quiet. Twice the
 * reconcile tick, so one missed sample cannot trip it, and zero growth
 * rather than slow growth, so DTX/comfort-noise trickle and a legitimately
 * muted peer (applyMuteState flips `enabled` on live tracks, which keeps
 * RTP flowing) do not.
 */
const VOICE_MEDIA_STALL_MS = 8_000;

// The DTLN set: browser noise suppression OFF (the model replaces it), but
// echo cancellation ON. DTLN is noise suppression, not echo cancellation - a
// friend's voice out of the speakers is speech, not noise, so with AEC off
// the model passed it from the mic straight back to them. Everyone heard an
// echo whenever anyone talked, which read as "DTLN is processing inbound
// audio too" (it never touches the inbound path). AEC runs at capture,
// before the track reaches the worklet, so the two compose.
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

const AUDIO_CONSTRAINTS_NO_DTLN: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  // ON, as it was before the DTLN commit flipped it off with no comment.
  // This is what pulls a quiet mic toward a target level before encoding -
  // without it, everyone's loudness is whatever their hardware happens to
  // produce, and every listener compensates per friend by hand.
  autoGainControl: true,
};

type VoiceSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

/**
 * Narrows a JSON.parse result to VoiceSignal before it touches the
 * RTCPeerConnection. sdp's length is already bounded by MAX_FRAME_BYTES on
 * the wire, so there is nothing further to check there beyond "is a string".
 */
export function isVoiceSignal(value: unknown): value is VoiceSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; sdp?: unknown; candidate?: unknown };
  switch (v.type) {
    case "offer":
    case "answer":
      return typeof v.sdp === "string";
    case "ice":
      return (
        !!v.candidate &&
        typeof v.candidate === "object" &&
        typeof (v.candidate as { candidate?: unknown }).candidate === "string"
      );
    default:
      return false;
  }
}

interface RemotePeer {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  audio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  peerId: string;
  pendingCandidates: RTCIceCandidateInit[];
  /** When this RTCPeerConnection was built; never-connected links age out. */
  createdAt: number;
  /** Whether the pc has reached "connected" at least once. */
  everConnected: boolean;
  /**
   * Last moment this link made progress. Not just "when it connected": a slow
   * network (mobile, TURN) can take longer to set up than the wedge timeout,
   * and tearing that down mid-handshake is worse than the stall it guards
   * against - the rebuild gets the same budget and the pair never converges.
   */
  okAt: number;
  /**
   * Last audio inbound-rtp bytesReceived sample, or null before the first
   * poll lands. Watchdog state for finding 3 - see pollInboundMedia.
   */
  lastBytesReceived: number | null;
  /**
   * When bytesReceived last increased. Polled on the reconcile tick, so
   * this can lag live reality by up to VOICE_RECONCILE_MS.
   */
  lastBytesReceivedAt: number;
}

export class LibP2PVoice implements VoiceTransport {
  private node: Libp2p<AppServices> | null = null;
  private audioCtx: AudioContext | null = null;
  private callAudioMixer: CallAudioMixer | null = null;
  /**
   * Shared playback bus: every per-peer gain feeds this compressor, which
   * feeds the speakers. This is the leveling stage the chain never had -
   * nothing on the way in guarantees loudness (the DTLN path runs without
   * AGC on purpose), so listeners were riding per-friend sliders by hand.
   * The Web Audio compressor applies makeup gain from its own curve, so
   * quiet voices come up and peaks stop clipping - the receive half of what
   * Discord does. Per-peer sliders still work: they sit before the bus.
   */
  private outputBus: DynamicsCompressorNode | null = null;
  private micStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;

  private activeInputDevice: string | null = null;
  private activeOutputDevice: string | null = null;
  private currentInputGain = 1.0;
  private currentOutputVolume = 1.0;
  private muted = false;

  private remotePeers = new Map<string, RemotePeer>();
  // ponytail: no per-peer signal queue anymore - the app transport's send()
  // already queues frames until the stream is confirmed and reports failure.
  /**
   * Per-peer listening volume, multiplied with the master output volume.
   * Kept outside RemotePeer so the setting survives that peer dropping and
   * rejoining. Deliberately NOT cleared by leave(): it lasts the session, and
   * the durable copy lives in audio-prefs keyed by DID.
   */
  private peerVolumes = new Map<string, number>();
  private active = new Set<string>();
  /**
   * Who the app says shares our call. Voice links used to be created only on
   * a libp2p "connect" event or in the join sweep, so a peer who joined the
   * call over a connection that was ALREADY up got no link - and since only
   * one side of a pair dials, that was a coin flip per pair. Hence "hop out
   * and back into the call to sync": rejoining re-ran the sweep from the
   * other side. The roster plus the reconcile tick below replace that.
   */
  private callPeers = new Set<string>();
  /**
   * Whether the roster has been fed at least once. Without it, the first
   * reconcile would see an empty roster and tear down healthy links.
   */
  private rosterSeen = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** Dials in flight: two at once would attach two streams to one peer. */
  private dialing = new Set<string>();
  private nextDialAt = new Map<string, number>();
  private dialBackoff = new Map<string, number>();
  /** peerId -> when we last asked them to dial us. */
  private lastRedialAsk = new Map<string, number>();
  /** peerId -> when we last acted on their ask. */
  private lastRedialServed = new Map<string, number>();
  /**
   * Dev counters. Voice failures are invisible without them: an ICE pair can
   * die while both RTCPeerConnections still read "connected", so both sides
   * look fine while no audio crosses.
   */
  readonly debugStats = {
    offersSent: 0,
    offersIn: 0,
    answersIn: 0,
    signalsInvalid: 0,
    teardowns: 0,
    redialsAsked: 0,
    redialsServed: 0,
    tdNotConnected: 0,
    tdNotInRoster: 0,
    tdUnhealthy: 0,
    tdPeerGone: 0,
    tdPcFailed: 0,
  };
  private handlers = new Map<keyof VoiceEvents, Set<Function>>();

  private dtlnEnabled = true;

  private onTransportConnect: ((peerId: string) => void) | null = null;
  private onTransportDisconnect: (peerId: string) => void | null = () => {};

  constructor(
    private transport: LibP2PTransport,
    private dtln: DtlnProcessor | null = null
  ) {}

  async join(_roomCode: string): Promise<void> {
    this.node = this.transport.p2pNode;
    if (!this.node) throw new Error("Transport not connected");

    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume().catch(() => {});
    }
    // ponytail: default compressor curve (threshold -24dB, ratio 12, with
    // implicit makeup gain per the Web Audio spec); tune only if voices pump.
    this.outputBus = this.audioCtx.createDynamicsCompressor();
    this.outputBus.connect(this.audioCtx.destination);
    this.callAudioMixer = new CallAudioMixer(this.audioCtx);
    this.processedStream = this.callAudioMixer.outputStream();

    // A worklet that dies after init would otherwise transmit digital
    // silence forever - the track stays live, RTP keeps flowing, and
    // connectionState reads "connected" on both ends (finding 1). Rebuild
    // the mic once instead of leaving that peer permanently unheard.
    this.dtln?.onFatal(() => this.handleDtlnFatal());

    try {
      await this.startMic(this.activeInputDevice ?? undefined);
    } catch {
      // listen-only mode
    }

    // Both edges just re-run the reconcile: a peer appearing or vanishing is
    // one more reason for the links to disagree with the roster, and the
    // repair for either is the same.
    this.onTransportConnect = () => this.reconcileLinks();
    this.onTransportDisconnect = (peerId: string) => {
      if (!this.remotePeers.has(peerId)) return;
      this.debugStats.tdPeerGone++;
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    };

    this.transport.on("connect", this.onTransportConnect);
    this.transport.on("disconnect", this.onTransportDisconnect);

    this.reconcileTimer ??= setInterval(
      () => this.reconcileLinks(),
      VOICE_RECONCILE_MS
    );
    this.reconcileLinks();
  }

  /**
   * Who we should have a voice link with. Fed from the call roster, which is
   * kept by presence heartbeats, so it already reflects late joiners, people
   * who left, and ghosts the TTL swept.
   */
  setCallPeers(peerIds: Iterable<string>): void {
    this.callPeers = new Set(peerIds);
    this.rosterSeen = true;
    this.reconcileLinks();
  }

  /**
   * Whether an inbound voice signal from this peer should be admitted.
   * Default deny: before setCallPeers() has run at least once, nothing is
   * admitted, roster membership or not.
   */
  private admitsInboundStream(peerId: string): boolean {
    return this.rosterSeen && this.callPeers.has(peerId);
  }

  /**
   * A VoiceSignal frame arrived on the app transport.
   *
   * Signalling rides the app's confirmed direct streams, not a dedicated
   * /voice/ protocol stream. The dedicated stream had no delivery proof: one
   * opened on a connection whose far side is gone - exactly what a reload
   * leaves behind, since the relay keeps the dead connection object looking
   * open - reported itself open while every offer vanished, and the repair
   * loop re-picked the same dead connection each rebuild. That was the call
   * that flapped "reconnecting" forever after a redeploy while chat and ping
   * worked fine, until both sides hung up and re-called. The app transport
   * pings a stream before trusting it and re-opens it elsewhere on failure,
   * so a signal either arrives or send() resolves false.
   */
  handleWireSignal(peerId: string, signal: unknown): void {
    if (!isVoiceSignal(signal)) {
      this.debugStats.signalsInvalid++;
      return;
    }
    // Same default-deny the /voice/1.0.0 inbound handler enforced: an offer
    // creates the RTCPeerConnection and attaches the live mic track, so only
    // roster members may have one. Identity is the peerId the frame's stream
    // is Noise-authenticated to, never anything on the wire.
    if (!this.admitsInboundStream(peerId)) return;
    // Only an offer creates state; an answer or candidate for a peer we hold
    // nothing for is stale and handleSignal drops it.
    if (signal.type === "offer") this.ensureRemotePeer(peerId);
    this.handleSignal(peerId, signal).catch(() => {});
  }

  /** Dev-only view of what the voice layer thinks it is holding. */
  debugVoice(): {
    roster: string[];
    links: Record<string, string>;
    stats: Record<string, number>;
  } {
    const links: Record<string, string> = {};
    for (const [peerId, remote] of this.remotePeers) {
      links[peerId] = remote.pc.connectionState;
    }
    return { roster: [...this.callPeers], links, stats: { ...this.debugStats } };
  }

  /**
   * Make the voice links match the roster. Runs on a tick as well as on every
   * roster and peer change, because the failures that matter here are the
   * ones where the last event is the one that got lost: a dial that failed
   * while the peer was still finishing its relay reservation, an RTCPeer
   * connection that went to "failed" and was torn down with nothing left to
   * re-create it, a peer who joined the call over a connection that was
   * already up. All of them used to need a manual leave-and-rejoin.
   *
   * Costs nothing when everything is healthy: a set walk and a state read.
   */
  private reconcileLinks(): void {
    if (!this.node || !this.rosterSeen) return;
    const self = this.transport.selfId();
    const connected = new Set(this.transport.peers());
    const now = Date.now();

    // A browser or OS audio interruption suspends this context, and
    // nothing else resumes it - the visibility handler only resumes the
    // analyser context in speakers.svelte.ts, not this one (finding 7).
    // Every tile keeps reading connected and every speaking ring keeps
    // animating while the user hears nothing.
    if (this.audioCtx?.state === "suspended") {
      void this.audioCtx.resume().catch(() => {});
    }

    // Finding 3's watchdog: sample inbound bytes for every currently-
    // connected link on this same tick. Fire-and-forget - see
    // pollInboundMedia - so it costs nothing when nobody is stalled.
    for (const remote of this.remotePeers.values()) {
      if (remote.pc.connectionState === "connected") {
        void this.pollInboundMedia(remote, now);
      }
    }

    // Drop links that should not exist or have wedged. Both sides do this:
    // a stale RTCPeerConnection on the passive side rejects the fresh offer
    // ("unexpected signaling state") and blocks the other side's repair.
    for (const [peerId, remote] of [...this.remotePeers]) {
      if (!connected.has(peerId)) this.debugStats.tdNotConnected++;
      else if (!this.callPeers.has(peerId)) this.debugStats.tdNotInRoster++;
      else if (this.dialing.has(peerId)) continue; // still being set up
      else if (!this.linkIsHealthy(remote, now)) this.debugStats.tdUnhealthy++;
      else continue;
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }

    for (const peerId of this.callPeers) {
      if (!connected.has(peerId) || this.transport.isRelay(peerId)) continue;
      // One dialer per pair, the lower id waits: two simultaneous dials give
      // one peer two signaling streams and two colliding offers.
      if (peerId > self) {
        // We are not this pair's dialer, so all we can do is ask - but ask we
        // must. Measured: when the passive side's RTCPeerConnection fails it
        // is torn down, and without this it waits for the dialer to notice its
        // own side independently, which is an ICE timeout plus a reconcile
        // tick. That wait is the "I cannot hear them until I leave and rejoin"
        // window. The request rides the app transport, which already confirms
        // its streams, so it does not depend on the very link that is broken.
        const remote = this.remotePeers.get(peerId);
        if (!remote) {
          this.askForRedial(peerId, now);
        } else if (
          // An established link sitting blipped with no sign of recovery is
          // dead in all but name. Waiting for linkIsHealthy to tear it down
          // (the full wedge grace) before asking added most of the "takes
          // forever to come back" - ask now; the dialer applies the same
          // blip grace to its own end before honoring it.
          remote.everConnected &&
          remote.pc.connectionState !== "connected" &&
          now - remote.okAt >= VOICE_BLIP_GRACE_MS
        ) {
          this.askForRedial(peerId, now);
        }
        continue;
      }
      if (this.dialing.has(peerId) || this.remotePeers.has(peerId)) continue;
      this.dialAndOffer(peerId).catch(() => {});
    }
  }

  private askForRedial(peerId: string, now: number): void {
    if (now - (this.lastRedialAsk.get(peerId) ?? 0) < VOICE_REDIAL_ASK_MS) return;
    this.lastRedialAsk.set(peerId, now);
    this.debugStats.redialsAsked++;
    void this.transport
      .send(peerId, encode({ type: MessageType.VoiceRedial }))
      .catch(() => {});
  }

  /** The other side says its voice link to us is dead. Rebuild it now. */
  handleRedialRequest(peerId: string): void {
    if (!this.node || !this.callPeers.has(peerId)) return;
    if (peerId > this.transport.selfId()) return; // we are not their dialer
    // Rate limit the RECEIVING side too. The sender's limit is no protection
    // at all: a peer stuck in a redial loop (or one that simply means us harm)
    // would otherwise tear our link down on every message, and since only the
    // rebuild was rate limited, a healthy call could be flapped from outside.
    const now = Date.now();
    if (now - (this.lastRedialServed.get(peerId) ?? 0) < VOICE_REDIAL_ASK_MS) {
      return;
    }
    const remote = this.remotePeers.get(peerId);
    // Our own "connected" says nothing about THEIR end. An RTCPeerConnection
    // sits at "connected" until ICE consent expires, tens of seconds after the
    // far side closed, and the passive side only asks once its own link is
    // gone entirely - so it is the better witness and we rebuild on its word.
    // Refusing while ours read "connected" is what left one side deaf with
    // nothing able to repair it.
    //
    // A link that is still mid-handshake is the one exception: replacing it
    // hands the replacement the same budget and the pair never converges.
    // But only a YOUNG handshake earns that protection - one that has not
    // completed in 10s is not in progress, it is stuck, and refusing the ask
    // on its behalf is what starved the third caller until a manual rejoin
    // (every rebuild looked "mid-handshake" again).
    if (
      remote &&
      remote.pc.connectionState !== "connected" &&
      !remote.everConnected &&
      now - remote.createdAt < VOICE_ASK_TRUMPS_HANDSHAKE_MS &&
      this.linkIsHealthy(remote, now)
    ) {
      return;
    }
    // An ESTABLISHED link that has merely blipped: their ask must beat our
    // stale "connected", not a link actually mid-recovery. Recovery in
    // progress shows itself - "checking" refreshes okAt - so only a blip
    // still inside the short grace earns the refusal. Waiting out the full
    // linkIsHealthy grace here meant refusing asks for twenty seconds while
    // both ends already knew the link was dead.
    if (
      remote &&
      remote.everConnected &&
      remote.pc.connectionState !== "connected" &&
      now - remote.okAt < VOICE_BLIP_GRACE_MS
    ) {
      return;
    }
    // Stamped only once we act, so a refused ask does not spend the slot the
    // next real one needs. What the limit has to bound is the teardown below,
    // and that is still one per interval however often they ask.
    this.lastRedialServed.set(peerId, now);
    this.debugStats.redialsServed++;
    if (remote) {
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }
    // Clearing the backoff is safe here: the serve itself is rate-limited to
    // one per VOICE_REDIAL_ASK_MS above, so a peer still cannot make us dial
    // in a loop - and leaving it meant a rebuild both sides had already
    // agreed on sat out up to VOICE_DIAL_MAX_MS for nothing.
    this.nextDialAt.delete(peerId);
    this.dialBackoff.delete(peerId);
    this.dialAndOffer(peerId).catch(() => {});
  }

  /** Note progress on a link so the wedge check does not fire mid-handshake. */
  private touchLink(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (remote) remote.okAt = Date.now();
  }

  private linkIsHealthy(remote: RemotePeer, now: number): boolean {
    const state = remote.pc.connectionState;
    if (state === "failed" || state === "closed") return false;
    if (state === "connected") {
      remote.everConnected = true;
      // Finding 3: "connected" proves nothing about whether audio is
      // actually arriving. A link whose inbound bytes have gone flat for
      // VOICE_MEDIA_STALL_MS gets no okAt refresh here - it falls through
      // to the same blip/wedge grace below that a stalled ICE state would,
      // instead of this short-circuit hiding the stall forever.
      if (
        remote.lastBytesReceived === null ||
        now - remote.lastBytesReceivedAt < VOICE_MEDIA_STALL_MS
      ) {
        remote.okAt = now;
        // A working link is the only proof worth resetting the backoff on:
        // opening a signalling stream says nothing about whether media flows.
        this.nextDialAt.delete(remote.peerId);
        this.dialBackoff.delete(remote.peerId);
        return true;
      }
    }
    // A link that has never worked does not get the benefit of "progress":
    // ICE flapping back into "checking" refreshes okAt forever on a pair
    // that is simply broken, and that starvation held a wedged link - and
    // with it the whole repair path - until a manual leave and rejoin.
    if (!remote.everConnected && now - remote.createdAt > VOICE_SETUP_DEADLINE_MS) {
      return false;
    }
    // "new" / "connecting" / "disconnected", or "connected" with media
    // stalled: legitimate for a moment, a wedge once it outlasts a
    // handshake and an ICE restart.
    return now - remote.okAt < VOICE_LINK_GRACE_MS;
  }

  /**
   * Finding 3's watchdog sample. Polled from the existing reconcile tick -
   * no new timer - so linkIsHealthy always sees a value at most one tick
   * stale. Fire-and-forget: getStats() is async and reconcileLinks is not,
   * so this tick's teardown decisions still use the PREVIOUS sample, which
   * is fine at an 8s stall threshold against a 4s tick.
   */
  private async pollInboundMedia(remote: RemotePeer, now: number): Promise<void> {
    let stats;
    try {
      stats = await remote.pc.getStats();
    } catch {
      return;
    }
    for (const report of stats.values()) {
      if (report.type !== "inbound-rtp" || report.kind !== "audio") continue;
      const bytes = report.bytesReceived as number;
      if (remote.lastBytesReceived === null || bytes > remote.lastBytesReceived) {
        remote.lastBytesReceivedAt = now;
      }
      remote.lastBytesReceived = bytes;
      return;
    }
  }

  leave(): void {
    if (this.onTransportConnect) {
      this.transport.off("connect", this.onTransportConnect);
      this.onTransportConnect = null;
    }

    if (this.onTransportDisconnect) {
      this.transport.off("disconnect", this.onTransportDisconnect);
      this.onTransportDisconnect = () => {};
    }

    for (const peerId of [...this.remotePeers.keys()]) {
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.dtln?.releaseTransport();
    this.dtln?.onFatal(null);
    this.callAudioMixer?.dispose();
    this.audioCtx?.close();

    this.audioCtx = null;
    this.outputBus = null;
    this.callAudioMixer = null;
    this.micStream = null;
    this.processedStream = null;
    this.inputSource = null;
    this.inputGain = null;
    this.active.clear();
    this.callPeers.clear();
    this.rosterSeen = false;
    this.lastRedialAsk.clear();
    this.lastRedialServed.clear();
    this.dialing.clear();
    this.nextDialAt.clear();
    this.dialBackoff.clear();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.node = null;
  }

  mute(): void {
    this.muted = true;
    this.applyMuteState();
  }

  unmute(): void {
    this.muted = false;
    this.applyMuteState();
  }

  isMuted(): boolean {
    return this.muted;
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.audioCtx) {
      this.activeInputDevice = deviceId;
      return;
    }

    await this.startMic(deviceId);

    this.activeInputDevice = deviceId;
    this.emit("deviceChanged", "input", deviceId);
  }

  async getInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  }

  getActiveInputDevice(): string | null {
    return this.activeInputDevice;
  }

  setInputGain(gain: number): void {
    const clamped = Math.max(0, Math.min(2.5, gain));
    this.currentInputGain = clamped;
    if (this.inputGain) {
      this.inputGain.gain.linearRampToValueAtTime(
        clamped,
        this.audioCtx!.currentTime + 0.05
      );
    }
    if (this.dtlnEnabled && this.dtln) {
      this.dtln.setInputGain(clamped);
    }
  }

  getInputGain(): number {
    return this.currentInputGain;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.activeOutputDevice = deviceId;
    // The <audio> elements are pinned to volume=0/muted=true - they exist
    // only to pump the receiver, not to play anything audible - so routing
    // THEM changes nothing the user hears. All audible output leaves
    // through outputBus -> audioCtx.destination; that is the sink that
    // actually has to move (finding 9).
    // [INFERENCE] AudioContext.setSinkId is Chromium-only; the feature test
    // keeps the previous (silent) behaviour on engines without it.
    if (this.audioCtx && "setSinkId" in this.audioCtx) {
      await (this.audioCtx as any).setSinkId(deviceId).catch(() => {});
    }
    for (const remote of this.remotePeers.values()) {
      if (!("setSinkId" in remote.audio)) continue;
      try {
        await (remote.audio as any).setSinkId(deviceId);
      } catch (err) {
        // A vanished or permission-denied device must not abort the loop
        // and skip deviceChanged for every peer after it (finding 9).
        console.warn(`[voice] setSinkId failed for ${remote.peerId}:`, err);
      }
    }
    this.emit("deviceChanged", "output", deviceId);
  }

  async getOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  }

  getActiveOutputDevice(): string | null {
    return this.activeOutputDevice;
  }

  setOutputVolume(volume: number): void {
    this.currentOutputVolume = Math.max(0, Math.min(2, volume));
    for (const peerId of this.remotePeers.keys()) this.applyPeerGain(peerId);
  }

  /** How loud one peer is for us alone; 1 is unchanged, 0 is muted. */
  setPeerVolume(peerId: string, volume: number): void {
    this.peerVolumes.set(peerId, Math.max(0, Math.min(MAX_PEER_VOLUME, volume)));
    this.applyPeerGain(peerId);
  }

  hasPeerVolume(peerId: string): boolean {
    return this.peerVolumes.has(peerId);
  }

  getPeerVolume(peerId: string): number {
    return this.peerVolumes.get(peerId) ?? 1;
  }

  private applyPeerGain(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote?.gainNode || !this.audioCtx) return;
    // Anchor before ramping: linearRampToValueAtTime with an empty
    // automation timeline has no start event and behaves inconsistently
    // (sometimes as a no-op) - the WebAudio footgun.
    const gain = remote.gainNode.gain;
    const now = this.audioCtx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(
      this.currentOutputVolume * this.getPeerVolume(peerId),
      now + 0.05
    );
  }

  getOutputVolume(): number {
    return this.currentOutputVolume;
  }

  playCallAudio(blob: Blob, options?: { volume?: number }): Promise<{ id: string; durationMs: number }> {
    if (!this.callAudioMixer) throw new Error("Not in a call");
    return this.callAudioMixer.play(blob, options);
  }

  stopCallAudio(id?: string): void {
    this.callAudioMixer?.stop(id);
  }

  async setDtlnEnabled(enabled: boolean): Promise<void> {
    if (this.dtlnEnabled === enabled) return;
    this.dtlnEnabled = enabled;
    if (this.audioCtx) {
      await this.startMic(this.activeInputDevice ?? undefined);
    }
  }

  isDtlnEnabled(): boolean {
    return this.dtlnEnabled;
  }

  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void {
    this.handlers.get(event)?.delete(handler);
  }

  activePeers(): string[] {
    return Array.from(this.active);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async startMic(deviceId?: string): Promise<void> {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.inputSource?.disconnect();
    this.inputGain?.disconnect();

    const useDtln = this.dtlnEnabled && this.dtln != null;

    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? {
            ...(useDtln ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN),
            deviceId: { exact: deviceId },
          }
        : useDtln
          ? AUDIO_CONSTRAINTS
          : AUDIO_CONSTRAINTS_NO_DTLN,
      video: false,
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // The remembered mic may be unplugged by the time it is restored, and
      // `deviceId: {exact}` makes that a hard failure - fall back to whatever
      // the system offers rather than leaving the user with no audio at all.
      if (!deviceId) throw err;
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: useDtln ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN,
        video: false,
      });
    }
    const track = this.micStream.getAudioTracks()[0];
    this.activeInputDevice = track.getSettings().deviceId ?? null;

    let processed: MediaStream | null = null;
    if (useDtln) {
      try {
        await this.dtln!.waitUntilReady();
        processed = await this.dtln!.processStream(
          this.micStream,
          this.currentInputGain
        );
      } catch (err) {
        // DTLN unavailable (load failure, unsupported browser, crashed
        // worklet): fall back to the plain path with the browser's own noise
        // suppression instead of joining the call with no mic at all.
        // Re-request the mic so the native processing constraints apply.
        console.error(
          "[voice] DTLN failed, falling back to browser noise suppression:",
          err
        );
        this.dtln?.releaseTransport();
        this.micStream.getTracks().forEach((t) => t.stop());
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: this.activeInputDevice
              ? {
                  ...AUDIO_CONSTRAINTS_NO_DTLN,
                  deviceId: { exact: this.activeInputDevice },
                }
              : AUDIO_CONSTRAINTS_NO_DTLN,
            video: false,
          });
        } catch {
          // The remembered mic may be gone - same fallback as above.
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: AUDIO_CONSTRAINTS_NO_DTLN,
            video: false,
          });
        }
      }
    }
    let microphoneProcessed: MediaStream;
    if (processed) {
      microphoneProcessed = processed;
    } else {
      // DTLN off: drop its graph so the worklet stops processing the (now
      // stopped) previous mic and peers are fed by the plain path only.
      this.dtln?.releaseTransport();
      const ctx = this.audioCtx!;
      this.inputSource = ctx.createMediaStreamSource(this.micStream);
      this.inputGain = ctx.createGain();
      this.inputGain.gain.value = this.currentInputGain;
      const dest = ctx.createMediaStreamDestination();
      this.inputSource.connect(this.inputGain);
      this.inputGain.connect(dest);
      microphoneProcessed = dest.stream;
    }

    this.callAudioMixer?.connectMicrophone(microphoneProcessed);
    this.processedStream =
      this.callAudioMixer?.outputStream() ?? microphoneProcessed;

    const newTrack = this.processedStream.getAudioTracks()[0] ?? null;
    if (newTrack) {
      for (const remote of this.remotePeers.values()) {
        try {
          const sender = remote.pc
            .getSenders()
            .find((s) => s.track?.kind === "audio");
          if (sender) {
            await sender.replaceTrack(newTrack);
          } else {
            remote.pc.addTrack(newTrack, this.processedStream);
          }
        } catch (err) {
          // A peer torn down mid-switch (reconcile tick, redial) rejects
          // here with InvalidStateError. One stopped transceiver must not
          // starve every peer after it in Map iteration order, nor skip
          // applyMuteState below (finding 2).
          console.warn(`[voice] track switch failed for ${remote.peerId}:`, err);
        }
      }
    }

    this.applyMuteState();
  }

  /**
   * The worklet crashed after init (finding 1): its context is suspended
   * and the destination node feeding every RTCRtpSender has no input, but
   * the track itself stays live so nothing else notices. Rebuilding the mic
   * re-inits DTLN and replaces the track on every peer - same path a manual
   * device switch takes.
   */
  private handleDtlnFatal(): void {
    if (!this.audioCtx) return;
    void this.startMic(this.activeInputDevice ?? undefined).catch((err) => {
      console.error("[voice] mic rebuild after DTLN crash failed:", err);
    });
  }

  private async dialAndOffer(peerId: string): Promise<void> {
    if (!this.node || this.transport.isRelay(peerId)) return;

    // The reconcile tick can fire again mid-dial; a second dial would race
    // two colliding offers at the same peer.
    if (this.dialing.has(peerId)) return;
    // Every path that dials comes through here - the reconcile tick, the
    // signalling stream's close handler, and a peer asking us to redial - so
    // the rate limit lives here rather than in each of them. Measured the hard
    // way: an RTCPeerConnection that fails immediately (no working ICE) tore
    // itself down, which triggered an instant redial, which failed again, at
    // ~20 dials a second on both sides at once.
    const now = Date.now();
    if (now < (this.nextDialAt.get(peerId) ?? 0)) return;
    const wait = Math.min(
      (this.dialBackoff.get(peerId) ?? 0) + VOICE_DIAL_STEP_MS,
      VOICE_DIAL_MAX_MS
    );
    this.dialBackoff.set(peerId, wait);
    this.nextDialAt.set(peerId, now + wait);
    this.dialing.add(peerId);
    try {
      await this.dialAndOfferInner(peerId);
    } finally {
      this.dialing.delete(peerId);
    }
  }

  private async dialAndOfferInner(peerId: string): Promise<void> {
    if (!this.node) return;
    const remote = this.ensureRemotePeer(peerId);

    // Offer/answer already exchanged (they offered first) - nothing to start.
    if (remote.pc.remoteDescription) return;

    let sdp: string | undefined;
    if (remote.pc.signalingState === "have-local-offer") {
      // We already offered and the answer never came; re-sending the offer we
      // still hold costs one frame and usually settles it immediately.
      sdp = remote.pc.localDescription?.sdp;
    } else {
      const offer = await remote.pc.createOffer();
      await remote.pc.setLocalDescription(offer);
      sdp = offer.sdp;
    }
    if (!sdp) return;

    this.debugStats.offersSent++;
    const ok = await this.sendSignal(peerId, { type: "offer", sdp });
    if (!ok) {
      // send() resolving false means the app stream to this peer is provably
      // down right now. Tear the link down so the reconcile tick rebuilds it
      // (under the dial backoff) once the transport has healed, instead of
      // letting a pc that offered into the void sit out the 30s deadline.
      this.emit("status", {
        type: "voice-dial-failed",
        peerId,
        message: `Could not reach ${peerId.slice(-8)} for voice - retrying`,
      });
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }
  }

  /**
   * Ship one signal over the app transport's confirmed streams. Resolves
   * false only when the transport gave up on delivering it - see
   * handleWireSignal for why this replaced the dedicated /voice/ stream.
   */
  private sendSignal(peerId: string, signal: VoiceSignal): Promise<boolean> {
    return this.transport
      .send(peerId, encode({ type: MessageType.VoiceSignal, signal }))
      .catch(() => false);
  }

  private ensureRemotePeer(peerId: string): RemotePeer {
    if (this.remotePeers.has(peerId)) return this.remotePeers.get(peerId)!;

    // See the note in file/webtorrent.ts: iceCandidatePoolSize pre-gathers a
    // full candidate set per pool, which is a TURN allocation per pool per
    // server, and pays for itself only when the connection is built well
    // before the offer. Here the offer follows immediately.
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
    });

    if (this.processedStream) {
      for (const track of this.processedStream.getAudioTracks()) {
        pc.addTrack(track, this.processedStream);
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        void this.sendSignal(peerId, {
          type: "ice",
          candidate: candidate.toJSON(),
        });
      }
    };

    pc.ontrack = ({ track, streams }) => {
      if (track.kind !== "audio") return;
      const stream = streams[0] ?? new MediaStream([track]);
      this.setupRemoteAudio(peerId, stream, track);
    };

    // A track added to an already-established connection needs a new
    // offer/answer, and there was none: join with the mic denied (listen-only)
    // and grant it later and your audio never reached anybody, with the link
    // still "connected" so the wedge check never rebuilt it - leave and rejoin
    // was the only cure, which is the very symptom this file exists to remove.
    // Guarded so it cannot interfere with the initial negotiation: only once a
    // remote description exists and we are back in "stable".
    pc.onnegotiationneeded = () => {
      if (pc.signalingState !== "stable" || !pc.remoteDescription) return;
      void (async () => {
        try {
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          this.debugStats.offersSent++;
          void this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
        } catch (err) {
          console.warn(`[LibP2PVoice] renegotiation failed for ${peerId}:`, err);
        }
      })();
    };

    // ICE reaching "checking" is real progress on a slow path; without this
    // the wedge check counts from before the dial even started.
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "checking" || st === "connected" || st === "completed") {
        this.touchLink(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        // check if relayed via TURN
        pc.getStats()
          .then((stats) => {
            for (const report of stats.values()) {
              if (
                report.type === "candidate-pair" &&
                report.state === "succeeded"
              ) {
                const isRelay =
                  report.localCandidateType === "relay" ||
                  report.remoteCandidateType === "relay";
                this.emit("status", {
                  type: "voice-ice-connected",
                  // Full id: consumers match tiles against it; the human-
                  // readable part is the message.
                  peerId,
                  relayed: isRelay,
                  message: isRelay
                    ? "Voice connected via relay (TURN)"
                    : "Voice connected directly (P2P)",
                });
              }
            }
          })
          .catch(() => {});
      } else if (state === "failed") {
        this.emit("status", {
          type: "voice-connection-failed",
          peerId,
          message: `Voice connection failed for ${peerId.slice(-8)}`,
        });
        this.debugStats.tdPcFailed++;
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      } else if (state === "disconnected") {
        this.emit("status", {
          type: "voice-degraded",
          peerId,
          message: `Voice signal lost from ${peerId.slice(-8)} - reconnecting...`,
        });
        // attempt ICE restart; signalling rides the app transport, which
        // queues and confirms delivery itself
        if (remote.pc.signalingState === "stable") {
          remote.pc.restartIce();
          remote.pc
            .createOffer({ iceRestart: true })
            .then((offer) =>
              remote.pc.setLocalDescription(offer).then(() =>
                this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! })
              )
            )
            .then((sent) => {
              // A restart offer lost to a transport hiccup is otherwise
              // unrecoverable until the 5s blip ask - unlike the initial
              // offer and the answer, this send's result used to be
              // discarded via `void` (finding 10).
              if (!sent) this.askForRedial(peerId, Date.now());
            })
            .catch((err) => {
              console.warn(
                `[LibP2PVoice] ICE restart failed for ${peerId}:`,
                err
              );
              this.emit("status", {
                type: "voice-connection-failed",
                peerId,
                message: `Voice ICE restart failed for ${peerId.slice(-8)}`,
              });
            });
        }
      }
    };

    const audio = new Audio();
    audio.autoplay = true;
    if (this.activeOutputDevice && "setSinkId" in audio) {
      (audio as any).setSinkId(this.activeOutputDevice).catch(() => {});
    }

    const remote: RemotePeer = {
      peerId,
      pc,
      stream: null,
      audio,
      sourceNode: null,
      gainNode: null,
      pendingCandidates: [],
      createdAt: Date.now(),
      everConnected: false,
      okAt: Date.now(),
      lastBytesReceived: null,
      lastBytesReceivedAt: Date.now(),
    };
    this.remotePeers.set(peerId, remote);
    return remote;
  }

  private setupRemoteAudio(
    peerId: string,
    stream: MediaStream,
    track: MediaStreamTrack
  ): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote || !this.audioCtx) return;

    remote.sourceNode?.disconnect();
    remote.gainNode?.disconnect();

    const sourceNode = this.audioCtx.createMediaStreamSource(stream);
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = this.currentOutputVolume * this.getPeerVolume(peerId);

    sourceNode.connect(gainNode);
    gainNode.connect(this.outputBus ?? this.audioCtx.destination);

    remote.audio.srcObject = stream;
    remote.audio.volume = 0;
    remote.audio.muted = true;
    // autoplay=true above only takes effect on the initial srcObject
    // assignment - if this element is ever paused (finding 11), nothing
    // resumes it and that ONE peer goes silent permanently while
    // connectionState still reads connected. play() is idempotent on an
    // already-playing element, so calling it here costs nothing on the
    // common path and repairs the rare one.
    remote.audio.play().catch(() => {});

    remote.stream = stream;
    remote.sourceNode = sourceNode;
    remote.gainNode = gainNode;

    this.active.add(peerId);
    this.emit("trackAdded", peerId, track);
  }

  private teardownRemotePeer(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;
    this.debugStats.teardowns++;

    remote.sourceNode?.disconnect();
    remote.gainNode?.disconnect();
    remote.audio.srcObject = null;
    remote.stream?.getTracks().forEach((t) => t.stop());
    remote.pc.close();

    this.remotePeers.delete(peerId);
    this.active.delete(peerId);

    this.emit("trackRemoved", peerId);

    // The single choke point every teardown path passes through (finding
    // 8): without this, six of seven teardown paths told the UI nothing,
    // and a torn-down peer rendered as present and connected forever.
    this.emit("status", {
      type: "voice-peer-left",
      peerId,
      message: `Voice link with ${peerId.slice(-8)} closed`,
    });
  }

  private async handleSignal(
    peerId: string,
    signal: VoiceSignal
  ): Promise<void> {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;

    switch (signal.type) {
      case "offer": {
        this.debugStats.offersIn++;
        const state = remote.pc.signalingState;

        if (state === "have-local-offer") {
          // glare: higher peerId yields
          if (this.transport.selfId() > peerId) {
            await remote.pc.setLocalDescription({ type: "rollback" });
          } else {
            return;
          }
        } else if (state !== "stable") {
          // unexpected state - the offer is unrecoverable at this
          // signalling layer, and connectionState still reads "connected"
          // so linkIsHealthy never notices (finding 4). Ask for a fresh
          // dial instead of dropping it forever.
          console.warn(
            `[Voice] unexpected signaling state ${state} on offer from ${peerId}`
          );
          this.askForRedial(peerId, Date.now());
          return;
        }

        await remote.pc.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        });
        this.touchLink(peerId);
        await this.drainCandidates(remote); // drain buffered ICE
        const answer = await remote.pc.createAnswer();
        await remote.pc.setLocalDescription(answer);
        const sent = await this.sendSignal(peerId, {
          type: "answer",
          sdp: answer.sdp!,
        });
        if (!sent) {
          // The dialer is left holding an unanswered offer and would only
          // notice at its setup deadline. Tear our half down and ask for a
          // fresh dial (rate-limited) instead of letting both ends wait.
          this.teardownRemotePeer(peerId);
          this.emit("peerLeft", peerId);
          this.askForRedial(peerId, Date.now());
        }
        break;
      }

      case "answer": {
        this.debugStats.answersIn++;
        await remote.pc.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        });
        this.touchLink(peerId);
        await this.drainCandidates(remote); // drain buffered ICE
        break;
      }
      case "ice": {
        if (!remote.pc.remoteDescription) {
          // Bounded: a peer that never completes the handshake would
          // otherwise buffer every trickled candidate for the life of the
          // call. Early candidates (host/srflx) are the ones worth keeping,
          // so once full, drop the newest rather than evict what already
          // arrived.
          if (remote.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
            remote.pendingCandidates.push(signal.candidate);
          }
          return;
        }
        await remote.pc.addIceCandidate(signal.candidate).catch(() => {});
        break;
      }
    }
  }

  private async drainCandidates(remote: RemotePeer): Promise<void> {
    for (const c of remote.pendingCandidates.splice(0)) {
      await remote.pc.addIceCandidate(c).catch(() => {});
    }
  }

  private applyMuteState(): void {
    if (!this.micStream) return;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = !this.muted;
    }
  }

  private emit<K extends keyof VoiceEvents>(
    event: K,
    ...args: Parameters<VoiceEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
