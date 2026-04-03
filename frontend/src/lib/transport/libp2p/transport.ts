import { createLibp2p, type Libp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, type Identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { type PubSub } from "@libp2p/pubsub-peer-discovery";
import { keys } from "@libp2p/crypto";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type { Connection, Stream } from "@libp2p/interface";
import type { StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";
import type { PeerTransport, TransportEvents } from "../types";

const RELAY_RESERVATION_TIMEOUT_MS = 10_000;
const DIRECT_MSG_PROTOCOL = "/app/direct/1.0.0";
const RENDEZVOUS_PROTOCOL = "/awful/rendezvous/1.0.0";
const PEER_REDIAL_DELAY_MS = 3_000;
const RELAY_RECONNECT_DELAY_MS = 3_000;
const RENDEZVOUS_RECONNECT_DELAY_MS = 2_000;

type RendezvousClientMsg =
  | { type: "REGISTER"; room: string }
  | { type: "UNREGISTER"; room: string };

type RendezvousServerMsg =
  | { type: "PEERS"; room: string; peers: string[] }
  | { type: "PEER_JOINED"; room: string; peer: string }
  | { type: "PEER_LEFT"; room: string; peer: string };

function roomTopic(roomCode: string) {
  return `app:room:${roomCode}`;
}

function encodeFrame(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + data.byteLength);
  new DataView(frame.buffer).setUint32(0, data.byteLength, false);
  frame.set(data, 4);
  return frame;
}

export interface AppServices {
  pubsub: PubSub;
  identify: Identify;
  [key: string]: unknown;
}

export class LibP2PTransport implements PeerTransport {
  private node: Libp2p<AppServices> | null = null;
  private handlers = new Map<keyof TransportEvents, Set<Function>>();
  private relayedPeers = new Set<string>();
  private connectedPeers = new Set<string>();
  private relayPeerId: string | null = null;
  private rendezvousStream: Stream | null = null;
  private rendezvousReadBuf: Uint8Array = new Uint8Array(0);

  private peerStreams = new Map<string, Stream>();
  private pendingQueues = new Map<string, Uint8Array[]>();
  private openingStreams = new Set<string>();
  private dialingPeers = new Set<string>();
  private joinedRooms = new Set<string>();

  // set to true only by disconnect() — prevents any reconnect logic from firing
  private intentionalDisconnect = false;

  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private privateKeyBytes: Uint8Array | null = null;

  get p2pNode(): Libp2p<AppServices> | null {
    return this.node;
  }

  async connect(privateKeyBytes?: Uint8Array | null): Promise<void> {
    this.intentionalDisconnect = false;

    if (privateKeyBytes) this.privateKeyBytes = privateKeyBytes;

    const peerId = this.privateKeyBytes
      ? await this.peerIdFromRawKey(this.privateKeyBytes)
      : undefined;

    this.node = await createLibp2p({
      ...(peerId ? { peerId } : {}),
      addresses: { listen: ["/webrtc"] },
      transports: [
        webSockets(),
        webRTC(),
        circuitRelayTransport({ reservationCompletionTimeout: 20_000 }),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
        }),
      },
    });

    await this.node.handle(
      DIRECT_MSG_PROTOCOL,
      (stream: Stream, connection: Connection) => {
        this.handleInboundStream(connection.remotePeer.toString(), stream);
      }
    );

    await this.node.start();

    const relayMa = import.meta.env.VITE_RELAY_MULTIADDR as string;
    this.relayPeerId = relayMa.split("/p2p/").pop() ?? null;

    const myId = this.node.peerId.toString();
    console.log("[LibP2PTransport] node started, selfId:", myId);

    await this.dialRelay();
    await this.requestRelayReservation();
    await this.waitForRelayReservation();

    this.node.services.pubsub.addEventListener("message", (evt: any) => {
      const from = evt.detail.from.toString();
      if (from === myId || this.isRelayPeer(from)) return;
      const topic: string = evt.detail.topic;
      const room = topic.startsWith("app:room:") ? topic.slice(9) : null;
      if (room && this.joinedRooms.has(room)) {
        this.emit("message", from, evt.detail.data, room);
      }
    });

    this.node.addEventListener("peer:identify", (evt: any) => {
      const id = evt.detail.peerId.toString();
      if (this.isRelayPeer(id) || this.connectedPeers.has(id)) return;
      this.connectedPeers.add(id);
      this.updateRelayedStatus(id);
      this.emit("connect", id);
    });

    this.node.addEventListener(
      "connection:open",
      (evt: CustomEvent<Connection>) => {
        const id = evt.detail.remotePeer.toString();
        if (!this.connectedPeers.has(id)) return;
        this.updateRelayedStatus(id);
      }
    );

    this.node.addEventListener("peer:disconnect", (evt) => {
      const id = evt.detail.toString();

      if (this.isRelayPeer(id)) {
        if (!this.intentionalDisconnect) {
          console.warn("[Transport] relay disconnected, scheduling reconnect");
          this.emit("status", { type: "relay-disconnected", message: "Relay disconnected - reconnecting..." });
          this.scheduleRelayReconnect();
        }
        return;
      }

      this.connectedPeers.delete(id);
      this.relayedPeers.delete(id);
      this.cleanupPeerStream(id);
      this.emit("disconnect", id);

      if (!this.intentionalDisconnect) {
        setTimeout(() => this.redialPeer(id), PEER_REDIAL_DELAY_MS);
      }
    });

    this.startRendezvous();
  }

  joinRoom(roomCode: string): void {
    if (this.joinedRooms.has(roomCode)) return;
    this.joinedRooms.add(roomCode);
    this.node?.services.pubsub.subscribe(roomTopic(roomCode));
    this.rendezvousSend({ type: "REGISTER", room: roomCode });
  }

  leaveRoom(roomCode: string): void {
    if (!this.joinedRooms.has(roomCode)) return;
    this.joinedRooms.delete(roomCode);
    this.rendezvousSend({ type: "UNREGISTER", room: roomCode });
    try {
      this.node?.services.pubsub.unsubscribe(roomTopic(roomCode));
    } catch {}
  }

  disconnect(): void {
    // mark intentional so no reconnect timers fire
    this.intentionalDisconnect = true;

    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }

    if (!this.node) return;

    for (const room of this.joinedRooms) {
      this.rendezvousSend({ type: "UNREGISTER", room });
    }

    this.node.stop();
    this.node = null;
    this.relayPeerId = null;
    this.rendezvousStream = null;
    this.joinedRooms.clear();
    this.connectedPeers.clear();
    this.relayedPeers.clear();
    this.peerStreams.clear();
    this.pendingQueues.clear();
    this.openingStreams.clear();
    this.dialingPeers.clear();
  }

  async send(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.node || this.isRelayPeer(peerId)) return;
if (peerId === this.node.peerId.toString()) return;

    const stream = this.peerStreams.get(peerId);
    if (stream) {
      this.writeFrame(peerId, stream, data);
      return;
    }

    if (!this.pendingQueues.has(peerId)) this.pendingQueues.set(peerId, []);
    this.pendingQueues.get(peerId)!.push(data);

    if (!this.openingStreams.has(peerId)) {
      this.openingStreams.add(peerId);
      this.openOutboundStream(peerId).catch((err) => {
        console.warn(
          `[LibP2PTransport] stream open failed for ${peerId}:`,
          err
        );
        this.emit("status", {
          type: "stream-open-failed",
          peerId: peerId.slice(-8),
          message: `Failed to open stream to peer ${peerId.slice(-8)}`
        });
        this.openingStreams.delete(peerId);
        this.pendingQueues.delete(peerId);
      });
    }
  }

  broadcast(data: Uint8Array, roomCode: string): void {
    if (!this.node || !this.joinedRooms.has(roomCode)) return;
    try {
      this.node.services.pubsub.publish(roomTopic(roomCode), data);
    } catch (err) {
      console.warn("[LibP2PTransport] broadcast failed:", err);
    }
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

  isRelayed(peerId: string): boolean {
    return this.relayedPeers.has(peerId);
  }

  isRelay(peerId: string): boolean {
    return this.isRelayPeer(peerId);
  }

  rooms(): string[] {
    return Array.from(this.joinedRooms);
  }

  private isRelayPeer(peerId: string): boolean {
    return this.relayPeerId !== null && peerId === this.relayPeerId;
  }

  private async dialRelay(): Promise<void> {
    if (!this.node) return;
    const relayMa = import.meta.env.VITE_RELAY_MULTIADDR as string;
    try {
      await this.node.dial(multiaddr(relayMa));
      console.log("[Transport] relay connected");
      this.emit("status", { type: "relay-connected", message: "Connected to relay" });
    } catch (err) {
      console.error("[Transport] relay dial failed:", err);
      this.emit("status", { type: "relay-dial-failed", message: "Failed to connect to relay" });
      throw err;
    }
  }

  private async requestRelayReservation(): Promise<void> {
    if (!this.node) return;
    const relayMa = import.meta.env.VITE_RELAY_MULTIADDR as string;
    const circuitListenAddr = multiaddr(`${relayMa}/p2p-circuit`);
    try {
      await (this.node as any).components.transportManager.listen([
        circuitListenAddr,
      ]);
    } catch (err) {
      console.warn("[Transport] reservation request failed:", err);
    }
  }

  // re-dials a known peer; skips if they're already connected
  private async redialPeer(peerId: string): Promise<void> {
    if (this.intentionalDisconnect || !this.node) return;
    if (this.connectedPeers.has(peerId)) return;
    console.log("[Transport] re-dialing peer:", peerId.slice(-8));
    await this.dialPeer(peerId);
  }

  private scheduleRelayReconnect(): void {
    if (this.intentionalDisconnect || this.relayReconnectTimer || !this.node)
      return;

    this.emit("status", { type: "relay-reconnecting", message: "Reconnecting to relay..." });

    this.relayReconnectTimer = setTimeout(async () => {
      this.relayReconnectTimer = null;
      if (this.intentionalDisconnect || !this.node) return;

      try {
        await this.dialRelay();
        // re-request reservation after reconnecting to relay
        await this.requestRelayReservation();
        await this.waitForRelayReservation();
        // startRendezvous re-registers all joinedRooms internally
        this.startRendezvous();
      } catch (err) {
        console.warn("[Transport] relay reconnect failed, retrying:", err);
        this.emit("status", { type: "relay-reconnect-failed", message: "Relay reconnect failed - retrying..." });
        this.scheduleRelayReconnect();
      }
    }, RELAY_RECONNECT_DELAY_MS);
  }

  private async openOutboundStream(peerId: string): Promise<void> {
    if (!this.node) return;

    const stream = await this.node.dialProtocol(
      peerIdFromString(peerId),
      DIRECT_MSG_PROTOCOL
    );

    this.peerStreams.set(peerId, stream);
    this.openingStreams.delete(peerId);

    const queued = this.pendingQueues.get(peerId) ?? [];
    this.pendingQueues.delete(peerId);
    for (const msg of queued) {
      this.writeFrame(peerId, stream, msg);
    }

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      this.cleanupPeerStream(peerId);
    });
  }

  private writeFrame(peerId: string, stream: Stream, data: Uint8Array): void {
    try {
      const ok = stream.send(encodeFrame(data));
      if (!ok) {
        stream.onDrain().catch(() => this.cleanupPeerStream(peerId));
      }
    } catch (err) {
      console.warn(`[LibP2PTransport] write failed for ${peerId}:`, err);
      this.cleanupPeerStream(peerId);
    }
  }

  private handleInboundStream(fromId: string, stream: Stream): void {
    let buf = new Uint8Array(0);

    stream.addEventListener("message", (evt: StreamMessageEvent) => {
      const chunk: Uint8Array =
        evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();

      const merged = new Uint8Array(buf.byteLength + chunk.byteLength);
      merged.set(buf);
      merged.set(chunk, buf.byteLength);
      buf = merged;

      while (buf.byteLength >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(
          0,
          false
        );
        if (buf.byteLength < 4 + len) break;
        const payload = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        // null room = direct message (not pubsub)
        this.emit("message", fromId, payload, null);
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      stream.abort(new Error("remote closed"));
    });
  }

  private cleanupPeerStream(peerId: string): void {
    const stream = this.peerStreams.get(peerId);
    if (stream) {
      stream.abort(new Error("cleanup"));
      this.peerStreams.delete(peerId);
    }
    this.pendingQueues.delete(peerId);
    this.openingStreams.delete(peerId);
  }

  private async startRendezvous(): Promise<void> {
    if (this.intentionalDisconnect || !this.node || !this.relayPeerId) return;

    const selfId = this.node.peerId.toString();

    let stream: Stream;
    try {
      stream = await this.node.dialProtocol(
        peerIdFromString(this.relayPeerId),
        RENDEZVOUS_PROTOCOL,
        { runOnLimitedConnection: true }
      );
    } catch (err) {
      console.warn("[Rendezvous] failed to open stream, retrying:", err);
      this.emit("status", {
        type: "rendezvous-failed",
        message: "Failed to connect to room server - retrying..."
      });
      setTimeout(() => this.startRendezvous(), RENDEZVOUS_RECONNECT_DELAY_MS);
      return;
    }

    this.rendezvousStream = stream;
    this.rendezvousReadBuf = new Uint8Array(0);

    // re-register all rooms after rendezvous reconnect
    for (const room of this.joinedRooms) {
      this.rendezvousSend({ type: "REGISTER", room });
    }

    stream.addEventListener("message", (evt: StreamMessageEvent) => {
      const chunk: Uint8Array =
        evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();

      const merged = new Uint8Array(
        this.rendezvousReadBuf.byteLength + chunk.byteLength
      );
      merged.set(this.rendezvousReadBuf);
      merged.set(chunk, this.rendezvousReadBuf.byteLength);
      this.rendezvousReadBuf = merged;

      while (this.rendezvousReadBuf.byteLength >= 4) {
        const len = new DataView(
          this.rendezvousReadBuf.buffer,
          this.rendezvousReadBuf.byteOffset
        ).getUint32(0, false);
        if (this.rendezvousReadBuf.byteLength < 4 + len) break;

        const payload = this.rendezvousReadBuf.slice(4, 4 + len);
        this.rendezvousReadBuf = this.rendezvousReadBuf.slice(4 + len);

        try {
          const msg = JSON.parse(
            new TextDecoder().decode(payload)
          ) as RendezvousServerMsg;
          this.handleRendezvousMsg(selfId, msg);
        } catch {}
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      this.rendezvousStream = null;
      if (!this.intentionalDisconnect && this.node) {
        console.warn("[Rendezvous] stream closed, reconnecting");
        this.emit("status", {
          type: "rendezvous-reconnecting",
          message: "Room server disconnected - reconnecting..."
        });
        setTimeout(() => this.startRendezvous(), RENDEZVOUS_RECONNECT_DELAY_MS);
      }
    });
  }

  private rendezvousSend(msg: RendezvousClientMsg): void {
    if (!this.rendezvousStream) return;
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);
    try {
      this.rendezvousStream.send(frame);
    } catch (err) {
      console.warn("[Rendezvous] send failed:", err);
    }
  }

  private async dialPeer(peerId: string): Promise<void> {
    if (!this.node || this.connectedPeers.has(peerId)) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);

    try {
      const relayAddr = import.meta.env.VITE_RELAY_MULTIADDR as string;
      const withWebRTC = multiaddr(
        `${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`
      );
      const withoutWebRTC = multiaddr(`${relayAddr}/p2p-circuit/p2p/${peerId}`);

      try {
        await this.node.dial(withWebRTC);
        return;
      } catch {}

      try {
        await this.node.dial(withoutWebRTC);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("NO_RESERVATION")) {
          console.warn(
            "[Rendezvous] both dials failed for",
            peerId.slice(-8),
            err
          );
        }
      }
    } finally {
      this.dialingPeers.delete(peerId);
    }
  }

  private handleRendezvousMsg(selfId: string, msg: RendezvousServerMsg): void {
    switch (msg.type) {
      case "PEERS": {
        for (const peerId of msg.peers ?? []) {
          if (peerId === selfId || this.connectedPeers.has(peerId)) continue;
          this.dialPeer(peerId).catch(() => {});
        }
        break;
      }
      case "PEER_JOINED": {
        const peerId = msg.peer;
        if (peerId === selfId || this.connectedPeers.has(peerId)) break;
        this.dialPeer(peerId).catch(() => {});
        break;
      }
      case "PEER_LEFT":
        break;
    }
  }

  private waitForRelayReservation(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.node) return resolve();
      const ownId = this.node.peerId.toString();

      const deadline = setTimeout(() => {
        console.warn(
          "[Transport] relay reservation timed out, addrs:",
          this.node?.getMultiaddrs().map((a) => a.toString())
        );
        this.node?.removeEventListener("self:peer:update", check);
        resolve();
      }, RELAY_RESERVATION_TIMEOUT_MS);

      const check = () => {
        const addrs = this.node?.getMultiaddrs() ?? [];
        const circuit = addrs.find((ma) => {
          const s = ma.toString();
          return s.includes("/p2p-circuit") && s.endsWith(`/p2p/${ownId}`);
        });
        if (circuit) {
          console.log("[Transport] relay reservation ok:", circuit.toString());
          clearTimeout(deadline);
          this.node?.removeEventListener("self:peer:update", check);
          resolve();
        }
      };

      this.node.addEventListener("self:peer:update", check);
      check();
    });
  }

  private updateRelayedStatus(peerId: string): void {
    if (!this.node) return;
    const pid = this.node.getPeers().find((p) => p.toString() === peerId);
    const connections = this.node.getConnections(pid);
    if (!connections?.length) return;

    const hasDirect = connections.some(
      (c) => !c.remoteAddr.toString().includes("/p2p-circuit")
    );

    if (hasDirect) this.relayedPeers.delete(peerId);
    else this.relayedPeers.add(peerId);
  }

  private async peerIdFromRawKey(privateKeyBytes: Uint8Array) {
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
