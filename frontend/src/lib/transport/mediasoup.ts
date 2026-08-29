// Types only - the runtime library loads when a video call actually starts,
// keeping a large SFU client out of the boot bundle for sessions that never
// turn a camera on.
import type * as mediasoupClient from "mediasoup-client";
import type { VideoTransport, VideoEvents, VideoSource } from "./types";
import { sfuForRoom } from "./sfu-pool";
import { shouldBlockSfu } from "./faults";

/**
 * Reaches the user verbatim - transmission.svelte assigns an error event's
 * message straight to transportState.error - so it says what it means to
 * somebody in a call rather than naming a component they have never heard of.
 */
import { SFU_PUBLISH_UNAVAILABLE, SFU_UNREACHABLE } from "./types";

// ── Message types (mirrored on the SFU server) ────────────────────────────────

interface MSGetCapabilities {
  type: "ms:get-capabilities";
}
interface MSCapabilities {
  type: "ms:capabilities";
  rtpCapabilities: mediasoupClient.types.RtpCapabilities;
}
interface MSCreateTransport {
  type: "ms:create-transport";
  direction: "send" | "recv";
}
interface MSTransportOptions {
  type: "ms:transport-options";
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
  kind: mediasoupClient.types.MediaKind;
  rtpParameters: mediasoupClient.types.RtpParameters;
  source: VideoSource;
}
interface MSProduced {
  type: "ms:produced";
  producerId: string;
}
interface MSConsume {
  type: "ms:consume";
  producerId: string;
  rtpCapabilities: mediasoupClient.types.RtpCapabilities;
}
interface MSConsumerOptions {
  type: "ms:consumer-options";
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
/**
 * How the SFU refuses a session: it sends this and closes the socket. Without
 * a variant here the frame fell through handleSignal's switch and the refusal
 * was silent - a call that never started, with nothing on screen saying why.
 * `reason` is typed loosely on purpose so an SFU that grows a new one still
 * lands on the generic message rather than on nothing at all.
 */
interface MSError {
  type: "ms:error";
  reason: string;
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
  private paused: Set<VideoSource> = new Set();
  private handlers: Map<keyof VideoEvents, Set<Function>> = new Map();
  private pending: Map<string, { resolve: Function; reject: Function }[]> =
    new Map();
  private pendingChains: Map<string, Promise<any>> = new Map();
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

  async join(roomCode: string, peerId: string): Promise<void> {
    this.joinGeneration++;
    const generation = this.joinGeneration;
    try {
      this.currentRoomCode = roomCode;
      this.currentPeerId = peerId;
      await this.connectSfu(roomCode, peerId);

      const capMsg = await this.request<MSCapabilities>(
        { type: "ms:get-capabilities" },
        "ms:capabilities"
      );

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

    this.producers.clear();
    this.consumers.clear();
    this.active.clear();
    this.paused.clear();
    this.pendingTransmissions.clear();
    this.pendingScreenProducerIds.clear();
    this.watchingTransmissionPeers.clear();
    this.queuedProducers = [];
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.pending.clear();
    this.pendingChains.clear();
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

    // browser fires this when user clicks "stop sharing"
    s.getVideoTracks()[0].onended = () => this.stopScreenShare();
  }

  stopScreenShare(): void {
    this.stopSource("screen");
  }

  pauseVideo(source: VideoSource): void {
    const ps = this.producers.get(source);
    if (!ps) return;
    ps.forEach((p) => p.producer.pause());
    this.paused.add(source);
  }

  resumeVideo(source: VideoSource): void {
    const ps = this.producers.get(source);
    if (!ps) return;
    ps.forEach((p) => p.producer.resume());
    this.paused.delete(source);
  }

  isPaused(source: VideoSource): boolean {
    return this.paused.has(source);
  }

  isPublishing(source: VideoSource): boolean {
    return (this.producers.get(source)?.length ?? 0) > 0;
  }

  /** Start watching a pending screen-share transmission from a remote peer. */
  async watchTransmission(peerId: string, producerId: string): Promise<void> {
    // Already actively watching this peer's transmission (has live consumers)
    const existingConsumers = this.consumers.get(peerId);
    if (
      existingConsumers &&
      existingConsumers.some((c) => c.source === "screen")
    ) {
      return;
    }
    // Remove from pending so the tile changes from "click to watch" to live video
    this.pendingTransmissions.delete(peerId);
    this.watchingTransmissionPeers.add(peerId);
    const all = this.pendingScreenProducerIds.get(peerId);
    if (all && all.size > 0) {
      let consumed = 0;
      for (const id of all) {
        try {
          await this.consumeProducer(peerId, id, "screen");
          consumed += 1;
        } catch {
          // keep going; one bad producer shouldn't block the whole transmission
        }
      }
      if (consumed === 0) {
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
    }
    // Remove screen consumers from the map entry
    const remaining = peerConsumers.filter((c) => c.source !== "screen");
    if (remaining.length > 0) {
      this.consumers.set(peerId, remaining);
    } else {
      this.consumers.delete(peerId);
    }
    this.emit("trackRemoved", peerId, "screen");
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

  getAudioTrack(peerId: string): MediaStreamTrack | null {
    const peerConsumers = this.consumers.get(peerId);
    if (!peerConsumers) return null;
    const audioConsumer = peerConsumers.find(
      (c) => c.source === "screen" && c.consumer.track.kind === "audio"
    );
    return audioConsumer ? audioConsumer.consumer.track : null;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

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
        for (const [type, queue] of this.pending) {
          for (const req of queue) {
            req.reject(new Error(`SFU connection closed waiting for ${type}`));
          }
        }
        this.pending.clear();
        this.pendingChains.clear();

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
   * is what stopped it ever healing.
   */
  private sessionIsLive(): boolean {
    // The device is what join() finishes with; transports are lazy now, so
    // their absence says nothing about the session.
    return this.sfuWs?.readyState === WebSocket.OPEN && this.device != null;
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

      producer.on("trackended", () => this.stopSource(source));
    }

    this.producers.set(source, produced);
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
    this.paused.delete(source);
    // Emit locally so UI updates immediately for the sender
    this.emit("trackRemoved", "local", source);
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
      { type: "ms:create-transport", direction: "send" },
      "ms:transport-options"
    );

    this.sendTransport = this.device!.createSendTransport(
      msg.options as mediasoupClient.types.TransportOptions
    );

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
            { type: "ms:produce", kind, rtpParameters, source },
            "ms:produced"
          );
          callback({ id: producerId });
        } catch (err) {
          errback(err instanceof Error ? err : new Error(String(err)));
        }
      }
    );

    this.sendTransport.on("connectionstatechange", (state: string) => {
      if (state === "failed") {
        this.emit("error", new Error("Send transport connection failed"));
        this.scheduleRejoin(this.joinGeneration);
      }
    });
  }

  private async createRecvTransport(): Promise<void> {
    const msg = await this.request<MSTransportOptions>(
      { type: "ms:create-transport", direction: "recv" },
      "ms:transport-options"
    );

    this.recvTransport = this.device!.createRecvTransport(
      msg.options as mediasoupClient.types.TransportOptions
    );

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
      if (state === "failed") {
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
      this.failSession(sfuRefusalMessage(msg.reason));
      return;
    }

    // resolve pending request
    const queue = this.pending.get(msg.type);
    if (queue && queue.length > 0) {
      const req = queue.shift()!;
      req.resolve(msg);
      if (queue.length === 0) {
        this.pending.delete(msg.type);
      }
      return;
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
          this.consumeProducer(msg.peerId, msg.producerId, msg.source);
        }
        break;
      case "ms:peer-left":
        if (this.active.has(msg.peerId)) {
          this.active.delete(msg.peerId);
          this.consumers.get(msg.peerId)?.forEach((c) => c.consumer.close());
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

      case "ms:producer-closed":
        // Close all consumers for this producer and emit trackRemoved
        this.consumers.forEach((consumerList, peerId) => {
          const filtered = consumerList.filter((c) => {
            if (c.consumer.producerId === msg.producerId) {
              c.consumer.close();
              this.emit("trackRemoved", peerId, msg.source);
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
          // Also emit transmissionEnded if we were watching this peer's transmission
          if (this.watchingTransmissionPeers.has(msg.peerId)) {
            this.watchingTransmissionPeers.delete(msg.peerId);
            this.emit("transmissionEnded", msg.peerId);
          }
        }
        break;

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
    await this.ensureRecvTransport();
    if (!this.recvTransport) return;

    const response = await this.request<MSConsumerOptions>(
      {
        type: "ms:consume",
        producerId,
        rtpCapabilities: this.device.recvRtpCapabilities,
      },
      "ms:consumer-options"
    );

    const consumer = await this.recvTransport.consume(response.options);

    if (!this.consumers.has(peerId)) this.consumers.set(peerId, []);
    this.consumers.get(peerId)!.push({ consumer, source });

    if (!this.active.has(peerId)) {
      this.active.add(peerId);
      this.emit("peerJoined", peerId);
    }

    this.emit("trackAdded", peerId, consumer.track, source);

    consumer.on("trackended", () => {
      this.emit("trackRemoved", peerId, source);
      if (source === "screen") {
        this.emit("transmissionEnded", peerId);
      }
    });
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
    for (const queue of this.pending.values()) {
      for (const req of queue) req.reject(err);
    }
    this.pending.clear();
    this.pendingChains.clear();
    this.emit("error", err);
  }

  private request<T>(msg: MSMessage, responseType: string): Promise<T> {
    // Chain this request to serialize by responseType. The .catch() is
    // load-bearing: without it one timed-out request would poison the chain
    // and instantly reject every later request of the same type.
    const prevChain = this.pendingChains.get(responseType) ?? Promise.resolve();
    const chain = prevChain.catch(() => {}).then(
      () =>
        new Promise<T>((resolve, reject) => {
          // A refused session never answers anything: the SFU closed the
          // socket right after its ms:error, so signal() below would drop this
          // frame and the caller would wait out the full timeout for nothing.
          if (this.refusal) {
            reject(this.refusal);
            return;
          }

          // Queue this request
          if (!this.pending.has(responseType)) {
            this.pending.set(responseType, []);
          }

          let timeoutId: ReturnType<typeof setTimeout>;
          const resolveHandler = (response: MSMessage) => {
            clearTimeout(timeoutId);
            resolve(response as unknown as T);
          };

          timeoutId = setTimeout(() => {
            // Remove from queue on timeout
            const queue = this.pending.get(responseType);
            if (queue) {
              const idx = queue.findIndex((r) => r.resolve === resolveHandler);
              if (idx >= 0) {
                queue.splice(idx, 1);
              }
            }
            reject(new Error(`mediasoup request timeout: ${responseType}`));
          }, 10_000);

          this.pending.get(responseType)!.push({
            resolve: resolveHandler,
            reject: (err: Error) => {
              clearTimeout(timeoutId);
              reject(err);
            },
          });

          this.signal(msg);
        })
    );
    this.pendingChains.set(responseType, chain);
    return chain;
  }

  private emit<K extends keyof VideoEvents>(
    event: K,
    ...args: Parameters<VideoEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
