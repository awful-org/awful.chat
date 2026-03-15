import * as mediasoupClient from "mediasoup-client";
import type {
  VideoTransport,
  VideoEvents,
  VideoSource,
  PeerTransport,
} from "./types";

// flow over existing PeerTransport data channel
// wrapped as { kind: "mediasoup", data: MSMessage }

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
  | MSPeerLeft;

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
 * Signaling flows over the existing PeerTransport data channel:
 *   { kind: "mediasoup", data: MSMessage }
 *
 * Compatible with any PeerTransport — SimplePeer or libp2p.
 */
export class MediasoupVideo implements VideoTransport {
  private device: mediasoupClient.types.Device | null = null;
  private sendTransport: mediasoupClient.types.Transport | null = null;
  private recvTransport: mediasoupClient.types.Transport | null = null;
  private producers: Map<VideoSource, Producer> = new Map();
  private consumers: Map<string, Consumer[]> = new Map(); // peerId → consumers
  private active: Set<string> = new Set();
  private paused: Set<VideoSource> = new Set();
  private handlers: Map<keyof VideoEvents, Set<Function>> = new Map();
  private pending: Map<string, { resolve: Function; reject: Function }> =
    new Map();

  // mute/volume state
  private muted: boolean = false;
  private outputGainValue: number = 1.0;
  // Web Audio: per remote track gain nodes for output volume control
  private audioCtx: AudioContext | null = null;
  private trackGains: Map<string, GainNode> = new Map(); // track.id → GainNode

  constructor(private transport: PeerTransport) {
    this.transport.on("message", (_peerId, data) => {
      try {
        const envelope = JSON.parse(new TextDecoder().decode(data));
        if (envelope.kind === "mediasoup") {
          this.handleSignal(envelope.data as MSMessage);
        }
      } catch {
        // not a mediasoup message — ignore
      }
    });

    this.transport.on("disconnect", (peerId) => {
      if (this.active.has(peerId)) {
        this.active.delete(peerId);
        this.consumers.get(peerId)?.forEach((c) => c.consumer.close());
        this.consumers.delete(peerId);
        this.emit("peerLeft", peerId);
      }
    });
  }

  async join(_roomCode: string): Promise<void> {
    try {
      const rtpCapabilities =
        await this.request<mediasoupClient.types.RtpCapabilities>(
          { type: "ms:get-capabilities" },
          "ms:capabilities"
        );

      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });

      await this.createSendTransport();
      await this.createRecvTransport();
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  leave(): void {
    this.producers.forEach((p) => {
      p.producer.close();
      p.stream.getTracks().forEach((t) => t.stop());
    });
    this.consumers.forEach((cs) => cs.forEach((c) => c.consumer.close()));
    this.sendTransport?.close();
    this.recvTransport?.close();

    this.trackGains.forEach((g) => g.disconnect());
    this.trackGains.clear();
    this.audioCtx?.close();

    this.producers.clear();
    this.consumers.clear();
    this.active.clear();
    this.paused.clear();
    this.muted = false;
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.audioCtx = null;
  }

  async startCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false, // audio stays p2p via VoiceTransport
    });
    await this.publish(stream, "camera");
  }

  stopCamera(): void {
    this.stopSource("camera");
  }

  async startScreenShare(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } }, // lower framerate for screen share
      audio: false,
    });
    await this.publish(stream, "screen");

    // browser fires this when user clicks "stop sharing"
    stream.getVideoTracks()[0].onended = () => this.stopScreenShare();
  }

  stopScreenShare(): void {
    this.stopSource("screen");
  }

  pauseVideo(source: VideoSource): void {
    const p = this.producers.get(source);
    if (!p) return;
    p.producer.pause();
    this.paused.add(source);
  }

  resumeVideo(source: VideoSource): void {
    const p = this.producers.get(source);
    if (!p) return;
    p.producer.resume();
    this.paused.delete(source);
  }

  isPaused(source: VideoSource): boolean {
    return this.paused.has(source);
  }

  isPublishing(source: VideoSource): boolean {
    return this.producers.has(source);
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

  /**
   * Pause all outgoing producers — server stops forwarding our video.
   * Does NOT stop the camera/screen track — can unpause instantly.
   */
  mute(): void {
    this.muted = true;
    this.producers.forEach(({ producer }) => producer.pause());
  }

  unmute(): void {
    this.muted = false;
    this.producers.forEach(({ producer }) => producer.resume());
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Set output volume for all incoming remote tracks.
   * 0.0 = silent, 1.0 = unity, 2.0 = boost.
   * Uses Web Audio GainNode — supports values > 1.0.
   * Primarily useful when screen share includes system audio.
   */
  setOutputVolume(volume: number): void {
    this.outputGainValue = Math.max(0, volume);
    for (const gainNode of this.trackGains.values()) {
      gainNode.gain.setTargetAtTime(
        this.outputGainValue,
        this.audioCtx!.currentTime,
        0.01
      );
    }
  }

  private async publish(
    stream: MediaStream,
    source: VideoSource
  ): Promise<void> {
    if (!this.sendTransport) throw new Error("Not joined");

    // stop any existing producer for this source
    this.stopSource(source);

    const [track] = stream.getVideoTracks();
    const producer = await this.sendTransport.produce({
      track,
      appData: { source },
    });

    this.producers.set(source, { producer, source, stream });

    // if already muted, pause this new producer immediately
    if (this.muted) producer.pause();

    // browser ended track externally (screen share stop button)
    producer.on("trackended", () => this.stopSource(source));
  }

  private stopSource(source: VideoSource): void {
    const p = this.producers.get(source);
    if (!p) return;
    p.producer.close();
    p.stream.getTracks().forEach((t) => t.stop());
    this.producers.delete(source);
    this.paused.delete(source);
  }

  private async createSendTransport(): Promise<void> {
    const options = await this.request<mediasoupClient.types.TransportOptions>(
      { type: "ms:create-transport", direction: "send" },
      "ms:transport-options"
    );

    this.sendTransport = this.device!.createSendTransport(options);

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
    const options = await this.request<mediasoupClient.types.TransportOptions>(
      { type: "ms:create-transport", direction: "recv" },
      "ms:transport-options"
    );

    this.recvTransport = this.device!.createRecvTransport(options);

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
  }

  private signal(msg: MSMessage): void {
    const data = new TextEncoder().encode(
      JSON.stringify({ kind: "mediasoup", data: msg })
    );
    const [serverId] = this.transport.peers();
    if (serverId) this.transport.send(serverId, data);
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
        this.consumeProducer(msg.peerId, msg.producerId, msg.source);
        break;
      case "ms:peer-left":
        if (this.active.has(msg.peerId)) {
          this.active.delete(msg.peerId);
          this.consumers.get(msg.peerId)?.forEach((c) => c.consumer.close());
          this.consumers.delete(msg.peerId);
          this.emit("peerLeft", msg.peerId);
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
        rtpCapabilities: this.device.rtpCapabilities,
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

    // if the incoming track has audio (e.g. screen share with system audio),
    // route it through a gain node so setOutputVolume applies
    if (consumer.track.kind === "audio") {
      if (!this.audioCtx || this.audioCtx.state === "closed") {
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume().catch(() => {});
      }
      const stream = new MediaStream([consumer.track]);
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this.outputGainValue;
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.trackGains.set(consumer.track.id, gainNode);
    }

    this.emit("trackAdded", peerId, consumer.track, source);

    consumer.on("trackended", () => {
      this.trackGains.get(consumer.track.id)?.disconnect();
      this.trackGains.delete(consumer.track.id);
      this.emit("trackRemoved", peerId, source);
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
