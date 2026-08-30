// Types only - the runtime library loads when a video call actually starts,
// keeping a large SFU client out of the boot bundle for sessions that never
// turn a camera on.
import type * as mediasoupClient from "mediasoup-client";
import type { VideoTransport, VideoEvents, VideoSource } from "./types";
import { sfuForRoom } from "./sfu-pool";
import { shouldBlockSfu } from "./faults";
import { getIceServers } from "./ice-server-list";

/**
 * Reaches the user verbatim - transmission.svelte assigns an error event's
 * message straight to transportState.error - so it says what it means to
 * somebody in a call rather than naming a component they have never heard of.
 */
import { SFU_PUBLISH_UNAVAILABLE, SFU_UNREACHABLE } from "./types";

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
interface MSProducerClosed {
  type: "ms:producer-closed";
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

type MSMessage =
  | MSGetCapabilities
  | MSCapabilities
  | MSCreateTransport
  | MSTransportOptions
  | MSConnectTransport
  | MSProduce
  | MSProduced
  | MSConsume
  | MSConsumerOptions
  | MSNewProducer
  | MSPeerLeft
  | MSProducerClosed
  | MSProducerConsumed
  | MSProducerConsumerClosed
  | MSCloseConsumer
  | MSCloseProducer
  | MSResumeConsumer
  | MSError;

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
    { resolve: (msg: MSMessage) => void; reject: (err: Error) => void }
  > = new Map();
  private requestSeq = 0;
  // Set when the SFU refuses this session with an ms:error frame, cleared when
  // a new socket is opened. The refusal is immediately followed by the socket
  // closing, so a request issued after it would be dropped by signal() and sit
  // out its own 10s timeout with nothing left alive to answer it.
  private refusal: Error | null = null;
  // Screen-share producers that are available but not yet consumed (opt-in transmissions)
  private pendingTransmissions: Map<string, string> = new Map(); // peerId → producerId
  // All pending screen producers (video + optional audio) for a peer.
  private pendingScreenProducerIds: Map<string, Set<string>> = new Map();
  // Peers whose transmission the user is actively watching.
  private watchingTransmissionPeers: Set<string> = new Set();

  // ms:new-producer messages that arrived before recvTransport was ready
  private queuedProducers: MSNewProducer[] = [];

  // SFU WebSocket - opened on join(), closed on leave()
  private sfuWs: WebSocket | null = null;
  private currentRoomCode: string | null = null;
  private currentPeerId: string | null = null;
  private joinGeneration = 0; // incremented on each join() to guard against stale attemptRejoin

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

      const capMsg = await this.request<MSCapabilities>(
        { type: "ms:get-capabilities", requestId: this.nextRequestId() },
        "ms:capabilities"
      );
      this.lastRoomPeerCount = capMsg.roomPeerCount;

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
    this.producers.clear();
    this.consumers.clear();
    this.active.clear();
    this.pendingTransmissions.clear();
    this.pendingScreenProducerIds.clear();
    this.watchingTransmissionPeers.clear();
    this.queuedProducers = [];
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.pendingById.clear();
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

  async startScreenShare(stream?: MediaStream): Promise<void> {
    const s =
      stream ??
      (await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15 } }, // lower framerate for screen share
        audio: true,
      }));
    await this.publish(s, "screen");
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
        throw new Error("Failed to consume transmission");
      }
      return;
    }
    await this.consumeProducer(peerId, producerId, "screen");
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
  private connectSfu(roomCode: string, peerId: string): Promise<void> {
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

      // A fresh socket starts clean: the previous session's refusal must not
      // fail the requests this one is about to make.
      this.refusal = null;

      const ws = new WebSocket(sfuUrl);
      this.sfuWs = ws;

      ws.onopen = () => {
        // Identify ourselves to the SFU with a stable anonymous peer id.
        // We reuse a per-page session id so the SFU can correlate transports.
        ws.send(
          JSON.stringify({
            type: "join",
            roomCode,
            peerId,
          })
        );
        resolve();
      };

      ws.onerror = () => {
        reject(new Error(SFU_UNREACHABLE));
      };

      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(e.data) as MSMessage;
          this.handleSignal(msg);
        } catch {
          // ignore non-JSON
        }
      };

      ws.onclose = () => {
        const wasJoined = this.device !== null;

        // Reject all pending requests when connection drops
        for (const req of this.pendingById.values()) {
          req.reject(new Error("SFU connection closed"));
        }
        this.pendingById.clear();

        // If we were joined, emit an error and attempt automatic rejoin
        if (wasJoined && this.currentRoomCode && this.currentPeerId) {
          const err: Error = new Error("SFU connection closed unexpectedly");
          this.emit("error", err);

          // Rejoin with backoff. The SFU destroyed all of our server-side
          // state on disconnect, so this must be a FULL rebuild (device +
          // transports + producers), not just a re-dial.
          this.scheduleRejoin(this.joinGeneration);
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
  private scheduleRejoin(expectedGeneration: number, attempt = 1): void {
    const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
    setTimeout(() => {
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
  private async attemptRejoin(expectedGeneration: number): Promise<void> {
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

    const republish: { source: VideoSource; stream: MediaStream }[] = [];
    for (const [source, ps] of this.producers) {
      const stream = ps[0]?.stream;
      if (stream?.getTracks().some((t) => t.readyState === "live")) {
        republish.push({ source, stream });
      }
    }

    for (const [peer, cs] of this.consumers) {
      cs.forEach((c) => c.consumer.close());
      this.emit("peerLeft", peer);
    }
    this.consumers.clear();
    this.consumerStats.clear();
    this.producers.forEach((ps) => ps.forEach((p) => p.producer.close()));
    this.producers.clear();
    this.active.clear();
    this.pendingTransmissions.clear();
    this.pendingScreenProducerIds.clear();
    this.watchingTransmissionPeers.clear();
    this.queuedProducers = [];
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    // join() assigns a fresh socket, so close this one rather than orphaning
    // it - and a half-open socket is exactly what we may be recovering from.
    this.sfuWs?.close();
    this.sfuWs = null;

    await this.join(roomCode, peerId);
    for (const { source, stream } of republish) {
      await this.publish(stream, source);
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
    const republish: { source: VideoSource; stream: MediaStream }[] = [];
    for (const [source, ps] of this.producers) {
      const stream = ps[0]?.stream;
      if (stream?.getTracks().some((t) => t.readyState === "live")) {
        republish.push({ source, stream });
      }
    }
    this.producers.forEach((ps) => ps.forEach((p) => p.producer.close()));
    this.producers.clear();
    for (const { source, stream } of republish) {
      this.publish(stream, source).catch((err) => {
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
  private rebuildRecvTransport(): void {
    if (!this.recvTransport) return;
    this.recvTransport.close();
    this.recvTransport = null;
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
    source: VideoSource
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
            : {}),
        });

        const entry: Producer = { producer, source, stream };
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

  /** Create the send transport once; concurrent callers share the request. */
  private ensureSendTransport(): Promise<void> {
    if (this.sendTransport) return Promise.resolve();
    this.sendTransportP ??= this.createSendTransport().finally(() => {
      this.sendTransportP = null;
    });
    return this.sendTransportP;
  }

  /** Same for the receive side. */
  private ensureRecvTransport(): Promise<void> {
    if (this.recvTransport) return Promise.resolve();
    this.recvTransportP ??= this.createRecvTransport().finally(() => {
      this.recvTransportP = null;
    });
    return this.recvTransportP;
  }

  private async createSendTransport(): Promise<void> {
    const msg = await this.request<MSTransportOptions>(
      {
        type: "ms:create-transport",
        requestId: this.nextRequestId(),
        direction: "send",
      },
      "ms:transport-options"
    );

    this.sendTransport = this.device!.createSendTransport({
      ...(msg.options as mediasoupClient.types.TransportOptions),
      // The server never gathers relay candidates of its own (it is
      // ICE-Lite; the browser is the controlling agent), so without this a
      // network that blocks outbound UDP and permits only 80/443 had no
      // path to the SFU at all - voice (which does carry iceServers,
      // libp2p/voice.ts) worked and video silently never did (finding 7).
      iceServers: getIceServers(),
    });

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
      if (state === "failed" || state === "closed") {
        this.emit("error", new Error("Send transport connection failed"));
        this.scheduleRejoin(this.joinGeneration);
      }
    });
  }

  private async createRecvTransport(): Promise<void> {
    const msg = await this.request<MSTransportOptions>(
      {
        type: "ms:create-transport",
        requestId: this.nextRequestId(),
        direction: "recv",
      },
      "ms:transport-options"
    );

    this.recvTransport = this.device!.createRecvTransport({
      ...(msg.options as mediasoupClient.types.TransportOptions),
      // See createSendTransport - the recv leg needs the same relay path
      // (finding 7).
      iceServers: getIceServers(),
    });

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
      if (state === "failed" || state === "closed") {
        this.emit("error", new Error("Receive transport connection failed"));
        this.scheduleRejoin(this.joinGeneration);
      }
    });
  }

  /** ms:new-producer frames that arrived before join() finished. */
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
        // Not joined yet (no device): queue and process after join() completes.
        if (!this.device) {
          this.queuedProducers.push(msg);
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
            this.consumeProducer(msg.peerId, msg.producerId, "screen").catch(
              () => {}
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
        if (this.active.has(msg.peerId)) {
          this.active.delete(msg.peerId);
          this.consumers.get(msg.peerId)?.forEach((c) => {
            this.consumerStats.delete(c.consumer.id);
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
        this.consumers.forEach((consumerList, peerId) => {
          const filtered = consumerList.filter((c) => {
            if (c.consumer.producerId === msg.producerId) {
              this.consumerStats.delete(c.consumer.id);
              c.consumer.close();
              this.emit("trackRemoved", peerId, msg.source, msg.kind);
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

        if (msg.source === "screen") {
          const ids = this.pendingScreenProducerIds.get(msg.peerId);
          if (ids) {
            ids.delete(msg.producerId);
            if (ids.size === 0) {
              this.pendingScreenProducerIds.delete(msg.peerId);
              if (this.pendingTransmissions.has(msg.peerId)) {
                this.pendingTransmissions.delete(msg.peerId);
                this.emit("transmissionEnded", msg.peerId);
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

  private async consumeProducer(
    peerId: string,
    producerId: string,
    source: VideoSource
  ): Promise<void> {
    if (!this.device) return;
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

    const response = await this.request<MSConsumerOptions>(
      {
        type: "ms:consume",
        requestId: this.nextRequestId(),
        producerId,
        rtpCapabilities: this.device.recvRtpCapabilities,
      },
      "ms:consumer-options"
    );

    const consumer = await this.recvTransport.consume(response.options);
    // The server creates every consumer paused (see handleConsume) so no RTP
    // is wasted - and no keyframe lost - while the recv transport's DTLS
    // handshake is still in flight. Resuming here is what actually starts
    // media, and mediasoup forces a fresh keyframe request on resume, so the
    // first frame the decoder ever sees is always an IDR rather than an
    // arbitrary point in a GOP the client never asked for (finding 3).
    this.signal({ type: "ms:resume-consumer", producerId });

    if (!this.consumers.has(peerId)) this.consumers.set(peerId, []);
    this.consumers.get(peerId)!.push({ consumer, source });

    if (!this.active.has(peerId)) {
      this.active.add(peerId);
      this.emit("peerJoined", peerId);
    }

    this.emit("trackAdded", peerId, consumer.track, source);

    consumer.on("trackended", () => {
      this.consumerStats.delete(consumer.id);
      this.emit("trackRemoved", peerId, source, consumer.kind);
      if (source === "screen") {
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
    try {
      await this.consumeProducer(peerId, producerId, source);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      try {
        await this.consumeProducer(peerId, producerId, source);
      } catch (err) {
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
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
    for (const req of this.pendingById.values()) {
      req.reject(err);
    }
    this.pendingById.clear();
    this.emit("error", err);
  }

  private request<T>(msg: MSMessage, responseType: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A refused session never answers anything: the SFU closed the socket
      // right after its ms:error, so signal() below would drop this frame
      // and the caller would wait out the full timeout for nothing.
      if (this.refusal) {
        reject(this.refusal);
        return;
      }

      const requestId = (msg as { requestId?: string }).requestId;

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
        });
      }

      this.signal(msg);
    });
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
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
