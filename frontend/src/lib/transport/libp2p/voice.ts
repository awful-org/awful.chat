import type { Libp2p } from "libp2p";
import type { Connection, Stream } from "@libp2p/interface";
import type { StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";
import type { VoiceTransport, VoiceEvents } from "../types";
import type { AppServices, LibP2PTransport } from "./transport";
import type { DtlnProcessor } from "$lib/audio/dtln-processor";
import { getIceServers } from "../ice-server-list";
import { MessageType } from "$lib/types/message";
import { encode } from "$lib/utils";

const VOICE_PROTO = "/voice/1.0.0";
/** Same ceiling as the output slider in audio settings. */
export const MAX_PEER_VOLUME = 2.5;
const MAX_FRAME_BYTES = 256 * 1024; // 256 KB max frame size; signaling payloads are tiny
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
/** Ceiling on signals buffered while a peer has no signalling stream. */
const MAX_QUEUED_SIGNALS = 64;
/** Rate limit on asking the other side to dial us. */
const VOICE_REDIAL_ASK_MS = 5_000;

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const AUDIO_CONSTRAINTS_NO_DTLN: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

type VoiceSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

interface RemotePeer {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  audio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  peerId: string;
  sigStream: Stream | null;
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
}

export class LibP2PVoice implements VoiceTransport {
  private node: Libp2p<AppServices> | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;
  /**
   * The node the voice handler is currently registered on. Tracked per node,
   * not as a boolean: a reconnect builds a fresh node, and a stale "already
   * registered" flag would leave the new one with no handler at all.
   */
  private handlerNode: Libp2p<AppServices> | null = null;

  private activeInputDevice: string | null = null;
  private activeOutputDevice: string | null = null;
  private currentInputGain = 1.0;
  private currentOutputVolume = 1.0;
  private muted = false;

  private remotePeers = new Map<string, RemotePeer>();
  /**
   * Per-peer listening volume, multiplied with the master output volume.
   * Kept outside RemotePeer so the setting survives that peer dropping and
   * rejoining. Deliberately NOT cleared by leave(): it lasts the session, and
   * the durable copy lives in audio-prefs keyed by DID.
   */
  private peerVolumes = new Map<string, number>();
  private active = new Set<string>();
  private signalQueues = new Map<string, VoiceSignal[]>();
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
   * Dev counters. Voice failures are invisible without them: a signalling
   * stream opened on a superseded connection reports itself open, so both
   * sides look fine while no offer ever crosses.
   */
  readonly debugStats = {
    dialsStarted: 0,
    openedOnProven: 0,
    openedByDialProtocol: 0,
    dialsFailed: 0,
    inboundStreams: 0,
    offersSent: 0,
    offersIn: 0,
    answersIn: 0,
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

    try {
      await this.startMic(this.activeInputDevice ?? undefined);
    } catch {
      // listen-only mode
    }

    if (this.handlerNode !== this.node) {
      // force: registering the same protocol twice throws "Handler already
      // registered", which used to abort the whole join. Replacing is always
      // the right outcome here - the handler only closes over `this` - so a
      // re-entrant join heals instead of failing.
      await this.node.handle(
        VOICE_PROTO,
        (stream: Stream, connection: Connection) => {
          const peerId = connection.remotePeer.toString();
          // ensureRemotePeer attaches the live microphone track to the new
          // RTCPeerConnection, so accepting a stream from anyone who can reach
          // us over the relay handed our mic to a peer who is not in the call.
          // The roster makes the check a one-liner; identity is the libp2p
          // peerId the stream arrived on, never anything on the wire.
          if (this.rosterSeen && !this.callPeers.has(peerId)) {
            stream.abort(new Error("not in this call"));
            return;
          }
          this.debugStats.inboundStreams++;
          const remote = this.ensureRemotePeer(peerId);
          this.attachStream(peerId, remote, stream);
        },
        { force: true }
      );
      this.handlerNode = this.node;
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
        if (!this.remotePeers.has(peerId)) this.askForRedial(peerId, now);
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
    // An ESTABLISHED link that has merely blipped keeps the old rule: their
    // ask must beat our stale "connected", not a live link mid-recovery.
    if (
      remote &&
      remote.everConnected &&
      remote.pc.connectionState !== "connected" &&
      this.linkIsHealthy(remote, now)
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
    // Deliberately NOT clearing the backoff: the ask repeats every few
    // seconds, so it lands as soon as the gate opens, and a peer cannot make
    // us dial in a loop.
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
      remote.okAt = now;
      // A working link is the only proof worth resetting the backoff on:
      // opening a signalling stream says nothing about whether media flows.
      this.nextDialAt.delete(remote.peerId);
      this.dialBackoff.delete(remote.peerId);
      return true;
    }
    // A link that has never worked does not get the benefit of "progress":
    // ICE flapping back into "checking" refreshes okAt forever on a pair
    // that is simply broken, and that starvation held a wedged link - and
    // with it the whole repair path - until a manual leave and rejoin.
    if (!remote.everConnected && now - remote.createdAt > VOICE_SETUP_DEADLINE_MS) {
      return false;
    }
    // "new" / "connecting" / "disconnected": legitimate for a moment, a wedge
    // once it outlasts a handshake and an ICE restart.
    return now - remote.okAt < VOICE_LINK_GRACE_MS;
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
    if (this.handlerNode) {
      // Unregister on the node it was registered on, which is not necessarily
      // the current one after a reconnect.
      this.handlerNode.unhandle(VOICE_PROTO).catch(() => {});
      this.handlerNode = null;
    }

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.dtln?.releaseTransport();
    this.audioCtx?.close();

    this.audioCtx = null;
    this.micStream = null;
    this.processedStream = null;
    this.inputSource = null;
    this.inputGain = null;
    this.active.clear();
    this.signalQueues.clear();
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

    const newTrack = this.processedStream?.getAudioTracks()[0] ?? null;
    if (!newTrack) return;
    for (const remote of this.remotePeers.values()) {
      const sender = remote.pc
        .getSenders()
        .find((s) => s.track?.kind === "audio");
      if (sender) await sender.replaceTrack(newTrack);
    }

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
    for (const remote of this.remotePeers.values()) {
      if ("setSinkId" in remote.audio) {
        await (remote.audio as any).setSinkId(deviceId);
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
    if (processed) {
      this.processedStream = processed;
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
      this.processedStream = dest.stream;
    }

    const newTrack = this.processedStream.getAudioTracks()[0] ?? null;
    if (newTrack) {
      for (const remote of this.remotePeers.values()) {
        const sender = remote.pc
          .getSenders()
          .find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          remote.pc.addTrack(newTrack, this.processedStream);
        }
      }
    }

    this.applyMuteState();
  }

  private async dialAndOffer(peerId: string): Promise<void> {
    if (!this.node || this.transport.isRelay(peerId)) return;

    // if the other side already dialed us, we're done
    if (this.remotePeers.get(peerId)?.sigStream) return;
    // The reconcile tick can fire again mid-dial; a second dial would attach
    // a second signaling stream to the same peer.
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

    let stream: Stream | null = null;
    this.debugStats.dialsStarted++;
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        // Prefer the connection the peer has actually reached us on. Measured:
        // a dialer routinely holds three connections to one peer (two relay
        // circuits plus a webrtc one) and dialProtocol picks arbitrarily, so
        // the offer rode a superseded circuit, opened "successfully", and was
        // never seen by the other side - a call where one person simply cannot
        // hear the other, with nothing logged anywhere.
        const proven = this.transport.provenConnection(peerId);
        if (proven) {
          stream = await proven.newStream(VOICE_PROTO, {
            runOnLimitedConnection: true,
          });
          this.debugStats.openedOnProven++;
          break;
        }
        const pid = this.node.getPeers().find((p) => p.toString() === peerId);
        if (!pid) throw new Error("peer not in peerstore");
        stream = await this.node.dialProtocol(pid, VOICE_PROTO);
        this.debugStats.openedByDialProtocol++;
        break;
      } catch (err) {
        if (attempt === 5) {
          this.debugStats.dialsFailed++;
          console.warn(`[LibP2PVoice] dial ${peerId} failed:`, err);
          this.emit("status", {
            type: "voice-dial-failed",
            peerId: peerId.slice(-8),
            message:
              err instanceof Error
                ? err.message
                : "Failed to open voice stream",
          });
          return;
        }
        this.emit("status", {
          type: "voice-dial-retrying",
          peerId: peerId.slice(-8),
          attempt: attempt + 1,
          message: `Retrying voice connection (${attempt + 1}/5)...`,
        });
        // ~5s across all five waits, not 9s, and front-loaded: what this
        // loop is usually waiting out is a connection that is not proven yet
        // or a peer not in the peerstore yet, and both settle in well under a
        // second. The whole time is spent holding `dialing`, which blocks the
        // reconcile tick from tearing the link down or redialing it.
        await new Promise((r) =>
          setTimeout(r, Math.min(300 * 2 ** attempt, 1_500))
        );
      }
    }

    if (!stream) return;

    this.attachStream(peerId, remote, stream);

    if (remote.pc.remoteDescription) {
      // Signaling channel re-established but offer/answer already exchanged; skip redundant steps
      return;
    }

    if (remote.pc.signalingState === "have-local-offer") {
      // We already offered and the answer never came - almost certainly on the
      // stream that just died. Returning here left the link to sit until the
      // wedge timer rebuilt it from scratch; re-sending the offer we still
      // hold costs one frame and usually settles it immediately.
      const pending = remote.pc.localDescription;
      if (pending?.sdp) {
        this.debugStats.offersSent++;
        this.sendSignal(peerId, { type: "offer", sdp: pending.sdp });
      }
      return;
    }

    const offer = await remote.pc.createOffer();
    await remote.pc.setLocalDescription(offer);
    this.debugStats.offersSent++;
    this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
  }

  private attachStream(
    peerId: string,
    remote: RemotePeer,
    stream: Stream
  ): void {
    remote.sigStream = stream;
    remote.okAt = Date.now();

    // One buffer per STREAM, not per peer: a peer can briefly have two (a
    // redial racing the inbound dial), and sharing a buffer interleaves their
    // frames into garbage lengths.
    let readBuf = new Uint8Array(0);

    stream.addEventListener("message", (evt: StreamMessageEvent) => {
      const chunk: Uint8Array =
        evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();

      const merged = new Uint8Array(readBuf.byteLength + chunk.byteLength);
      merged.set(readBuf);
      merged.set(chunk, readBuf.byteLength);
      readBuf = merged;

      while (readBuf.byteLength >= 4) {
        const len = new DataView(
          readBuf.buffer,
          readBuf.byteOffset
        ).getUint32(0, false);
        // Guard against unbounded buffer growth from malicious peers
        if (len > MAX_FRAME_BYTES) {
          stream.abort(new Error("frame size exceeds maximum"));
          return;
        }
        if (readBuf.byteLength < 4 + len) break;
        const payload = readBuf.slice(4, 4 + len);
        readBuf = readBuf.slice(4 + len);
        try {
          const signal = JSON.parse(
            new TextDecoder().decode(payload)
          ) as VoiceSignal;
          this.handleSignal(peerId, signal).catch(() => {});
        } catch {}
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      if (remote.sigStream !== stream) return;
      remote.sigStream = null;

      const state = remote.pc.connectionState;
      if (state === "closed" || state === "failed" || !this.node) return;
      // Same one-dialer-per-pair rule the reconcile follows. Dialing from both
      // sides here attaches two signalling streams to one peer, and only the
      // last is ever aborted - the other leaks against the far side's inbound
      // stream limit.
      if (peerId > this.transport.selfId()) {
        this.askForRedial(peerId, Date.now());
        return;
      }
      this.dialAndOffer(peerId).catch(() => {});
    });

    const queued = this.signalQueues.get(peerId) ?? [];
    this.signalQueues.delete(peerId);
    for (const sig of queued) this.sendSignal(peerId, sig);
  }

  private sendSignal(peerId: string, signal: VoiceSignal): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote?.sigStream) {
      if (!this.signalQueues.has(peerId)) this.signalQueues.set(peerId, []);
      const queue = this.signalQueues.get(peerId)!;
      // Bounded: every ICE candidate generated while the stream is down queues
      // here, and a link that never comes up would otherwise grow it for the
      // whole call. The oldest candidates are also the least useful.
      if (queue.length >= MAX_QUEUED_SIGNALS) queue.shift();
      queue.push(signal);
      return;
    }

    const payload = new TextEncoder().encode(JSON.stringify(signal));
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);

    try {
      const ok = remote.sigStream.send(frame);
      if (!ok) {
        remote.sigStream.onDrain().catch(() => {
          remote.sigStream?.abort(new Error("drain failed"));
          remote.sigStream = null;
        });
      }
    } catch (err) {
      console.warn(`[LibP2PVoice] signal send failed for ${peerId}:`, err);
      remote.sigStream = null;
    }
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
        this.sendSignal(peerId, { type: "ice", candidate: candidate.toJSON() });
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
          this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
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
          peerId: peerId.slice(-8),
          message: `Voice connection failed for ${peerId.slice(-8)}`,
        });
        this.debugStats.tdPcFailed++;
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      } else if (state === "disconnected") {
        this.emit("status", {
          type: "voice-degraded",
          peerId: peerId.slice(-8),
          message: `Voice signal lost from ${peerId.slice(-8)} - reconnecting...`,
        });
        // attempt ICE restart if signaling stream is still alive
        if (remote.sigStream && remote.pc.signalingState === "stable") {
          remote.pc.restartIce();
          remote.pc
            .createOffer({ iceRestart: true })
            .then((offer) => {
              return remote.pc.setLocalDescription(offer).then(() => {
                this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
              });
            })
            .catch((err) => {
              console.warn(
                `[LibP2PVoice] ICE restart failed for ${peerId}:`,
                err
              );
              this.emit("status", {
                type: "voice-connection-failed",
                peerId: peerId.slice(-8),
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
      sigStream: null,
      pendingCandidates: [],
      createdAt: Date.now(),
      everConnected: false,
      okAt: Date.now(),
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
    gainNode.connect(this.audioCtx.destination);

    remote.audio.srcObject = stream;
    remote.audio.volume = 0;
    remote.audio.muted = true;

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
    // Order matters. abort() dispatches a "close" event (StreamAbortEvent
    // extends StreamCloseEvent) synchronously, and the listener re-dials any
    // peer whose pc is not yet closed - so aborting first made every teardown
    // immediately dial the peer it was tearing down, leaving an orphaned
    // stream attached to a RemotePeer that had already been deleted. Detach
    // and close first, so the listener's identity guard short-circuits.
    const sig = remote.sigStream;
    remote.sigStream = null;
    remote.pc.close();
    sig?.abort(new Error("teardown"));

    this.remotePeers.delete(peerId);
    this.active.delete(peerId);
    this.signalQueues.delete(peerId);

    this.emit("trackRemoved", peerId);
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
          // unexpected state - log and bail
          console.warn(
            `[Voice] unexpected signaling state ${state} on offer from ${peerId}`
          );
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
        this.sendSignal(peerId, { type: "answer", sdp: answer.sdp! });
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
          remote.pendingCandidates.push(signal.candidate);
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
