// Types only - the runtime library loads when a video call actually starts,
// keeping a large SFU client out of the boot bundle for sessions that never
// turn a camera on.
import type * as mediasoupClient from "mediasoup-client";
import type { VideoTransport, VideoEvents, VideoSource } from "./types";
import { sfuForRoom, sfuPool } from "./sfu-pool";
import { shouldBlockSfu } from "./faults";
import { getIceServers } from "./ice-server-list";
import { errText, ev } from "$lib/telemetry/event";
import { rec } from "$lib/telemetry/recorder";
import { recVideoEvent } from "$lib/telemetry/taps";
import type { SfuSnapshot } from "$lib/telemetry/schema";

/**
 * Reaches the user verbatim - transmission.svelte assigns an error event's
 * message straight to transportState.error - so it says what it means to
 * somebody in a call rather than naming a component they have never heard of.
 */
import { SFU_PUBLISH_UNAVAILABLE, SFU_UNREACHABLE } from "./types";

/** What a click on a tile for a share that no longer exists surfaces. */
export const PRODUCER_GONE = "That stream has ended";

/** Producer announcements held waiting for a device or a roster entry. */
const MAX_QUEUED_PRODUCERS = 64;

/**
 * How long a remote camera may go unshown before its stream is closed (see
 * setWantedCameras). Long enough that a glance at a share and back, or a
 * scroll past a thumbnail, costs nothing; short next to how long people
 * watch a share or another room.
 */
export const CAMERA_PARK_GRACE_MS = 5_000;

// ── Message types (mirrored on the SFU server) ────────────────────────────────

interface MSGetCapabilities {
  type: "ms:get-capabilities";
  requestId: string;
}
interface MSCapabilities {
  type: "ms:capabilities";
  requestId: string;
  rtpCapabilities: mediasoupClient.types.RtpCapabilities;
  // How many OTHER peers the SFU already holds in this room. A pair placed
  // on different SFU nodes (finding 13 - a stale cached bundle computing a
  // different pool) each see 0 here while the room is not actually empty;
  // an interim guard until the pool is served at runtime instead of built
  // into the bundle.
  roomPeerCount: number;
}
interface MSCreateTransport {
  type: "ms:create-transport";
  requestId: string;
  direction: "send" | "recv";
}
interface MSRestartIce {
  type: "ms:restart-ice";
  requestId: string;
  direction: "send" | "recv";
} // client -> server
interface MSIceRestarted {
  type: "ms:ice-restarted";
  requestId: string;
  direction: "send" | "recv";
  iceParameters: mediasoupClient.types.IceParameters;
} // server -> client
interface MSTransportOptions {
  type: "ms:transport-options";
  requestId: string;
  direction: "send" | "recv";
  options: mediasoupClient.types.TransportOptions;
}
interface MSConnectTransport {
  type: "ms:connect-transport";
  direction: "send" | "recv";
  dtlsParameters: mediasoupClient.types.DtlsParameters;
}
interface MSProduce {
  type: "ms:produce";
  requestId: string;
  kind: mediasoupClient.types.MediaKind;
  rtpParameters: mediasoupClient.types.RtpParameters;
  source: VideoSource;
}
interface MSProduced {
  type: "ms:produced";
  requestId: string;
  producerId: string;
}
interface MSConsume {
  type: "ms:consume";
  requestId: string;
  producerId: string;
  rtpCapabilities: mediasoupClient.types.RtpCapabilities;
}
interface MSConsumerOptions {
  type: "ms:consumer-options";
  requestId: string;
  options: mediasoupClient.types.ConsumerOptions;
  peerId: string;
  source: VideoSource;
}
/**
 * The scoped "no" to one ms:consume: the producer closed between the
 * announcement and the consume. It answers the request by id, so only that
 * consume fails - unlike ms:error, which failSession() treats as a refusal
 * of the whole session. Before this the server stayed silent and the click
 * hung out the full 10s request timeout on a share that no longer existed.
 */
interface MSConsumeFailed {
  type: "ms:consume-failed";
  requestId: string;
  producerId: string;
}
interface MSNewProducer {
  type: "ms:new-producer";
  peerId: string;
  producerId: string;
  source: VideoSource;
}
interface MSPeerLeft {
  type: "ms:peer-left";
  peerId: string;
}
/**
 * The SFU's answer to a join that carried our resume token: the session we
 * had is ours again, on this socket, and this is the room as it is now -
 * whatever it sent while we were away was lost with the old socket.
 */
interface AuthResumed {
  type: "auth:resumed";
  resumeToken: string;
  /** Everyone else in the room. */
  peers: string[];
  /** Everyone else's producers. */
  producers: { peerId: string; producerId: string; source: VideoSource; kind: "audio" | "video" }[];
  /** Our own producers, as the SFU holds them. */
  own: string[];
  /** The producers our session consumes, as the SFU holds them. */
  consuming?: string[];
}
interface MSProducerClosed {
  type: "ms:producer-closed";
  /** Publisher session replacement: keep the viewer's watch intent. */
  replacing?: boolean;
  peerId: string;
  producerId: string;
  source: VideoSource;
  // Which track this producer carried. Without it, closing a screen share's
  // AUDIO producer looked identical to closing its VIDEO producer, and the
  // handler tore down the whole watch - and nulled a live video track -
  // over a peer merely switching to a window with no audio (finding 4).
  kind: "audio" | "video";
}
interface MSProducerConsumed {
  type: "ms:producer-consumed";
  peerId: string;
  producerId: string;
}
interface MSProducerConsumerClosed {
  type: "ms:producer-consumer-closed";
  peerId: string;
  producerId: string;
}
interface MSCloseConsumer {
  type: "ms:close-consumer";
  producerId: string;
}
interface MSCloseProducer {
  type: "ms:close-producer";
  producerId: string;
}
/** Ask the server to resume a consumer created paused (see MSConsumerOptions /
 *  finding 3). Sent once, right after recvTransport.consume() resolves. */
interface MSResumeConsumer {
  type: "ms:resume-consumer";
  producerId: string;
}
/**
 * How the SFU refuses a session: it sends this and closes the socket. Without
 * a variant here the frame fell through handleSignal's switch and the refusal
 * was silent - a call that never started, with nothing on screen saying why.
 * `reason` is typed loosely on purpose so an SFU that grows a new one still
 * lands on the generic message rather than on nothing at all.
 *
 * `direction` is set only for "transport-timeout": that reason means ONE
 * transport died server-side (a connect timeout, or a mid-call ICE/DTLS
 * failure), not the session - the socket stays open and the SFU does not
 * close it. Every other reason is a real session refusal and the socket
 * closes right behind it.
 */
interface MSError {
  type: "ms:error";
  reason: string;
  direction?: "send" | "recv";
}

/**
 * `ms:diag` request/reply pair for a live SFU snapshot. Mirrored in
 * `sfu/index.ts` and `frontend/src/lib/telemetry/schema.ts` - change all
 * three together.
 */
interface MSDiag {
  type: "ms:diag";
  requestId: string;
} // client -> server
interface MSDiagReply {
  type: "ms:diag";
  requestId: string;
  snapshot: SfuSnapshot;
} // server -> client
/**
 * The SFU refuses a diag request with THIS frame, never with `ms:error`.
 * An `ms:error` with no `direction` latches `this.refusal` and ends the
 * whole session (see `failSession`). A refused session is the one most
 * worth inspecting, so a diag refusal must not also kill the session.
 */
interface MSDiagUnavailable {
  type: "ms:diag-unavailable";
  requestId: string;
  reason: "disabled" | "rate-limited";
}

type MSMessage =
  | MSGetCapabilities
  | MSCapabilities
  | MSCreateTransport
  | MSTransportOptions
  | MSRestartIce
  | MSIceRestarted
  | MSConnectTransport
  | MSProduce
  | MSProduced
  | MSConsume
  | MSConsumerOptions
  | MSConsumeFailed
  | MSNewProducer
  | MSPeerLeft
  | MSProducerClosed
  | MSProducerConsumed
  | MSProducerConsumerClosed
  | MSCloseConsumer
  | MSCloseProducer
  | MSResumeConsumer
  | MSError
  | MSDiag
  | MSDiagReply
  | MSDiagUnavailable;

/**
 * Turns an SFU refusal into a sentence for the person in the call. It reaches
 * them verbatim, the same way SFU_UNREACHABLE does, so it names what happened
 * and what still works rather than the wire reason. Every one of these is
 * retried by the rejoin ladder, which is why the banners promise that.
 */
function sfuRefusalMessage(reason: unknown): string {
  switch (reason) {
    case "server-full":
      return "Video server is full - voice still works, retrying in the background";
    case "room-full":
      return "Too many people in this call for video - voice still works";
    case "peer-id-in-use":
      return "Another session is already in this call as you - video stays off here until that one ends";
    case "invalid-join":
      return "Video server rejected this room - voice still works";
    default:
      return "Video server refused the connection - voice still works, retrying in the background";
  }
}

interface Producer {
  producer: mediasoupClient.types.Producer;
  source: VideoSource;
  stream: MediaStream;
  /** Kept so a rebuild republishes with the same caps. */
  encoding?: RTCRtpEncodingParameters;
}

interface Consumer {
  consumer: mediasoupClient.types.Consumer;
  source: VideoSource;
}

/** Transport states that will never carry another byte. A transport can die
 *  in any of these while the socket stays open (finding 2) - sessionIsLive()
 *  used to only ask the socket and the device, so a dead transport under a
 *  healthy socket read as "live" and every repair path that gated on it
 *  became a no-op. */
const DEAD_TRANSPORT_STATES: Record<string, true> = {
  failed: true,
  disconnected: true,
  closed: true,
};

/** Same members, or both null (no opinion). */
function sameSet(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Mediasoup SFU video implementation.
 * Handles camera and screen share via server-side fan-out.
 * Audio is NOT handled here - stays p2p via SimplePeerVoice.
 *
 * Signaling flows over a dedicated WebSocket connection to the SFU server.
 * The SFU URL is resolved from the room code using sfuForRoom(), which hashes
 * the code against VITE_SFU_URLS (or VITE_SFU_URL) so all participants pick
 * the same server deterministically. Defaults to /sfu on the same host if
 * neither is configured.
 */
export class MediasoupVideo implements VideoTransport {
  private device: mediasoupClient.types.Device | null = null;
  private sendTransport: mediasoupClient.types.Transport | null = null;
  private recvTransport: mediasoupClient.types.Transport | null = null;
  private producers: Map<VideoSource, Producer[]> = new Map();
  private consumers: Map<string, Consumer[]> = new Map(); // peerId → consumers
  private active: Set<string> = new Set();
  private handlers: Map<keyof VideoEvents, Set<Function>> = new Map();
  // Keyed by requestId, not by response type: the old per-type FIFO queue
  // handed a late reply to whichever request had since taken its place in
  // the queue once the original timed out (finding 9), and serialized every
  // request of one type behind whichever one was ahead of it even when
  // nothing connects them (finding 10) - a joiner replayed 8 producers paid
  // 10s of dead air per dead producer ahead of it in line, and could push
  // the recv transport past the server's own connect-timeout reap.
  private pendingById: Map<
    string,
    {
      resolve: (msg: MSMessage) => void;
      reject: (err: Error) => void;
      /** The socket the request went out on: only that socket can answer it. */
      ws: WebSocket | null;
    }
  > = new Map();
  private requestSeq = 0;
  // Set when the SFU refuses this session with an ms:error frame, cleared when
  // a new socket is opened. The refusal is immediately followed by the socket
  // closing, so a request issued after it would be dropped by signal() and sit
  // out its own 10s timeout with nothing left alive to answer it.
  private refusal: Error | null = null;
  /** Transports with an ICE restart in flight, so a flapping one asks once. */
  private iceRestarting = new WeakSet<mediasoupClient.types.Transport>();
  // Screen-share producers that are available but not yet consumed (opt-in transmissions)
  private pendingTransmissions: Map<string, string> = new Map(); // peerId → producerId
  // All pending screen producers (video + optional audio) for a peer.
  private pendingScreenProducerIds: Map<string, Set<string>> = new Map();
  // Peers whose transmission the user is actively watching.
  private watchingTransmissionPeers: Set<string> = new Set();

  // ms:new-producer messages that arrived before recvTransport was ready,
  // or before the call roster admitted the peer they name.
  private queuedProducers: MSNewProducer[] = [];

  /**
   * Is this peerId somebody our own call roster places in this call?
   *
   * The SFU tells us who produced a stream and we filed it under whatever
   * peerId it said, so the media server (or anything that can talk to it in
   * our room) chose which name a camera or screen share appears under. The
   * roster lives a layer up in transport state, so it is injected rather
   * than imported: this module must stay loadable without booting libp2p.
   * Unset means "no opinion" - the check is skipped rather than failing
   * closed, so a caller that never wires it up behaves exactly as before.
   */
  private admitsCallPeer: ((peerId: string) => boolean) | null = null;

  setCallPeerAdmission(fn: (peerId: string) => boolean): void {
    this.admitsCallPeer = fn;
  }

  /** Re-run the roster check on producers it deferred. */
  retryDeferredProducers(): void {
    if (!this.device) return;
    this.drainQueuedProducers();
  }

  // Consumes in flight, keyed by producer id, each with the peer whose stream
  // it is, so that ms:peer-left can find theirs. See consumeProducer.
  private inflightConsumes: Map<string, { peerId: string; done: Promise<void> }> =
    new Map();
  // Producers that closed while a consume for them was in flight, by
  // ms:producer-closed or with their owner's ms:peer-left. See
  // consumeProducerInner.
  private closedWhileConsuming: Set<string> = new Set();

  // The remote cameras something on screen shows, by peerId, or null for no
  // opinion (every camera received). See setWantedCameras.
  private wantedCameras: ReadonlySet<string> | null = null;
  // Cameras not received because nothing showed them: producerId → peerId.
  // The app still holds each one's last track - see setWantedCameras - unless
  // bringing it back failed twice (unparkCamera).
  private parkedCameras: Map<string, string> = new Map();
  // Cameras going unshown, by producerId: parked when the timer runs out.
  private parkTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Parked cameras waiting to be tried a second time, by producerId.
  private unparkRetries: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Last time a broken recv transport was rebuilt, so the rebuild (which
  // re-consumes, and so can fail again) cannot become its own loop.
  private lastRecvRecoveryAt = 0;
  private readonly RECV_RECOVERY_MIN_MS = 10_000;

  // SFU WebSocket - opened on join(), closed on leave()
  private sfuWs: WebSocket | null = null;
  /**
   * Handed to us by the SFU at join (and anew at each resume): a join that
   * offers it takes over the session we already have there - transports,
   * producers, consumers - instead of starting over. The signalling socket
   * can drop while the media, on its own UDP path, never stopped; rebuilding
   * everything for that blanked every stream on screen for seconds.
   */
  private resumeToken: string | null = null;
  private joinSigner: ((nonce: string, room: string, peer: string) => string) | null = null;
  private roomAdmission: ((room: string, nonce: string, peer: string) => { roomCode: string; capability: string } | undefined) | null = null;

  setRoomAdmission(provider: NonNullable<typeof this.roomAdmission>): void {
    this.roomAdmission = provider;
  }

  setJoinSigner(signer: (nonce: string, room: string, peer: string) => string): void {
    this.joinSigner = signer;
  }
  private currentRoomCode: string | null = null;
  private currentPeerId: string | null = null;
  private joinGeneration = 0; // incremented on each join() to guard against stale attemptRejoin
  // The one pending rejoin, and the one rebuild in flight. Both are single by
  // construction now - see scheduleRejoin and attemptRejoin.
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinP: Promise<void> | null = null;

  // How many OTHER peers the SFU room held at join time (finding 13's interim
  // split-brain guard; the real fix is serving the pool at runtime, which is
  // outside this file). 0 is indistinguishable from "alone" and from "the
  // SFU predates this field" - a caller that expects company should cross
  // check against its own roster, not trust 0 by itself.
  private lastRoomPeerCount = 0;

  // getStats() sweep over live consumers - the only thing on this path that
  // ever looks at whether media actually arrives (finding 5). Every other
  // detector here reacts to signalling or to connectionstatechange, and both
  // stay healthy while one stream quietly stalls: the SSRC got dropped by a
  // middlebox, the remote encoder stalled, or the server is forwarding from a
  // producer whose sender is long gone.
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly STATS_INTERVAL_MS = 3_000;
  // Two sweeps running, matching the p2p voice watchdog's shape (twice its
  // own reconcile tick) - see the hub note to FixVoice. A blip that clears
  // within one sweep never trips this; only a consumer stuck at the same
  // byte count for two consecutive samples counts as stalled.
  private readonly STATS_STALL_MISSES = 2;
  // consumer.id → last bytesReceived sample and how many sweeps in a row it
  // has not moved.
  private consumerStats: Map<string, { bytes: number; misses: number }> =
    new Map();

  async join(roomCode: string, peerId: string): Promise<void> {
    this.joinGeneration++;
    try {
      this.currentRoomCode = roomCode;
      this.currentPeerId = peerId;
      await this.connectSfu(roomCode, peerId);
      rec(ev("sfu.join", { peer: peerId }));

      const capMsg = await this.request<MSCapabilities>(
        { type: "ms:get-capabilities", requestId: this.nextRequestId() },
        "ms:capabilities"
      );
      this.lastRoomPeerCount = capMsg.roomPeerCount;
      rec(ev("sfu.caps", { d: { roomPeerCount: capMsg.roomPeerCount } }));

      const { Device } = await import("mediasoup-client");
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities: capMsg.rtpCapabilities });

      // Transports are created on first use (publish / consume), not here.
      // mediasoup-client only runs a transport's ICE/DTLS handshake on its
      // first produce or consume, and voice is peer-to-peer, so eager
      // transports sat unconnected for the whole of a voice-only call - a
      // port pair held on the SFU for nothing, and exactly the shape a flood
      // takes. With lazy creation the SFU can reap a transport that never
      // connects (see SFU_TRANSPORT_CONNECT_TIMEOUT_MS) without touching a
      // real client.
      this.drainQueuedProducers();
      // A full handshake means any earlier "unreachable, retrying" banner
      // is now stale - without this signal it sat on screen forever even
      // after video quietly came back.
      this.emit("healed");
      this.startStatsSweep();
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  leave(): void {
    this.producers.forEach((ps) => {
      ps.forEach((p) => {
        p.producer.close();
      });
      ps[0]?.stream.getTracks().forEach((t) => t.stop());
    });
    this.consumers.forEach((cs) => cs.forEach((c) => c.consumer.close()));
    this.sendTransport?.close();
    this.recvTransport?.close();

    this.sfuWs?.close();
    this.sfuWs = null;

    this.stopStatsSweep();
    // Leaving ends the ladder outright. It used to only be neutered - every
    // rung became a no-op because currentRoomCode was null - so the timers
    // ran for the life of the page and came back to life on the next join().
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.producers.clear();
    this.consumers.clear();
    this.inflightConsumes.clear();
    this.closedWhileConsuming.clear();
    this.active.clear();
    this.pendingTransmissions.clear();
    this.pendingScreenProducerIds.clear();
    this.watchingTransmissionPeers.clear();
    this.clearParkedCameras();
    // The next call starts with no opinion, until its own screen says.
    this.wantedCameras = null;
    this.queuedProducers = [];
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.failPending(null, new Error("Left the call"));
    this.resumeToken = null;
    this.currentRoomCode = null;
    this.currentPeerId = null;
  }

  async startCamera(stream?: MediaStream): Promise<void> {
    const s =
      stream ??
      (await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false, // audio stays p2p via VoiceTransport
      }));
    await this.publish(s, "camera");
  }

  stopCamera(): void {
    this.stopSource("camera");
  }

  async startScreenShare(
    stream: MediaStream,
    encoding?: RTCRtpEncodingParameters
  ): Promise<void> {
    await this.publish(stream, "screen", encoding);
    // Track lifecycle (including the browser's own "Stop sharing" button,
    // which ends the video track) is owned by the app layer - call.svelte
    // already installs its own onended that calls stopScreenShare() and
    // plays the stop sound. Assigning a second one here silently overwrote
    // it, so clicking the browser's control never played the sound
    // (finding 19).
  }

  stopScreenShare(): void {
    this.stopSource("screen");
  }

  /** Start watching a pending screen-share transmission from a remote peer. */
  async watchTransmission(peerId: string, producerId: string): Promise<void> {
    // Already actively watching this peer's transmission (has a live VIDEO
    // consumer). Scoped to video, not "any screen consumer" - an audio-only
    // screen consumer must not block a retry (finding 12): video failing
    // while audio succeeded used to count as success forever, with no video
    // consumer ever attempted again and this early return refusing every
    // later click on the tile.
    const existingConsumers = this.consumers.get(peerId);
    if (
      existingConsumers?.some(
        (c) => c.source === "screen" && c.consumer.kind === "video"
      )
    ) {
      return;
    }
    // Remove from pending so the tile changes from "click to watch" to live video
    this.pendingTransmissions.delete(peerId);
    this.watchingTransmissionPeers.add(peerId);
    const all = this.pendingScreenProducerIds.get(peerId);
    if (all && all.size > 0) {
      for (const id of all) {
        try {
          await this.consumeProducer(peerId, id, "screen");
        } catch {
          // keep going; one bad producer shouldn't block the whole transmission
        }
      }
      // Require the VIDEO producer specifically (finding 12): audio alone
      // used to satisfy this and leave the viewer's tile in a permanent
      // "connecting" state with nothing left to retry it.
      const gotVideo = this.consumers
        .get(peerId)
        ?.some((c) => c.source === "screen" && c.consumer.kind === "video");
      if (!gotVideo) {
        // The intent was added above on the promise of a consumer; a failed
        // watch must give it back, or the next producer from this peer gets
        // auto-consumed as if the user were already watching.
        this.watchingTransmissionPeers.delete(peerId);
        throw new Error("Failed to consume transmission");
      }
      return;
    }
    try {
      await this.consumeProducer(peerId, producerId, "screen");
    } catch (err) {
      this.watchingTransmissionPeers.delete(peerId);
      if (err instanceof Error && err.message === PRODUCER_GONE) {
        // The share is over and this tile was stale (the close raced us, or
        // was missed across a reconnect) - retract it instead of leaving a
        // dead "click to watch" that times out on every click.
        this.pendingScreenProducerIds.delete(peerId);
        this.emit("transmissionEnded", peerId);
      }
      throw err;
    }
  }

  /** Stop watching a transmission - close all screen consumers for that peer. */
  stopWatchingTransmission(peerId: string): void {
    this.watchingTransmissionPeers.delete(peerId);
    const peerConsumers = this.consumers.get(peerId);
    if (!peerConsumers) return;
    const screenConsumers = peerConsumers.filter((c) => c.source === "screen");
    for (const c of screenConsumers) {
      this.signal({
        type: "ms:close-consumer",
        producerId: c.consumer.producerId,
      });
      c.consumer.close();
      this.consumerStats.delete(c.consumer.id);
      this.emit("trackRemoved", peerId, "screen", c.consumer.kind);
    }
    // Remove screen consumers from the map entry
    const remaining = peerConsumers.filter((c) => c.source !== "screen");
    if (remaining.length > 0) {
      this.consumers.set(peerId, remaining);
    } else {
      this.consumers.delete(peerId);
    }
  }

  /** Returns a copy of pending transmissions: peerId → producerId. */
  getPendingTransmissions(): Map<string, string> {
    return new Map(this.pendingTransmissions);
  }

  /**
   * Which remote cameras are worth receiving, by peerId: the ones something
   * on screen shows (the stage, the floating panel and picture in picture, a
   * popped out window), and whoever is talking, whom the spotlight may move
   * to next (call-tiles.ts, wantedCameras). Null means no opinion, and every
   * camera is received.
   *
   * Every camera used to be consumed for the whole call at full size and
   * decoded whether anything showed it or not: in another room, with people
   * hidden in the grid, behind a focused share. Eleven cameras cost a
   * desktop two cores and about 25 Mbps down, and only stopping the stream
   * gives that back: with no <video> at all, Chrome's receive pipeline still
   * spends four fifths of it.
   *
   * So a camera nothing shows for CAMERA_PARK_GRACE_MS is parked: its
   * consumer is closed on the SFU (which then stops forwarding it) and here.
   * Shown again, it is consumed afresh; the SFU creates every consumer paused
   * and asks the sender for a keyframe on resume, so it comes back on a
   * clean frame a round trip later. Nothing new on the wire: these are the
   * close and consume frames the stall path already uses.
   *
   * A parked camera emits no trackRemoved. The person's camera is still on,
   * it is only not being received, and everything that asks whether they
   * have video - the spotlight's choice, the grid's "streaming" filter, this
   * very visibility - must keep saying yes, or a parked camera would never
   * be shown again. The app keeps the last track until the fresh consume
   * replaces it, and loses it with ms:producer-closed like any other.
   *
   * Screen shares are never parked: watching one is the user's own choice,
   * and the "who is watching" list is announced from those consumers.
   */
  setWantedCameras(peers: ReadonlySet<string> | null): void {
    const before = this.wantedCameras;
    // The app pushes whenever anything it shows changes, mostly with the
    // same cameras in it.
    if (sameSet(before, peers)) return;
    // A copy: the caller's set stays the caller's.
    this.wantedCameras = peers === null ? null : new Set(peers);
    // Only cameras something has just started to show come back. One shown
    // all along and still parked is one that failed to come back twice
    // (unparkCamera); retrying it on every push retried it in a loop, since
    // the pushes come with any change to the roster or to who is talking,
    // that failure's own trackRemoved included. It is tried again once it
    // has gone unshown and is shown again, or by a rejoin's replay.
    for (const [producerId, peerId] of [...this.parkedCameras]) {
      const wasWanted = before === null || before.has(peerId);
      if (!wasWanted && this.cameraWanted(peerId)) {
        this.unparkCamera(peerId, producerId);
      }
    }
    for (const [peerId, cs] of this.consumers) {
      for (const c of cs) {
        if (c.source === "camera") this.reviewCamera(peerId, c);
      }
    }
  }

  on<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void {
    this.handlers.get(event)?.delete(handler);
  }

  activePeers(): string[] {
    return Array.from(this.active);
  }

  /** How many OTHER peers the SFU room held when this session last joined
   *  (finding 13's interim split-brain guard). Cross-check against the
   *  call's own roster size - a mismatch means this client and the peer it
   *  expects are not actually on the same SFU node. */
  roomPeerCount(): number {
    return this.lastRoomPeerCount;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private nextRequestId(): string {
    return `r${++this.requestSeq}`;
  }

  /**
   * Open a WebSocket to the SFU and send the join message.
   * Resolves once the connection is open and the join is sent.
   */
  private connectSfu(
    roomCode: string,
    peerId: string,
    resume?: string
  ): Promise<"joined" | "resumed"> {
    return new Promise((resolve, reject) => {
      if (shouldBlockSfu()) {
        reject(new Error(SFU_UNREACHABLE));
        return;
      }
      // Which SFU serves this room is a pure function of the room code, so
      // every participant picks the same one without any coordination. With
      // a single VITE_SFU_URL (or none) this is the old behaviour exactly.
      const sfuUrl =
        sfuForRoom(roomCode) ??
        `${location.origin.replace(/^http/, "ws")}/sfu`;
      let sfuHost: string | null;
      try {
        sfuHost = new URL(sfuUrl).host;
      } catch {
        sfuHost = null;
      }
      rec(ev("sfu.pick", { d: { host: sfuHost, poolSize: sfuPool().length } }));

      // A fresh socket starts clean: the previous session's refusal must not
      // fail the requests this one is about to make.
      this.refusal = null;

      const ws = new WebSocket(sfuUrl);
      this.sfuWs = ws;
      let proofSent = false;
      let authenticated = false;
      const authTimer = setTimeout(() => {
        reject(new Error("Video server authentication timed out. Update the app and server together."));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        rec(ev("sfu.ws.open"));
        // Wait for a fresh challenge; never send an unauthenticated legacy join.
      };

      ws.onerror = () => {
        clearTimeout(authTimer);
        rec(ev("sfu.ws.error"));
        reject(new Error(SFU_UNREACHABLE));
      };

      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          if (this.sfuWs !== ws) return;
          const msg = JSON.parse(e.data);
          if (!authenticated) {
            if (msg.type === "auth:challenge" && !proofSent && this.joinSigner) {
              proofSent = true;
              const admission = this.roomAdmission?.(roomCode, msg.nonce, peerId);
              if (roomCode.startsWith("rd2_") && !admission) throw new Error("Room capability unavailable");
              const wireRoom = admission?.roomCode ?? roomCode;
              const signature = this.joinSigner(msg.nonce, wireRoom, peerId);
              ws.send(JSON.stringify({ type: "join", roomCode: wireRoom, peerId, signature, capability: admission?.capability, resume }));
            } else if (msg.type === "auth:joined" && proofSent) {
              authenticated = true;
              clearTimeout(authTimer);
              this.resumeToken = typeof msg.resumeToken === "string" ? msg.resumeToken : null;
              resolve("joined");
            } else if (msg.type === "auth:resumed" && proofSent && resume) {
              authenticated = true;
              clearTimeout(authTimer);
              this.resumeToken = typeof msg.resumeToken === "string" ? msg.resumeToken : null;
              // Here, not after the await: the frames behind this one are
              // already the resumed session's, and must land on a client that
              // has caught up with the room first. Settled either way: a
              // throw here left the resume pending, and the ladder with it.
              try {
                this.reconcileResumed(msg as AuthResumed);
              } finally {
                resolve("resumed");
              }
            } else {
              throw new Error("Video server could not verify this device. Update the app and try again.");
            }
            return;
          }
          this.handleSignal(msg);
        } catch (err) {
          if (!authenticated) {
            clearTimeout(authTimer);
            reject(err instanceof Error ? err : new Error("Video authentication failed"));
            ws.close();
          }
        }
      };

      ws.onclose = (closeEvent: CloseEvent) => {
        clearTimeout(authTimer);
        if (!authenticated) reject(new Error("Video server closed before authenticating this device"));
        // Only the CURRENT socket's close means anything. A rebuild closes the
        // old socket and opens a new one, and the old close event lands after
        // that - rejecting the fresh socket's in-flight requests (they share
        // one pendingById map) and scheduling a rejoin behind a session that is
        // already healthy. That is a join failing with "SFU connection closed"
        // for no reason anyone can see.
        //
        // The probe obeys the same rule and tags the superseded case, because
        // an untagged sfu.ws.close folds into the topology as a disconnected
        // SFU sitting behind a session that is actually fine.
        if (this.sfuWs !== ws) {
          rec(
            ev("sfu.ws.close", {
              d: {
                code: closeEvent.code,
                reason: closeEvent.reason,
                stale: true,
              },
            })
          );
          // Its own requests only: the fresh socket's share the map.
          this.failPending(ws, new Error("SFU connection closed"));
          return;
        }
        rec(
          ev("sfu.ws.close", {
            d: { code: closeEvent.code, reason: closeEvent.reason },
          })
        );
        // A socket that never authenticated is answered by whoever awaited
        // connectSfu - a resume that could not connect, say, whose ladder
        // backs off on its own. Treating its close as a session lost too
        // restarted the ladder at once, every time: a busy loop for as long
        // as the network stayed down.
        const wasJoined = authenticated && this.device !== null;

        // Reject all pending requests when connection drops
        this.failPending(null, new Error("SFU connection closed"));

        // If we were joined, get the session back
        if (wasJoined && this.currentRoomCode && this.currentPeerId) {
          // The SFU holds a session that dropped like this for a while, so
          // the first try is a resume, at once: nothing on screen changes if
          // it works. Without a token there is nothing to resume, and it is
          // the full rebuild after a pause, as before.
          if (this.canResume()) {
            this.scheduleRejoin(this.joinGeneration, 1, 0);
          } else {
            const err: Error = new Error("SFU connection closed unexpectedly");
            this.emit("error", err);
            this.scheduleRejoin(this.joinGeneration);
          }
        }
      };
    });
  }

  /**
   * Rejoin with backoff. One shot was not enough: a network blip longer
   * than the single 2s retry left the user "in the call" (voice is p2p and
   * kept working) with no SFU session at all - no streams visible until a
   * manual leave and rejoin.
   */
  private scheduleRejoin(
    expectedGeneration: number,
    attempt = 1,
    delay = Math.min(2000 * 2 ** (attempt - 1), 30_000)
  ): void {
    // ONE ladder, not one per failure. Four call sites schedule a rejoin (the
    // socket closing, either transport going failed/closed, ensureLive) and
    // every rung schedules the next one forever, so a single bad minute forked
    // several endless ladders that ran side by side for the rest of the page's
    // life - leave() did not stop them either, and a later join() made them
    // effective again. Every rung of every ladder runs a FULL join: a socket, a
    // Device (which builds and discards an RTCPeerConnection to read the native
    // capabilities) and up to two transports, each its own RTCPeerConnection.
    // Chrome caps a page at 500 live ones; that is the "Cannot create so many
    // PeerConnections" that eventually takes voice, video and libp2p's own
    // WebRTC dials down together.
    // A rung that will try a resume is not a rejoin yet: on a flaky network
    // every drop heals unseen that way, and counting each as sfu.rejoin had
    // the dashboard report a rejoin loop for a call nobody saw falter. The
    // rebuild it may still fall back to records its own sfu.rejoin then.
    if (this.canResume()) {
      rec(ev("sfu.resume", { d: { phase: "scheduled", attempt, delayMs: delay } }));
    } else {
      rec(ev("sfu.rejoin", { d: { attempt, delayMs: delay } }));
    }
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.attemptRejoin(expectedGeneration).catch((err) => {
        console.warn(`[MediasoupVideo] rejoin attempt ${attempt} failed:`, err);
        // No attempt cap: the banner promises "retrying in the background",
        // and a 5-rung ladder that quit after a minute made that a lie for
        // any outage longer than one - video stayed dead for the rest of
        // the call. Every 30s forever costs nothing; leaving the call ends
        // the ladder because attemptRejoin then resolves as a no-op.
        // join() bumps joinGeneration even when it fails, so chaining the
        // ORIGINAL generation made every later rung bail silently. Re-read
        // it; a manual rejoin still cancels the ladder because its open
        // socket makes attemptRejoin a no-op.
        this.scheduleRejoin(this.joinGeneration, attempt + 1);
      });
    }, delay);
  }

  /**
   * Whether the SFU session is actually usable - not merely whether a socket
   * is open. An open socket with no transports behind it is the state you land
   * in when the handshake stalls after connecting, and treating that as "live"
   * is what stopped it ever healing. A transport that exists but has gone
   * failed/disconnected/closed under a perfectly healthy socket is the same
   * kind of lie (finding 2): nothing about the socket or the device notices,
   * so this must check the transports too.
   */
  private sessionIsLive(): boolean {
    if (this.refusal) return false;
    if (this.sfuWs?.readyState !== WebSocket.OPEN || this.device == null) {
      return false;
    }
    for (const t of [this.sendTransport, this.recvTransport]) {
      if (t && DEAD_TRANSPORT_STATES[t.connectionState]) return false;
    }
    return true;
  }

  /** Whether the SFU session is actually up right now. */
  isConnected(): boolean {
    return this.sessionIsLive();
  }

  /**
   * Heal the SFU session if it silently died: cheap to call from any app
   * resync moment (tab back to foreground, relay reconnect).
   */
  ensureLive(): void {
    if (!this.currentRoomCode || !this.currentPeerId) return;
    if (this.sessionIsLive()) return;
    this.attemptRejoin(this.joinGeneration).catch(() => {
      this.scheduleRejoin(this.joinGeneration, 2);
    });
  }

  /**
   * Full client-side rebuild after an unexpected SFU disconnect: tear down
   * dead transports/consumers (server already dropped them), run the normal
   * join handshake again, then republish local sources whose tracks are
   * still live. Remote consumers come back via the SFU's producer replay.
   */
  private attemptRejoin(expectedGeneration: number): Promise<void> {
    // Never two rebuilds at once. ensureLive() calls this directly on every
    // app resync (tab foregrounded, relay reconnect) while a ladder rung may
    // already be inside join(), and each concurrent rebuild opens its own
    // socket, Device and transports - the same PeerConnection bleed as above,
    // reached without any ladder forking.
    this.rejoinP ??= this.attemptRejoinInner(expectedGeneration).finally(() => {
      this.rejoinP = null;
    });
    return this.rejoinP;
  }

  private async attemptRejoinInner(expectedGeneration: number): Promise<void> {
    const roomCode = this.currentRoomCode;
    const peerId = this.currentPeerId;
    if (!roomCode || !peerId) return;
    // Bail if joinGeneration changed (manual rejoin happened in the interim)
    if (this.joinGeneration !== expectedGeneration) return;
    // A live session cancels the ladder; an OPEN SOCKET does not. The
    // handshake can fail with the socket still up (capabilities timeout,
    // device.load throwing), and a transport can go "failed" underneath a
    // perfectly healthy socket - both used to make this a no-op that resolved,
    // so the retry ladder stopped after one rung and video stayed dead for the
    // rest of the call.
    if (this.sessionIsLive()) return;

    // A transport can fail while the resume is out: its own rung lands on
    // this same rebuild (attemptRejoin runs one at a time) and must not be
    // answered by a resumed session that carries nothing on it.
    if (this.canResume() && (await this.tryResume(roomCode, peerId)) && !this.transportGone()) return;

    const republish: Omit<Producer, "producer">[] = [];
    for (const [source, ps] of this.producers) {
      const stream = ps[0]?.stream;
      if (stream?.getTracks().some((t) => t.readyState === "live")) {
        republish.push({ source, stream, encoding: ps[0].encoding });
      }
    }

    for (const [peer, cs] of this.consumers) {
      // A local rebuild is not a remote departure. Keep the UI's watch intent
      // so Stop watching remains available while media reconnects.
      cs.forEach((c) => {
        c.consumer.close();
        this.emit("trackRemoved", peer, c.source, c.consumer.kind);
      });
    }
    // Parked cameras too: the app holds their last track, and a camera that
    // went off while the socket was down is never announced as closed. The
    // replay brings back every one still on, through the ordinary consume.
    // What is on screen (wantedCameras) is not session state and stays.
    for (const peer of this.parkedCameras.values()) {
      this.emit("trackRemoved", peer, "camera", "video");
    }
    this.clearParkedCameras();
    this.consumers.clear();
    this.consumerStats.clear();
    this.inflightConsumes.clear();
    this.closedWhileConsuming.clear();
    this.producers.forEach((ps) => ps.forEach((p) => p.producer.close()));
    this.producers.clear();
    this.active.clear();
    // Retract every pending tile from the UI, not just this map: a share
    // that ended while our socket was down never sends us its
    // ms:producer-closed, so a silent clear left transportState offering a
    // "click to watch" for a stream that no longer existed (every click a
    // guaranteed consume timeout). The join replay re-announces every
    // producer still live, and transmissionAvailable puts those tiles back.
    for (const peer of this.pendingTransmissions.keys()) {
      this.emit("transmissionEnded", peer);
    }
    this.pendingTransmissions.clear();
    this.pendingScreenProducerIds.clear();
    // watchingTransmissionPeers is deliberately NOT cleared: it is the user's
    // intent, not session state. After the rejoin, the join replay re-announces
    // every live producer, and the ms:new-producer handler auto-consumes screen
    // producers from peers in this set - so a viewer who was watching a
    // transmission gets it back without re-clicking. Clearing it here is what
    // made a mid-movie socket drop end the movie for that viewer: the rejoin
    // healed the session but demoted the stream to a "click to watch" tile.
    // leave() still clears it - leaving a room IS a change of intent.
    this.queuedProducers = [];
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    // join() assigns a fresh socket, so close this one rather than orphaning
    // it - and a half-open socket is exactly what we may be recovering from.
    // What it still owed fails now, not ten seconds into the new session.
    this.failPending(this.sfuWs, new Error("SFU session rebuilt"));
    this.sfuWs?.close();
    this.sfuWs = null;
    this.resumeToken = null;

    await this.join(roomCode, peerId);
    for (const { source, stream, encoding } of republish) {
      await this.publish(stream, source, encoding);
    }
  }

  /**
   * Whether a dropped socket is all that is wrong, so the session can be
   * taken back as it is. Not when the socket is up (then a transport died,
   * and that is a rebuild), nor when a transport has failed or closed: the
   * media is gone too, and resuming would only bring back a session that
   * carries nothing.
   */
  private canResume(): boolean {
    if (!this.resumeToken || !this.device || this.refusal) return false;
    if (this.sfuWs?.readyState === WebSocket.OPEN) return false;
    return !this.transportGone();
  }

  /** Whether either transport has failed or closed: its media is gone. */
  private transportGone(): boolean {
    return [this.sendTransport, this.recvTransport].some(
      (t) => t != null && (t.connectionState === "failed" || t.connectionState === "closed")
    );
  }

  /**
   * Take the SFU session back on a new socket. True when it is ours again
   * (the room has been reconciled by then, in connectSfu); false when the
   * SFU no longer held it and the caller must rebuild. Throws while the SFU
   * cannot be reached, so the ladder tries again with everything on screen
   * left as it is - the SFU keeps the session a while for exactly that.
   */
  private async tryResume(roomCode: string, peerId: string): Promise<boolean> {
    const token = this.resumeToken!;
    rec(ev("sfu.resume", { d: { phase: "try" } }));
    let how: "joined" | "resumed";
    try {
      how = await this.connectSfu(roomCode, peerId, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rec(ev("sfu.resume", { d: { phase: "failed", message } }));
      // Unreachable: try again, the session is still held. Anything else
      // (refused, timed out after connecting) will not get better by
      // resuming, so the next rung rebuilds.
      if (message !== SFU_UNREACHABLE) this.resumeToken = null;
      this.emit("error", err instanceof Error ? err : new Error(message));
      throw err;
    }
    if (how === "resumed") {
      rec(ev("sfu.resume", { d: { phase: "resumed" } }));
      // A path that went quiet while the socket was down asked for its ICE
      // restart then, and that request failed at once with no socket to go
      // on. Nothing asks again before "failed" - a frozen stream and then
      // the very rebuild this resume avoided.
      if (this.sendTransport?.connectionState === "disconnected") this.restartIce("send");
      if (this.recvTransport?.connectionState === "disconnected") this.restartIce("recv");
      this.emit("healed");
      return true;
    }
    // Too late: the SFU had already ended that session and started a new
    // one on this socket. Drop it; the rebuild opens its own.
    rec(ev("sfu.resume", { d: { phase: "expired" } }));
    rec(ev("sfu.rejoin", { d: { attempt: 0, delayMs: 0, after: "resume-expired" } }));
    const ws = this.sfuWs;
    this.sfuWs = null;
    this.failPending(ws, new Error("SFU session rebuilt"));
    ws?.close();
    return false;
  }

  /**
   * Catch up with the room after a resume, from the SFU's account of it:
   * every producer that closed and everyone who left while the socket was
   * down goes as if its ms:producer-closed / ms:peer-left had arrived, and
   * every producer that started is announced as ms:new-producer would have.
   * What did not change is left exactly as it is - that is the point.
   */
  private reconcileResumed(state: AuthResumed): void {
    const live = new Map(state.producers.map((p) => [p.producerId, p]));
    const room = new Set(state.peers);
    this.lastRoomPeerCount = state.peers.length;

    const known = new Map<string, { peerId: string; source: VideoSource; kind: "audio" | "video" }>();
    for (const [peerId, cs] of this.consumers) {
      for (const c of cs) {
        known.set(c.consumer.producerId, {
          peerId,
          source: c.source,
          kind: c.consumer.kind as "audio" | "video",
        });
      }
    }
    for (const [producerId, peerId] of this.parkedCameras) {
      known.set(producerId, { peerId, source: "camera", kind: "video" });
    }
    for (const [peerId, ids] of this.pendingScreenProducerIds) {
      for (const producerId of ids) {
        if (!known.has(producerId)) known.set(producerId, { peerId, source: "screen", kind: "video" });
      }
    }

    // A producer that closed while a new one of the same peer and source
    // started is that peer's session being replaced, as the SFU marks it
    // live: a watched share stays watched instead of becoming a tile.
    const started = new Set(
      state.producers.filter((p) => !known.has(p.producerId)).map((p) => `${p.peerId}\0${p.source}`)
    );
    for (const [producerId, p] of known) {
      if (live.has(producerId)) continue;
      const replacing = started.has(`${p.peerId}\0${p.source}`);
      this.handleSignal({ type: "ms:producer-closed", producerId, ...p, replacing });
    }
    // A consume still out for one that closed drops what it gets.
    for (const producerId of this.inflightConsumes.keys()) {
      if (!live.has(producerId)) this.closedWhileConsuming.add(producerId);
    }

    const peers = new Set([
      ...this.active,
      ...this.consumers.keys(),
      ...this.pendingTransmissions.keys(),
      ...this.pendingScreenProducerIds.keys(),
    ]);
    for (const peerId of peers) {
      if (!room.has(peerId)) this.handleSignal({ type: "ms:peer-left", peerId });
    }

    this.queuedProducers = this.queuedProducers.filter((q) => live.has(q.producerId));
    const queued = new Set(this.queuedProducers.map((q) => q.producerId));
    for (const p of state.producers) {
      if (known.has(p.producerId) || queued.has(p.producerId)) continue;
      if (this.inflightConsumes.has(p.producerId)) continue;
      this.handleSignal({
        type: "ms:new-producer",
        peerId: p.peerId,
        producerId: p.producerId,
        source: p.source,
      });
    }

    // A consumer closed here while the socket was down (stopped watching,
    // a parked camera) is still forwarded to on the SFU: its
    // ms:close-consumer went nowhere. Checked after the announcements above,
    // so a consume they started is not taken for one of those.
    const held = new Set<string>();
    for (const cs of this.consumers.values()) for (const c of cs) held.add(c.consumer.producerId);
    for (const producerId of state.consuming ?? []) {
      if (held.has(producerId) || this.inflightConsumes.has(producerId)) continue;
      this.signal({ type: "ms:close-consumer", producerId });
    }

    // A produce whose answer was lost with the socket left a producer on
    // the SFU that nothing here sends to or will ever close.
    const mine = new Set<string>();
    for (const ps of this.producers.values()) for (const p of ps) mine.add(p.producer.id);
    for (const producerId of state.own) {
      if (!mine.has(producerId)) this.signal({ type: "ms:close-producer", producerId });
    }
  }

  /**
   * The SFU reaped exactly one transport - a connect timeout, or a mid-call
   * ICE/DTLS failure (sfu/index.ts's reapTransport) - and told us with
   * reason "transport-timeout". The socket and the OTHER direction are still
   * fine, so this must not become a session refusal: failSession() used to
   * latch this.refusal for EVERY ms:error, so one transient DTLS failure on
   * the recv transport also killed a perfectly healthy send transport for
   * the rest of the call, and the banner's promised retry never ran because
   * nothing had scheduled one (finding 1). Rebuild just the affected
   * direction instead of the whole session.
   */
  private handleTransportTimeout(direction: "send" | "recv" | undefined): void {
    rec(ev("sfu.transport.timeout", { d: { direction: direction ?? "unknown" } }));
    this.emit(
      "error",
      new Error(
        direction === "send"
          ? "Send transport timed out - retrying in the background"
          : direction === "recv"
            ? "Receive transport timed out - retrying in the background"
            : "Video transport timed out - retrying in the background"
      )
    );
    // No direction on the frame means an older/mismatched server; rebuild
    // both rather than guess which one actually died.
    if (direction !== "recv") this.rebuildSendTransport();
    if (direction !== "send") this.rebuildRecvTransport();
  }

  /** Rebuild the send side after its transport died server-side: drop the
   *  dead transport and republish whatever local tracks are still live -
   *  the same republish step attemptRejoin uses, scoped to one direction so
   *  a healthy recv transport is left untouched. */
  private rebuildSendTransport(): void {
    if (!this.sendTransport) return;
    this.sendTransport.close();
    this.sendTransport = null;
    const republish: Omit<Producer, "producer">[] = [];
    for (const [source, ps] of this.producers) {
      const stream = ps[0]?.stream;
      if (stream?.getTracks().some((t) => t.readyState === "live")) {
        republish.push({ source, stream, encoding: ps[0].encoding });
      }
    }
    this.producers.forEach((ps) => ps.forEach((p) => p.producer.close()));
    this.producers.clear();
    for (const { source, stream, encoding } of republish) {
      this.publish(stream, source, encoding).catch((err) => {
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      });
    }
  }

  /** Rebuild the recv side after its transport died server-side: every
   *  consumer lived on it, so all of them are dead now regardless of what
   *  their own state says. Re-consume the same producer ids on a fresh
   *  transport instead of leaving frozen tiles with nothing left to retry
   *  them. */
  /** rebuildRecvTransport, rate-limited: the rebuild re-consumes, and those
   *  consumes can fail for their own reasons, so an unguarded call from the
   *  consume path would rebuild in a loop - one RTCPeerConnection per turn. */
  private recoverRecvTransport(): void {
    const now = Date.now();
    if (now - this.lastRecvRecoveryAt < this.RECV_RECOVERY_MIN_MS) return;
    this.lastRecvRecoveryAt = now;
    this.rebuildRecvTransport();
  }

  private rebuildRecvTransport(): void {
    if (!this.recvTransport) return;
    this.recvTransport.close();
    this.recvTransport = null;
    // Every in-flight consume belongs to the transport just closed; a re-
    // consume below must not be handed one of those promises.
    this.inflightConsumes.clear();
    const toRestore: {
      peerId: string;
      producerId: string;
      source: VideoSource;
    }[] = [];
    for (const [peerId, cs] of this.consumers) {
      for (const c of cs) {
        toRestore.push({
          peerId,
          producerId: c.consumer.producerId,
          source: c.source,
        });
        c.consumer.close();
      }
    }
    this.consumers.clear();
    this.consumerStats.clear();
    for (const { peerId, producerId, source } of toRestore) {
      this.consumeProducer(peerId, producerId, source).catch((err) => {
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      });
    }
  }

  private async publish(
    stream: MediaStream,
    source: VideoSource,
    encoding?: RTCRtpEncodingParameters
  ): Promise<void> {
    // Reached whenever the SFU was unavailable at join time (the call itself
    // survives that now), so name the actual cause rather than "Not joined".
    if (!this.device) {
      throw new Error(SFU_PUBLISH_UNAVAILABLE);
    }
    await this.ensureSendTransport();
    if (!this.sendTransport) {
      throw new Error(SFU_PUBLISH_UNAVAILABLE);
    }

    // stop any existing producer for this source
    this.stopSource(source);

    const tracks: MediaStreamTrack[] = [];
    const video = stream.getVideoTracks()[0];
    if (video) tracks.push(video);
    if (source === "screen") {
      const audio = stream.getAudioTracks()[0];
      if (audio) tracks.push(audio);
    }

    const produced: Producer[] = [];
    try {
      for (const track of tracks) {
        const producer = await this.sendTransport.produce({
          track,
          appData: { source },
          // Track lifecycle is owned by the app (stopSource / call.svelte),
          // and rejoin republishes the same tracks after a transport rebuild.
          stopTracks: false,
          // The only audio through the SFU is screen-share loopback (voice is
          // p2p): game and media sound, not speech. Default Opus is mono,
          // voice-tuned, with DTX gating quiet passages - music through that
          // collapses to a phone call. Stereo, no DTX, and enough bitrate.
          ...(track.kind === "audio"
            ? {
                codecOptions: {
                  opusStereo: true,
                  opusDtx: false,
                  opusMaxAverageBitrate: 128_000,
                },
              }
            : encoding
              ? { encodings: [encoding] }
              : {}),
        });
        rec(ev("sfu.produce", { d: { source, kind: track.kind } }));

        const entry: Producer = { producer, source, stream, encoding };
        produced.push(entry);
        // Record incrementally, not once after the whole loop: a screen
        // share produces video then audio, and if audio throws, this.producers
        // must already know about the video producer that DID succeed and
        // that every other peer was already told about via ms:new-producer -
        // otherwise stopSource(source) finds nothing to close and that
        // producer is orphaned for the rest of the call (finding 11).
        this.producers.set(source, produced);

        producer.on("trackended", () => this.stopSource(source));
      }
    } catch (err) {
      // The video producer above (if any) is live on the server and every
      // other peer already has it - closing it here and telling the server
      // means the sharer's "not sharing" UI state and what the room is
      // actually offering agree, instead of the room being handed a
      // producer whose track is about to stop and never deliver anything.
      for (const p of produced) {
        this.signal({ type: "ms:close-producer", producerId: p.producer.id });
        p.producer.close();
      }
      this.producers.delete(source);
      throw err;
    }
  }

  private stopSource(source: VideoSource): void {
    const ps = this.producers.get(source);
    if (!ps || ps.length === 0) {
      return;
    }
    ps.forEach((p) => {
      this.signal({
        type: "ms:close-producer",
        producerId: p.producer.id,
      });
      p.producer.close();
    });
    ps[0].stream.getTracks().forEach((t) => t.stop());
    this.producers.delete(source);
    // Emit locally so UI updates immediately for the sender - once per
    // producer kind, so a screen share's video and audio removal are told
    // apart (finding 4) instead of one event that could mean either.
    for (const p of ps) {
      this.emit("trackRemoved", "local", source, p.producer.kind);
    }
  }

  private sendTransportP: Promise<void> | null = null;
  private recvTransportP: Promise<void> | null = null;

  /**
   * Fail what is waiting on `ws` (every request when null) right away. A
   * request only one socket can answer must not outlive it: left in the map
   * it sat out its 10s timeout after a rebuild, and the transport promise
   * awaiting it was shared with the NEW session - whose first consume then
   * failed with "request timeout: ms:transport-options" for a request sent
   * on a socket that no longer existed.
   */
  private failPending(ws: WebSocket | null, err: Error): void {
    for (const [id, req] of this.pendingById) {
      if (ws && req.ws !== ws) continue;
      this.pendingById.delete(id);
      req.reject(err);
    }
    // In-flight transport creations belong to the CURRENT session, so they
    // go only when that is the one being dropped - a stale socket closing
    // late must not let the live session ask for a second transport, which
    // the SFU refuses without answering while the first is being built.
    if (!ws || ws === this.sfuWs) {
      this.sendTransportP = null;
      this.recvTransportP = null;
    }
  }

  /** Create the send transport once; concurrent callers share the request. */
  private ensureSendTransport(): Promise<void> {
    if (this.sendTransport) return Promise.resolve();
    if (this.sendTransportP) return this.sendTransportP;
    // Clears only itself: an old session's creation settling late must not
    // wipe the one a rebuilt session has in flight.
    const p: Promise<void> = this.createSendTransport().finally(() => {
      if (this.sendTransportP === p) this.sendTransportP = null;
    });
    this.sendTransportP = p;
    return p;
  }

  /** Same for the receive side. */
  private ensureRecvTransport(): Promise<void> {
    if (this.recvTransport) return Promise.resolve();
    if (this.recvTransportP) return this.recvTransportP;
    const p: Promise<void> = this.createRecvTransport().finally(() => {
      if (this.recvTransportP === p) this.recvTransportP = null;
    });
    this.recvTransportP = p;
    return p;
  }

  private async createSendTransport(): Promise<void> {
    const ws = this.sfuWs;
    const msg = await this.request<MSTransportOptions>(
      {
        type: "ms:create-transport",
        requestId: this.nextRequestId(),
        direction: "send",
      },
      "ms:transport-options"
    );

    // The session can be rebuilt while this waited: a transport for the old
    // one would sit on the new session's slot pointing at nothing.
    if (this.sfuWs !== ws || !this.device) throw new Error("SFU session rebuilt");
    this.sendTransport = this.device.createSendTransport({
      ...(msg.options as mediasoupClient.types.TransportOptions),
      // The server never gathers relay candidates of its own (it is
      // ICE-Lite; the browser is the controlling agent), so without this a
      // network that blocks outbound UDP and permits only 80/443 had no
      // path to the SFU at all - voice (which does carry iceServers,
      // libp2p/voice.ts) worked and video silently never did (finding 7).
      iceServers: getIceServers(),
    });
    rec(ev("sfu.transport.create", { d: { direction: "send" } }));

    this.sendTransport.on(
      "connect",
      ({ dtlsParameters }, callback, _errback) => {
        this.signal({
          type: "ms:connect-transport",
          direction: "send",
          dtlsParameters,
        });
        callback();
      }
    );

    this.sendTransport.on(
      "produce",
      async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const source = (appData as { source: VideoSource }).source;
          const { producerId } = await this.request<{ producerId: string }>(
            {
              type: "ms:produce",
              requestId: this.nextRequestId(),
              kind,
              rtpParameters,
              source,
            },
            "ms:produced"
          );
          callback({ id: producerId });
        } catch (err) {
          errback(err instanceof Error ? err : new Error(String(err)));
        }
      }
    );

    this.sendTransport.on("connectionstatechange", (state: string) => {
      rec(ev("sfu.transport.state", { d: { direction: "send", state } }));
      if (state === "disconnected") this.restartIce("send");
      if (state === "failed" || state === "closed") {
        this.emit("error", new Error("Send transport connection failed"));
        this.scheduleRejoin(this.joinGeneration);
      }
    });
  }

  /**
   * A transport whose path went quiet: ask the SFU for fresh ICE credentials
   * and re-run the checks on new sockets, keeping every producer and consumer
   * on it. Waiting for "failed" instead cost ~10s of frozen media and a full
   * rejoin each time a home router stopped passing one UDP flow - seen every
   * ~3 minutes on a screen share. If the restart does not land, "failed"
   * still rejoins as before.
   */
  private restartIce(direction: "send" | "recv"): void {
    const transport = direction === "send" ? this.sendTransport : this.recvTransport;
    if (!transport || transport.closed || this.iceRestarting.has(transport)) return;
    this.iceRestarting.add(transport);
    rec(ev("sfu.ice.restart", { d: { direction } }));
    this.request<MSIceRestarted>(
      { type: "ms:restart-ice", requestId: this.nextRequestId(), direction },
      "ms:ice-restarted"
    )
      .then((msg) => {
        // A rejoin may have replaced the transport while the answer travelled.
        if (transport.closed) return;
        return transport.restartIce({ iceParameters: msg.iceParameters });
      })
      .catch(() => {})
      .finally(() => this.iceRestarting.delete(transport));
  }

  private async createRecvTransport(): Promise<void> {
    const ws = this.sfuWs;
    const msg = await this.request<MSTransportOptions>(
      {
        type: "ms:create-transport",
        requestId: this.nextRequestId(),
        direction: "recv",
      },
      "ms:transport-options"
    );

    // The session can be rebuilt while this waited: a transport for the old
    // one would sit on the new session's slot pointing at nothing.
    if (this.sfuWs !== ws || !this.device) throw new Error("SFU session rebuilt");
    this.recvTransport = this.device.createRecvTransport({
      ...(msg.options as mediasoupClient.types.TransportOptions),
      // See createSendTransport - the recv leg needs the same relay path
      // (finding 7).
      iceServers: getIceServers(),
    });
    rec(ev("sfu.transport.create", { d: { direction: "recv" } }));

    this.recvTransport.on(
      "connect",
      ({ dtlsParameters }, callback, _errback) => {
        this.signal({
          type: "ms:connect-transport",
          direction: "recv",
          dtlsParameters,
        });
        callback();
      }
    );

    this.recvTransport.on("connectionstatechange", (state: string) => {
      rec(ev("sfu.transport.state", { d: { direction: "recv", state } }));
      if (state === "disconnected") this.restartIce("recv");
      if (state === "failed" || state === "closed") {
        this.emit("error", new Error("Receive transport connection failed"));
        this.scheduleRejoin(this.joinGeneration);
      }
    });
  }

  /**
   * Hold a producer announcement for later. Bounded: the deferral is driven
   * by frames the SFU sends us, and an unbounded list of them is its own
   * problem. Oldest goes first - a stale announcement is the least useful.
   */
  private queueProducer(msg: MSNewProducer): void {
    if (this.queuedProducers.length >= MAX_QUEUED_PRODUCERS) {
      this.queuedProducers.shift();
    }
    this.queuedProducers.push(msg);
  }

  /**
   * ms:new-producer frames that arrived before join() finished, or before the
   * roster admitted the peer they name. Re-entering handleSignal may re-queue
   * one that is still not admitted; the splice makes that one pass, not a loop.
   */
  private drainQueuedProducers(): void {
    const queued = this.queuedProducers.splice(0);
    for (const producer of queued) {
      this.handleSignal(producer);
    }
  }

  private signal(msg: MSMessage): void {
    if (this.sfuWs?.readyState === WebSocket.OPEN) {
      this.sfuWs.send(JSON.stringify(msg));
    }
  }

  private handleSignal(msg: MSMessage): void {
    // A refusal answers no particular request, so it is handled before the
    // pending lookup: every reason the SFU sends lands during the join
    // handshake, where a request is waiting for a frame that is never coming.
    if (msg.type === "ms:error") {
      rec(
        ev("sfu.error", {
          d: {
            reason: msg.reason,
            direction: msg.direction ?? null,
            latched: msg.reason !== "transport-timeout",
          },
        })
      );
      if (msg.reason === "transport-timeout") {
        this.handleTransportTimeout(msg.direction);
      } else {
        this.failSession(sfuRefusalMessage(msg.reason));
      }
      return;
    }

    // Resolve by requestId, not by response type (findings 9 and 10): the
    // old FIFO queue handed a late reply to whichever request of the same
    // type had since taken its place after the original timed out, and
    // serialized every request of one type behind whichever one was ahead
    // of it even when nothing connects them.
    const requestId = (msg as { requestId?: string }).requestId;
    if (requestId) {
      const pending = this.pendingById.get(requestId);
      if (pending) {
        this.pendingById.delete(requestId);
        pending.resolve(msg);
        return;
      }
    }

    switch (msg.type) {
      case "ms:new-producer":
        // Recorded BEFORE the queue check, so an announcement that arrives
        // early is still half of the pair a reader needs: every producer
        // announced to us should end in a consumer, and the gap between the
        // two is where a wedged recv transport hides.
        rec(
          ev("sfu.consume", {
            peer: msg.peerId,
            d: {
              phase: "announced",
              producer: msg.producerId,
              source: msg.source,
            },
          })
        );
        // Not joined yet (no device): queue and process after join() completes.
        if (!this.device) {
          this.queueProducer(msg);
          break;
        }
        // The peerId on this frame is whatever the SFU announced, and it is
        // the key everything downstream files the stream under - the tile,
        // the participant entry, the name and avatar shown over it. Only
        // consume producers from somebody our own call roster (which is
        // relay-attested membership plus presence) already places in this
        // call; our own producers are echoed back to us and are exempt.
        // Deferred rather than dropped: presence and the SFU's announcement
        // race, so re-check when the roster next changes.
        if (
          this.admitsCallPeer &&
          msg.peerId !== this.currentPeerId &&
          !this.admitsCallPeer(msg.peerId)
        ) {
          this.queueProducer(msg);
          break;
        }
        // Camera is auto-consumed as before.
        // Screen share is opt-in - emit transmissionAvailable so the UI can show a tile.
        if (msg.source === "screen") {
          if (!this.pendingScreenProducerIds.has(msg.peerId)) {
            this.pendingScreenProducerIds.set(msg.peerId, new Set());
          }
          this.pendingScreenProducerIds.get(msg.peerId)!.add(msg.producerId);

          // If we're already watching this peer's transmission, auto-consume
          // additional screen producers (e.g. tab audio) instead of showing
          // a second pending tile.
          if (
            this.watchingTransmissionPeers.has(msg.peerId) ||
            this.consumers.get(msg.peerId)?.some((c) => c.source === "screen")
          ) {
            // Retry, not fire-and-forget: after a rejoin this branch is the
            // only path that restores a watched transmission, and a single
            // lost consume here was permanent (same shape as finding 8).
            void this.consumeProducerWithRetry(
              msg.peerId,
              msg.producerId,
              "screen"
            );
            break;
          }

          this.pendingTransmissions.set(msg.peerId, msg.producerId);
          this.emit("transmissionAvailable", msg.peerId, msg.producerId);
        } else {
          // ms:new-producer is sent once, at produce time (and in the join
          // replay) - it never repeats, so a single lost consume used to be
          // permanent with no catch at all here (finding 8).
          void this.consumeProducerWithRetry(
            msg.peerId,
            msg.producerId,
            msg.source
          );
        }
        break;
      case "ms:peer-left":
        // peerLeft takes every track the app holds for them, the last one of
        // a parked camera included.
        for (const [producerId, peerId] of [...this.parkedCameras]) {
          if (peerId === msg.peerId) this.parkedCameras.delete(producerId);
        }
        // Their producers closed with them, and the SFU says so with this
        // frame alone: no ms:producer-closed follows (sfu/index.ts
        // handlePeerLeft). So a consume still out for one of them is marked
        // here as that frame would mark it, and drops the consumer it gets
        // (consumeProducerInner). Landing after peerLeft, it brought them
        // back as joined with a track that never plays, and once parked it
        // left an entry nothing cleared.
        for (const [producerId, inflight] of this.inflightConsumes) {
          if (inflight.peerId === msg.peerId) this.closedWhileConsuming.add(producerId);
        }
        if (this.active.has(msg.peerId)) {
          this.active.delete(msg.peerId);
          this.consumers.get(msg.peerId)?.forEach((c) => {
            this.consumerStats.delete(c.consumer.id);
            this.clearParkTimer(c.consumer.producerId);
            c.consumer.close();
          });
          this.consumers.delete(msg.peerId);
          this.emit("peerLeft", msg.peerId);
        }
        // Clean up any pending transmission for this peer
        if (this.pendingTransmissions.has(msg.peerId)) {
          this.pendingTransmissions.delete(msg.peerId);
          this.emit("transmissionEnded", msg.peerId);
        }
        this.pendingScreenProducerIds.delete(msg.peerId);
        this.watchingTransmissionPeers.delete(msg.peerId);
        break;

      case "ms:producer-closed": {
        // Close all consumers for this producer and emit trackRemoved
        let told = false;
        this.consumers.forEach((consumerList, peerId) => {
          const filtered = consumerList.filter((c) => {
            if (c.consumer.producerId === msg.producerId) {
              this.consumerStats.delete(c.consumer.id);
              c.consumer.close();
              this.emit("trackRemoved", peerId, msg.source, msg.kind);
              told = true;
              return false;
            }
            return true;
          });
          if (filtered.length > 0) {
            this.consumers.set(peerId, filtered);
          } else {
            this.consumers.delete(peerId);
          }
        });
        this.clearParkTimer(msg.producerId);
        // A parked camera has no consumer left to close, but the app still
        // holds its last track as "camera on": the camera is off now.
        const parkedPeer = this.parkedCameras.get(msg.producerId);
        if (parkedPeer !== undefined) {
          this.parkedCameras.delete(msg.producerId);
          this.emit("trackRemoved", parkedPeer, msg.source, msg.kind);
          told = true;
        }
        // A consume still out for it has no consumer to close yet: it drops
        // the one it gets (consumeProducerInner). When that consume stands in
        // for one the app still shows - a stalled consumer, or any a rebuilt
        // recv transport lost - nothing above found the old track to report,
        // and the app kept it as on for good: say it is gone now, unless
        // another stream has taken its place. For a first consume the app
        // holds nothing, and this changes nothing there.
        const inflight = this.inflightConsumes.get(msg.producerId);
        if (inflight) {
          this.closedWhileConsuming.add(msg.producerId);
          if (
            !told &&
            !this.filledByAnother(inflight.peerId, msg.source, msg.kind, msg.producerId)
          ) {
            this.emit("trackRemoved", inflight.peerId, msg.source, msg.kind);
          }
        }

        if (msg.source === "screen") {
          const ids = this.pendingScreenProducerIds.get(msg.peerId);
          if (ids) {
            ids.delete(msg.producerId);
            if (ids.size === 0) {
              this.pendingScreenProducerIds.delete(msg.peerId);
              if (this.pendingTransmissions.has(msg.peerId)) {
                this.pendingTransmissions.delete(msg.peerId);
                if (!msg.replacing) this.emit("transmissionEnded", msg.peerId);
              }
            }
          }
          // Only tear down the watch once no screen consumer for this peer
          // survives (finding 4): closing just the audio producer - a
          // surface switch, or a shared window with no audio track - must
          // not kill a video consumer that is still live and delivering.
          const stillHasScreenConsumer = this.consumers
            .get(msg.peerId)
            ?.some((c) => c.source === "screen");
          if (
            this.watchingTransmissionPeers.has(msg.peerId) &&
            !msg.replacing &&
            !stillHasScreenConsumer
          ) {
            this.watchingTransmissionPeers.delete(msg.peerId);
            this.emit("transmissionEnded", msg.peerId);
          }
        }
        break;
      }

      case "ms:producer-consumed":
        this.emit("transmissionWatched", msg.peerId);
        break;

      case "ms:producer-consumer-closed":
        this.emit("transmissionWatchEnded", msg.peerId);
        break;
    }
  }

  /**
   * One consume per producer at a time, shared by every caller.
   *
   * The completed-consumer check in consumeProducerInner cannot see a consume
   * that is still in flight, and several paths legitimately overlap: a click
   * on a tile racing the auto-consume for a peer already being watched, the
   * join replay re-announcing a producer a retry is mid-way through, the
   * stalled-consumer re-consume. Two overlapping consumes for one producer are
   * fatal, not merely wasteful: the SFU answers a duplicate ms:consume with
   * the SAME consumer id and the SAME rtpParameters.mid (sfu/index.ts
   * handleConsume), mediasoup-client appends one m-section per consume with no
   * dedupe of its own, and the browser rejects the resulting offer outright -
   * "duplicated a=msid". Worse, the duplicate section stays in RemoteSdp, which
   * regenerates the WHOLE offer on every later consume, so from then on no
   * remote stream can ever be added again: the exact "stop the stream, try
   * again, nobody can connect" shape.
   */
  private consumeProducer(
    peerId: string,
    producerId: string,
    source: VideoSource
  ): Promise<void> {
    const inflight = this.inflightConsumes.get(producerId);
    if (inflight) {
      // Two consumes for one producer are not merely wasteful: the SFU answers
      // the second with the SAME consumer id and mid, and the duplicate media
      // section makes the browser reject the whole offer permanently. This
      // event is how a reader knows the guard held rather than that the race
      // never happened.
      rec(
        ev("sfu.consume", {
          peer: peerId,
          d: { phase: "dedup", producer: producerId, source },
        })
      );
      return inflight.done;
    }
    const p = this.consumeProducerInner(peerId, producerId, source).finally(
      () => {
        // Identity-checked: a rebuild may have already replaced this entry
        // with a consume against the fresh transport.
        if (this.inflightConsumes.get(producerId)?.done === p) {
          this.inflightConsumes.delete(producerId);
          this.closedWhileConsuming.delete(producerId);
        }
      }
    );
    this.inflightConsumes.set(producerId, { peerId, done: p });
    return p;
  }

  private async consumeProducerInner(
    peerId: string,
    producerId: string,
    source: VideoSource
  ): Promise<void> {
    if (!this.device) return;
    const generation = this.joinGeneration;
    const watching = source === "screen" && this.watchingTransmissionPeers.has(peerId);
    // A retry (finding 8), a stats-triggered re-consume (finding 5), and two
    // ms:new-producer deliveries for the same id must not double-consume -
    // the server's own duplicate-consume path (sfu/index.ts) resends the
    // SAME consumer id, and asking mediasoup-client to build a second local
    // Consumer for an id it may already hold is exactly the ambiguity the
    // audit could not settle (its gap 6). Dedupe here makes it moot.
    const existing = this.consumers.get(peerId);
    if (
      existing?.some(
        (c) => c.consumer.producerId === producerId && !c.consumer.closed
      )
    ) {
      return;
    }
    await this.ensureRecvTransport();
    if (!this.recvTransport) return;

    const response = await this.request<MSConsumerOptions | MSConsumeFailed>(
      {
        type: "ms:consume",
        requestId: this.nextRequestId(),
        producerId,
        rtpCapabilities: this.device.recvRtpCapabilities,
      },
      "ms:consumer-options"
    );
    if (response.type !== "ms:consumer-options") {
      throw new Error(PRODUCER_GONE);
    }

    let consumer: mediasoupClient.types.Consumer;
    try {
      consumer = await this.recvTransport.consume(response.options);
    } catch (err) {
      // A rejected consume leaves mediasoup-client's RemoteSdp holding the
      // media section the browser refused, and it rebuilds the whole offer
      // from that state every time - so one failure here is permanent for
      // this transport and every later stream silently never appears. Rebuild
      // the recv side rather than leave the session quietly one-way.
      this.recoverRecvTransport();
      throw err;
    }
    // Stop watching / leave / another reconnect may win while consume awaits
    // signalling or SDP. Never resurrect that cancelled watch with a late track.
    if (generation !== this.joinGeneration || (watching && !this.watchingTransmissionPeers.has(peerId))) {
      consumer.close();
      if (generation === this.joinGeneration) this.signal({ type: "ms:close-consumer", producerId });
      return;
    }
    // The producer closed after the SFU answered this consume, while the
    // consumer was still being built here: by ms:producer-closed, which has
    // told the app whatever it held of this stream is gone, or with its
    // owner's ms:peer-left, after which the app holds nothing of theirs.
    // This track would never carry a frame: a frozen tile until the stall
    // sweep re-consumed it into "That stream has ended", or a departed peer
    // back in the call. The close-consumer is a courtesy: the SFU dropped
    // its consumer along with the producer.
    if (this.closedWhileConsuming.has(producerId)) {
      consumer.close();
      this.signal({ type: "ms:close-consumer", producerId });
      return;
    }
    // The server creates every consumer paused (see handleConsume) so no RTP
    // is wasted - and no keyframe lost - while the recv transport's DTLS
    // handshake is still in flight. Resuming here is what actually starts
    // media, and mediasoup forces a fresh keyframe request on resume, so the
    // first frame the decoder ever sees is always an IDR rather than an
    // arbitrary point in a GOP the client never asked for (finding 3).
    this.signal({ type: "ms:resume-consumer", producerId });

    rec(
      ev("sfu.consume", {
        peer: peerId,
        d: {
          phase: "ok",
          producer: producerId,
          source,
          kind: consumer.kind,
        },
      })
    );

    const entry: Consumer = { consumer, source };
    if (!this.consumers.has(peerId)) this.consumers.set(peerId, []);
    this.consumers.get(peerId)!.push(entry);
    if (source === "camera") {
      // Received (again): not parked, until nothing on screen shows it for
      // the grace period - see setWantedCameras.
      this.parkedCameras.delete(producerId);
      this.reviewCamera(peerId, entry);
    }

    if (!this.active.has(peerId)) {
      this.active.add(peerId);
      this.emit("peerJoined", peerId);
    }

    this.emit("trackAdded", peerId, consumer.track, source);
    if (source === "screen" && consumer.kind === "video" && this.watchingTransmissionPeers.has(peerId)) {
      this.emit("transmissionRestored", peerId, producerId);
    }

    consumer.on("trackended", () => {
      const current = this.consumers.get(peerId);
      // A callback from an already replaced consumer cannot remove new media.
      if (!current?.some((entry) => entry.consumer === consumer)) return;
      const remaining = current.filter((entry) => entry.consumer !== consumer);
      if (remaining.length) this.consumers.set(peerId, remaining);
      else this.consumers.delete(peerId);
      this.consumerStats.delete(consumer.id);
      consumer.close();
      if (!remaining.some((entry) =>
        entry.source === source && entry.consumer.kind === consumer.kind
      )) {
        this.emit("trackRemoved", peerId, source, consumer.kind);
      }
      if (
        source === "screen" &&
        !remaining.some((entry) => entry.source === "screen")
      ) {
        this.watchingTransmissionPeers.delete(peerId);
        this.emit("transmissionEnded", peerId);
      }
    });
  }

  /**
   * consumeProducer with one bounded retry. ms:new-producer is sent once, at
   * produce time (and once more in the join replay); it never repeats. Before
   * this, the camera auto-consume call site had no catch at all, so any
   * failure - a transport-options timeout while the recv transport was being
   * built, or a canConsume race against a producer that closed between the
   * announcement and this call - left that peer's camera an avatar for the
   * rest of the call with nothing retried and nothing surfaced (finding 8).
   */
  private async consumeProducerWithRetry(
    peerId: string,
    producerId: string,
    source: VideoSource
  ): Promise<void> {
    const generation = this.joinGeneration;
    const watching = source === "screen" && this.watchingTransmissionPeers.has(peerId);
    try {
      await this.consumeProducer(peerId, producerId, source);
    } catch (err) {
      rec(
        ev("sfu.consume.failed", {
          peer: peerId,
          d: { err: errText(err), attempt: 1, producer: producerId },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (generation !== this.joinGeneration || (watching && !this.watchingTransmissionPeers.has(peerId))) return;
      try {
        await this.consumeProducer(peerId, producerId, source);
      } catch (err) {
        rec(
          ev("sfu.consume.failed", {
            peer: peerId,
            d: { err: errText(err), attempt: 2, producer: producerId },
          })
        );
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
  }

  private cameraWanted(peerId: string): boolean {
    return this.wantedCameras === null || this.wantedCameras.has(peerId);
  }

  /**
   * Start, or call off, the grace period of one live camera consumer.
   * Keyed by producer, so a consumer replaced meanwhile (a stall, a rebuilt
   * recv transport) is still the one the timer parks.
   */
  private reviewCamera(peerId: string, c: Consumer): void {
    const producerId = c.consumer.producerId;
    if (this.cameraWanted(peerId)) {
      this.clearParkTimer(producerId);
      return;
    }
    if (this.parkTimers.has(producerId)) return;
    this.parkTimers.set(
      producerId,
      setTimeout(() => {
        this.parkTimers.delete(producerId);
        if (this.cameraWanted(peerId)) return;
        const live = this.consumers
          .get(peerId)
          ?.find(
            (e) =>
              e.source === "camera" &&
              e.consumer.producerId === producerId &&
              !e.consumer.closed
          );
        if (live) this.parkCamera(peerId, live);
      }, CAMERA_PARK_GRACE_MS)
    );
  }

  private clearParkTimer(producerId: string): void {
    const timer = this.parkTimers.get(producerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.parkTimers.delete(producerId);
  }

  /** Stop receiving a camera nothing shows. See setWantedCameras. */
  private parkCamera(peerId: string, c: Consumer): void {
    const producerId = c.consumer.producerId;
    // The SFU first, as the stall path does: a consumer closed only here
    // would go on being forwarded to nobody, and the next ms:consume would
    // hit the server's duplicate path and get this same consumer back.
    this.signal({ type: "ms:close-consumer", producerId });
    c.consumer.close();
    this.consumerStats.delete(c.consumer.id);
    const list = this.consumers.get(peerId);
    if (list) {
      const remaining = list.filter((entry) => entry !== c);
      if (remaining.length > 0) this.consumers.set(peerId, remaining);
      else this.consumers.delete(peerId);
    }
    this.parkedCameras.set(producerId, peerId);
    rec(
      ev("sfu.consume", {
        peer: peerId,
        d: { phase: "parked", producer: producerId, source: "camera" },
      })
    );
  }

  /**
   * Receive a parked camera again. The consume itself takes it off the
   * parked list (consumeProducerInner), and its trackAdded replaces the
   * last track the app kept.
   */
  private unparkCamera(peerId: string, producerId: string, attempt = 1): void {
    // Already on its way back: what is on screen can change several times
    // within one consume, and each would hang another handler on it.
    if (this.inflightConsumes.has(producerId)) return;
    // Shown afresh while a second try waited: this one starts over.
    this.clearUnparkRetry(producerId);
    this.consumeProducer(peerId, producerId, "camera").catch((err) => {
      // Closed, left or rebuilt in the meantime: nothing left to undo.
      if (this.parkedCameras.get(producerId) !== peerId) return;
      rec(
        ev("sfu.consume.failed", {
          peer: peerId,
          d: { err: errText(err), phase: "unpark", attempt, producer: producerId },
        })
      );
      if (err instanceof Error && err.message === PRODUCER_GONE) {
        // The camera went off while parked, and its close raced this.
        this.parkedCameras.delete(producerId);
        if (!this.filledByAnother(peerId, "camera", "video", producerId)) {
          this.emit("trackRemoved", peerId, "camera", "video");
        }
        return;
      }
      if (attempt === 1) {
        // Once more, as an announced camera's first consume is retried
        // (consumeProducerWithRetry). Kept, so that leaving calls it off.
        this.unparkRetries.set(
          producerId,
          setTimeout(() => {
            this.unparkRetries.delete(producerId);
            if (this.parkedCameras.get(producerId) !== peerId) return;
            if (this.cameraWanted(peerId)) this.unparkCamera(peerId, producerId, 2);
          }, 3_000)
        );
        return;
      }
      // Twice over: the stale picture goes, so the tile shows the person
      // rather than a frozen frame. The camera stays parked until something
      // shows it afresh (setWantedCameras) - not while it stays shown, which
      // would retry for as long as the SFU kept failing it. A dead session
      // is the rejoin ladder's, whose replay consumes every camera anew.
      if (!this.filledByAnother(peerId, "camera", "video", producerId)) {
        this.emit("trackRemoved", peerId, "camera", "video");
      }
    });
  }

  /**
   * Whether a stream other than producerId fills this peer's place for this
   * source and kind in the app: a live consumer, or a parked camera whose
   * last track it keeps. trackRemoved names a peer, a source and a kind,
   * never a producer, so one sent for a stream that is gone would take the
   * other one's picture with it - a parked entry left behind by a peer who
   * then came back used to blank their new camera that way.
   */
  private filledByAnother(
    peerId: string,
    source: VideoSource,
    kind: "audio" | "video",
    producerId: string
  ): boolean {
    const live = this.consumers
      .get(peerId)
      ?.some(
        (c) =>
          c.source === source &&
          c.consumer.kind === kind &&
          c.consumer.producerId !== producerId &&
          !c.consumer.closed
      );
    if (live) return true;
    if (source !== "camera") return false;
    for (const [id, peer] of this.parkedCameras) {
      if (peer === peerId && id !== producerId) return true;
    }
    return false;
  }

  private clearUnparkRetry(producerId: string): void {
    const timer = this.unparkRetries.get(producerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.unparkRetries.delete(producerId);
  }

  /** Forget every parked camera and every timer for one, emitting nothing. */
  private clearParkedCameras(): void {
    for (const timer of this.parkTimers.values()) clearTimeout(timer);
    this.parkTimers.clear();
    for (const timer of this.unparkRetries.values()) clearTimeout(timer);
    this.unparkRetries.clear();
    this.parkedCameras.clear();
  }

  /**
   * The SFU refused this session. Fail everything waiting on it now instead of
   * letting each request sit out its 10s timeout, and emit the reason so the
   * call view can show it - join() surfaces the rejection too, but a refusal
   * that arrives with nothing in flight would otherwise reach nobody.
   */
  private failSession(message: string): void {
    const err = new Error(message);
    this.refusal = err;
    this.failPending(null, err);
    this.emit("error", err);
  }

  /**
   * `opts.ignoreRefusal` skips the refusal check below: a refused session
   * is exactly the one `requestDiag` needs to inspect. `opts.alsoAccept`
   * documents a second acceptable response type; it needs no extra check
   * here, because resolution below matches a response by its `requestId`
   * alone, never by `responseType`.
   */
  private request<T>(
    msg: MSMessage,
    responseType: string,
    opts?: { alsoAccept?: string; ignoreRefusal?: boolean }
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A refused session never answers anything: the SFU closed the socket
      // right after its ms:error, so signal() below would drop this frame
      // and the caller would wait out the full timeout for nothing.
      if (this.refusal && !opts?.ignoreRefusal) {
        reject(this.refusal);
        return;
      }

      const requestId = (msg as { requestId?: string }).requestId;
      const ws = this.sfuWs;
      // signal() drops a frame for a socket that is not open, so waiting
      // the full timeout would only report, ten seconds late, a request that
      // never left.
      if (ws?.readyState !== WebSocket.OPEN) {
        reject(new Error(`SFU not connected: ${responseType}`));
        return;
      }

      const timeoutId = setTimeout(() => {
        if (requestId) this.pendingById.delete(requestId);
        reject(new Error(`mediasoup request timeout: ${responseType}`));
      }, 10_000);

      if (requestId) {
        this.pendingById.set(requestId, {
          resolve: (response: MSMessage) => {
            clearTimeout(timeoutId);
            resolve(response as unknown as T);
          },
          reject: (err: Error) => {
            clearTimeout(timeoutId);
            reject(err);
          },
          ws,
        });
      }

      this.signal(msg);
    });
  }

  /**
   * One `ms:diag` snapshot, or null. Never throws: a refused session, a
   * timeout, and `ms:diag-unavailable` all resolve to null, so a caller on
   * a periodic tick needs no try/catch of its own.
   */
  async requestDiag(): Promise<SfuSnapshot | null> {
    try {
      const msg = await this.request<MSDiagReply | MSDiagUnavailable>(
        { type: "ms:diag", requestId: this.nextRequestId() },
        "ms:diag",
        { alsoAccept: "ms:diag-unavailable", ignoreRefusal: true }
      );
      if (msg.type === "ms:diag-unavailable") return null;
      return msg.snapshot;
    } catch {
      return null;
    }
  }

  /** Start the getStats() sweep (finding 5). Idempotent - join() calls this
   *  once per session; a rejoin tears the whole instance state down first. */
  private startStatsSweep(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(
      () => this.sweepConsumerStats(),
      this.STATS_INTERVAL_MS
    );
  }

  private stopStatsSweep(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.consumerStats.clear();
  }

  private sweepConsumerStats(): void {
    for (const [peerId, cs] of this.consumers) {
      for (const c of cs) {
        void this.checkConsumerStats(peerId, c);
      }
    }
  }

  /**
   * One consumer, one getStats() round trip. Two stalled samples in a row -
   * the byte count identical both times - means the RTP genuinely stopped,
   * not that one sweep landed between two packets: connectionstatechange,
   * producer-closed and peer-left all stay healthy through this failure
   * (finding 5), so this is the only thing that notices a frozen tile or
   * silent screen-share audio while everything else still says "connected".
   */
  private async checkConsumerStats(peerId: string, c: Consumer): Promise<void> {
    if (c.consumer.closed) return;
    let bytes = 0;
    try {
      const report = await c.consumer.getStats();
      for (const stat of report.values()) {
        if ((stat as { type?: string }).type === "inbound-rtp") {
          bytes = (stat as { bytesReceived?: number }).bytesReceived ?? 0;
          break;
        }
      }
    } catch {
      return;
    }
    if (c.consumer.closed) return; // may have closed while getStats() was in flight

    const key = c.consumer.id;
    const prev = this.consumerStats.get(key);
    if (!prev || bytes > prev.bytes) {
      this.consumerStats.set(key, { bytes, misses: 0 });
      return;
    }

    const misses = prev.misses + 1;
    if (misses < this.STATS_STALL_MISSES) {
      this.consumerStats.set(key, { bytes, misses });
      return;
    }

    // Stalled for two sweeps running: close the dead consumer and re-consume
    // the same producer id. Tell the server first - closing only locally
    // would leave the server's own consumer record in place, and the next
    // ms:consume for this producer would hit its duplicate-consume path and
    // hand back the SAME consumer id we just abandoned.
    this.consumerStats.delete(key);
    this.emit("trackStalled", peerId, c.source);
    const producerId = c.consumer.producerId;
    this.signal({ type: "ms:close-consumer", producerId });
    c.consumer.close();
    const list = this.consumers.get(peerId);
    if (list) {
      const remaining = list.filter((entry) => entry !== c);
      if (remaining.length > 0) this.consumers.set(peerId, remaining);
      else this.consumers.delete(peerId);
    }
    this.consumeProducer(peerId, producerId, c.source).catch((err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private emit<K extends keyof VideoEvents>(
    event: K,
    ...args: Parameters<VideoEvents[K]>
  ): void {
    recVideoEvent(event as string, args);
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
