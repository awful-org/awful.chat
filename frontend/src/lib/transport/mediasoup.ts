import * as mediasoupClient from "mediasoup-client";
import type { VideoTransport, VideoEvents, VideoSource } from "./types";

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
  | MSProducerClosed;

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
 * Audio is NOT handled here — stays p2p via SimplePeerVoice.
 *
 * Signaling flows over a dedicated WebSocket connection to the SFU server.
 * The SFU URL is resolved from VITE_SFU_URL env var, defaulting to /sfu on
 * the same host as the page (routed by the reverse proxy in production).
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
  private pending: Map<string, { resolve: Function; reject: Function }> =
    new Map();
  // Screen-share producers that are available but not yet consumed (opt-in transmissions)
  private pendingTransmissions: Map<string, string> = new Map(); // peerId → producerId
  // All pending screen producers (video + optional audio) for a peer.
  private pendingScreenProducerIds: Map<string, Set<string>> = new Map();
  // Peers whose transmission the user is actively watching.
  private watchingTransmissionPeers: Set<string> = new Set();

  // ms:new-producer messages that arrived before recvTransport was ready
  private queuedProducers: MSNewProducer[] = [];

  // SFU WebSocket — opened on join(), closed on leave()
  private sfuWs: WebSocket | null = null;

  async join(roomCode: string, peerId: string): Promise<void> {
    try {
      await this.connectSfu(roomCode, peerId);

      const capMsg = await this.request<MSCapabilities>(
        { type: "ms:get-capabilities" },
        "ms:capabilities"
      );

      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: capMsg.rtpCapabilities });

      await this.createSendTransport();
      await this.createRecvTransport();
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

  /** Stop watching a transmission — close all screen consumers for that peer. */
  stopWatchingTransmission(peerId: string): void {
    this.watchingTransmissionPeers.delete(peerId);
    const peerConsumers = this.consumers.get(peerId);
    if (!peerConsumers) return;
    const screenConsumers = peerConsumers.filter((c) => c.source === "screen");
    for (const c of screenConsumers) {
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
    const audioConsumer = peerConsumers.find((c) => c.source === "screen");
    return audioConsumer ? audioConsumer.consumer.track : null;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Open a WebSocket to the SFU and send the join message.
   * Resolves once the connection is open and the join is sent.
   */
  private connectSfu(roomCode: string, peerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sfuUrl =
        (import.meta as any).env?.VITE_SFU_URL ??
        `${location.origin.replace(/^http/, "ws")}/sfu`;

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
        reject(new Error("SFU WebSocket error"));
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
        // Reject all pending requests when connection drops
        for (const [type, { reject: rej }] of this.pending) {
          rej(new Error(`SFU connection closed waiting for ${type}`));
        }
        this.pending.clear();
      };
    });
  }

  private async publish(
    stream: MediaStream,
    source: VideoSource
  ): Promise<void> {
    if (!this.sendTransport) throw new Error("Not joined");

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
      });

      const entry: Producer = { producer, source, stream };
      produced.push(entry);

      producer.on("trackended", () => this.stopSource(source));
    }

    this.producers.set(source, produced);
  }

  private stopSource(source: VideoSource): void {
    const ps = this.producers.get(source);
    if (!ps || ps.length === 0) return;
    ps.forEach((p) => p.producer.close());
    ps[0].stream.getTracks().forEach((t) => t.stop());
    this.producers.delete(source);
    this.paused.delete(source);
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

    // Drain any ms:new-producer messages that arrived before we were ready
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
    // resolve pending request
    const pending = this.pending.get(msg.type);
    if (pending) {
      this.pending.delete(msg.type);
      pending.resolve(msg);
      return;
    }

    switch (msg.type) {
      case "ms:new-producer":
        // If recvTransport isn't ready yet, queue and process after join() completes.
        if (!this.recvTransport) {
          this.queuedProducers.push(msg);
          break;
        }
        // Camera is auto-consumed as before.
        // Screen share is opt-in — emit transmissionAvailable so the UI can show a tile.
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
        }
        break;
    }
  }

  private async consumeProducer(
    peerId: string,
    producerId: string,
    source: VideoSource
  ): Promise<void> {
    if (!this.device || !this.recvTransport) return;

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

  private request<T>(msg: MSMessage, responseType: string): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(responseType, {
        resolve: (response: MSMessage) => resolve(response as unknown as T),
        reject,
      });
      this.signal(msg);
      setTimeout(() => {
        if (this.pending.has(responseType)) {
          this.pending.delete(responseType);
          reject(new Error(`mediasoup request timeout: ${responseType}`));
        }
      }, 10_000);
    });
  }

  private emit<K extends keyof VideoEvents>(
    event: K,
    ...args: Parameters<VideoEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
