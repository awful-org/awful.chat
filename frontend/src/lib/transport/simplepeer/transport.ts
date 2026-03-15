import SimplePeer from "simple-peer";
import type {
  PeerTransport,
  SimplePeerExtension,
  TransportEvents,
} from "../types";

interface SignalMessage {
  type: "signal";
  from: string;
  to: string;
  signal: SimplePeer.SignalData;
}

interface PeerJoinedMessage {
  type: "peer-joined";
  peerId: string;
  initiator: boolean;
}

interface PeerLeftMessage {
  type: "peer-left";
  peerId: string;
}

type ServerMessage = SignalMessage | PeerJoinedMessage | PeerLeftMessage;

export class SimplePeerTransport implements PeerTransport, SimplePeerExtension {
  private peerMap = new Map<string, SimplePeer.Instance>();
  private handlers = new Map<keyof TransportEvents, Set<Function>>();
  private ws: WebSocket | null = null;
  private id: string = crypto.randomUUID();
  private roomCode: string | null = null;
  private streamHandler:
    | ((peerId: string, stream: MediaStream) => void)
    | null = null;

  async connect(roomCode: string): Promise<void> {
    this.roomCode = roomCode;
    return new Promise((resolve, reject) => {
      const signalUrl =
        import.meta.env.VITE_SIGNAL_URL ??
        `${location.origin.replace(/^http/, "ws")}/signal`;
      this.ws = new WebSocket(signalUrl);

      this.ws.onopen = () => {
        this.ws!.send(
          JSON.stringify({
            type: "join",
            roomCode: this.roomCode,
            peerId: this.id,
          }),
        );
        resolve();
      };

      this.ws.onerror = (e) => reject(e);

      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        this.handleServerMessage(msg);
      };

      this.ws.onclose = () => {
        for (const peerId of this.peerMap.keys()) {
          this.teardownPeer(peerId);
        }
      };
    });
  }

  disconnect(): void {
    for (const peerId of this.peerMap.keys()) {
      this.teardownPeer(peerId);
    }
    this.ws?.close();
    this.ws = null;
    this.roomCode = null;
  }

  send(peerId: string, data: Uint8Array): void {
    const peer = this.peerMap.get(peerId);
    if (!peer) return;
    peer.send(data);
  }

  broadcast(data: Uint8Array): void {
    for (const peer of this.peerMap.values()) {
      peer.send(data);
    }
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    this.handlers.get(event)?.delete(handler);
  }

  peers(): string[] {
    return Array.from(this.peerMap.keys());
  }

  selfId(): string {
    return this.id;
  }

  addStream(peerId: string, stream: MediaStream): void {
    this.peerMap.get(peerId)?.addStream(stream);
  }

  removeStream(peerId: string, stream: MediaStream): void {
    this.peerMap.get(peerId)?.removeStream(stream);
  }

  onStream(handler: (peerId: string, stream: MediaStream) => void): void {
    this.streamHandler = handler;
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "peer-joined":
        this.createPeer(msg.peerId, msg.initiator);
        break;
      case "peer-left":
        this.teardownPeer(msg.peerId);
        break;
      case "signal":
        this.peerMap.get(msg.from)?.signal(msg.signal);
        break;
    }
  }

  private createPeer(peerId: string, initiator: boolean): void {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      streams: [],
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      },
    });

    peer.on("signal", (signal) => {
      this.ws?.send(
        JSON.stringify({
          type: "signal",
          from: this.id,
          to: peerId,
          signal,
        }),
      );
    });

    peer.on("connect", () => {
      this.emit("connect", peerId);
    });

    peer.on("data", (data: Uint8Array) => {
      this.emit("message", peerId, data);
    });

    peer.on("stream", (stream: MediaStream) => {
      this.streamHandler?.(peerId, stream);
    });

    peer.on("close", () => {
      this.teardownPeer(peerId);
    });

    peer.on("error", (err: Error) => {
      console.warn(`[SimplePeerTransport] peer ${peerId} error:`, err.message);
      // Only destroy on truly fatal errors — not on media renegotiation
      // errors like "User-Initiated Abort" which are thrown when streams
      // are added/removed during an active call.
      const fatal =
        err.message.includes("Ice connection failed") ||
        err.message.includes("connect ECONNREFUSED") ||
        err.message.includes("ERR_ICE_DISCONNECTED");
      if (fatal) {
        this.teardownPeer(peerId);
      }
    });

    this.peerMap.set(peerId, peer);
  }

  private teardownPeer(peerId: string): void {
    const peer = this.peerMap.get(peerId);
    if (!peer) return;
    peer.destroy();
    this.peerMap.delete(peerId);
    this.emit("disconnect", peerId);
  }

  private emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
