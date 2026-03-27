import { createLibp2p, type Libp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, type Identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import {
  pubsubPeerDiscovery,
  type PubSub,
} from "@libp2p/pubsub-peer-discovery";
import { bootstrap } from "@libp2p/bootstrap";
import { keys } from "@libp2p/crypto";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { pipe } from "it-pipe";
import type { PeerTransport, TransportEvents } from "../types";
import type { Stream } from "@libp2p/interface";

const SEND_PROTO = "/app/send/1.0.0";

// Topic scoped to this room — discovery + broadcast both use it.
function roomTopic(roomCode: string) {
  return `app:room:${roomCode}`;
}

function discoveryTopic(roomCode: string) {
  return `app:discovery:${roomCode}`;
}

export interface AppServices {
  pubsub: PubSub;
  identify: Identify;
  [key: string]: unknown;
}

export class LibP2PTransport implements PeerTransport {
  // 1. Strongly type the node with our custom AppServices interface
  private node: Libp2p<AppServices> | null = null;
  private roomCode: string | null = null;
  private handlers = new Map<keyof TransportEvents, Set<Function>>();
  private relayedPeers = new Set<string>();
  private connectedPeers = new Set<string>();

  async connect(
    roomCode: string,
    privateKeyBytes?: Uint8Array | null
  ): Promise<void> {
    this.roomCode = roomCode;

    const relayAddr =
      import.meta.env.VITE_RELAY_MULTIADDR ??
      (() => {
        throw new Error("VITE_RELAY_MULTIADDR not set");
      })();

    const peerId = privateKeyBytes
      ? await this.peerIdFromRawKey(privateKeyBytes)
      : undefined;

    // 2. TypeScript now correctly infers the services map here
    this.node = await createLibp2p({
      ...(peerId ? { peerId } : {}),
      addresses: { listen: ["/webrtc"] },
      transports: [webSockets(), webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        bootstrap({ list: [relayAddr] }),
        pubsubPeerDiscovery({
          interval: 5_000,
          topics: [discoveryTopic(roomCode)],
        }),
      ],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
        }),
      },
    });

    await this.node.start();

    // No more 'unknown' errors here!
    this.node.services.pubsub.subscribe(roomTopic(roomCode));

    // 3. You can safely type the event as a CustomEvent if you want,
    // or leave it as any to bypass strict mode.
    this.node.services.pubsub.addEventListener("message", (evt: any) => {
      if (evt.detail.topic !== roomTopic(roomCode)) return;
      const peerId = evt.detail.from.toString();
      this.emit("message", peerId, evt.detail.data);
    });

    this.node.handle(SEND_PROTO, async ({ stream, connection }: any) => {
      const peerId = connection.remotePeer.toString();
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk.subarray());
      }
      const data = mergeChunks(chunks);
      this.emit("message", peerId, data);
    });

    this.node.addEventListener("peer:connect", (evt) => {
      const peerId = evt.detail.toString();
      if (this.connectedPeers.has(peerId)) return;
      this.connectedPeers.add(peerId);
      this.updateRelayedStatus(peerId);
      this.emit("connect", peerId);
    });

    this.node.addEventListener("peer:disconnect", (evt) => {
      const peerId = evt.detail.toString();
      this.connectedPeers.delete(peerId);
      this.relayedPeers.delete(peerId);
      this.emit("disconnect", peerId);
    });
  }
  disconnect(): void {
    if (!this.node) return;
    this.node.stop();
    this.node = null;
    this.roomCode = null;
    this.connectedPeers.clear();
    this.relayedPeers.clear();
  }

  async send(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.node) return;
    let stream: Stream | null = null;
    try {
      stream = await this.node.dialProtocol(
        this.node.getPeers().find((p) => p.toString() === peerId)!,
        SEND_PROTO
      );

      const targetSink = "sink" in stream ? stream.sink : stream;
      await pipe([data], targetSink as any);
    } catch (err) {
      console.warn(`[LibP2PTransport] send to ${peerId} failed:`, err);
    } finally {
      stream?.close();
    }
  }

  broadcast(data: Uint8Array): void {
    if (!this.node || !this.roomCode) return;
    (async () => {
      try {
        this?.node?.services?.pubsub?.publish?.(
          roomTopic(this.roomCode!),
          data
        );
      } catch (err) {
        console.warn("[LibP2PTransport] broadcast failed:", err);
      }
    })();
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K]
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K]
  ): void {
    this.handlers.get(event)?.delete(handler);
  }

  peers(): string[] {
    return Array.from(this.connectedPeers);
  }

  selfId(): string {
    return this.node?.peerId.toString() ?? "";
  }

  /**
   * Returns true if the current connection to this peer is relayed
   * (i.e. hole-punching failed — traffic is going through the relay server).
   * Use this to show a warning badge in your UI.
   */
  isRelayed(peerId: string): boolean {
    return this.relayedPeers.has(peerId);
  }

  private updateRelayedStatus(peerId: string): void {
    if (!this.node) return;
    const connections = this.node.getConnections(
      this.node.getPeers().find((p) => p.toString() === peerId)
    );
    if (!connections?.length) return;

    // A connection is relayed when its remote address contains /p2p-circuit.
    const isRelayed = connections.some((c) =>
      c.remoteAddr.toString().includes("/p2p-circuit")
    );

    if (isRelayed) {
      this.relayedPeers.add(peerId);
    } else {
      this.relayedPeers.delete(peerId);
    }
  }

  private async peerIdFromRawKey(privateKeyBytes: Uint8Array) {
    // Your identity uses raw ed25519 bytes — wrap them in the libp2p key type.
    const privKey = await keys.generateKeyPairFromSeed(
      "Ed25519",
      privateKeyBytes
    );
    return peerIdFromPrivateKey(privKey);
  }

  private emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
