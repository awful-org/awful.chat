import { createLibp2p, type Libp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, type Identify } from "@libp2p/identify";
import { gossipsub, type GossipSub } from "@libp2p/gossipsub";
import { keys } from "@libp2p/crypto";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { Connection, Stream } from "@libp2p/interface";
import type { StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";

// js-libp2p exposes no public "reserve a relay slot now" API. Listening on a
// `<relay>/p2p-circuit` address is what triggers a reservation, and we need to
// do it on demand - after dialing the relay ourselves, and again on reconnect -
// rather than via `addresses.listen`, which would block node startup on relay
// reachability and hand reconnect re-reservation to libp2p's slower refresh
// timer. So we reach the internal TransportManager through this narrow typed
// view (a libp2p rename now fails to compile instead of silently at runtime).
interface WithTransportManager {
  components: {
    transportManager: { listen(addrs: Multiaddr[]): Promise<void> };
  };
}
import type {
  TransportStatus, PeerTransport, TransportEvents } from "../types";
import {
  installFaultHook,
  shouldBlockDial,
  shouldBlockWebrtcDial,
  shouldDropFrame,
  shouldSuppressEvent,
} from "../faults";

const RELAY_RESERVATION_TIMEOUT_MS = 10_000;
const DIRECT_MSG_PROTOCOL = "/app/direct/1.0.0";
const RENDEZVOUS_PROTOCOL = "/awful/rendezvous/1.0.0";
// Upper bound on a single length-prefixed frame. A peer declares the length
// up front, so without a cap a malicious 4-byte length forces us to buffer
// gigabytes waiting for bytes that never come. Direct-stream frames carry app
// messages (profiles-with-avatar, sync batches); rendezvous frames are tiny
// REGISTER/UNREGISTER JSON.
const MAX_DIRECT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RENDEZVOUS_FRAME_BYTES = 16 * 1024;
const PEER_REDIAL_DELAY_MS = 3_000;
const PEER_REDIAL_MAX_MS = 60_000;
const RELAY_RECONNECT_DELAY_MS = 3_000;
const CONNECTION_RECONCILE_MS = 5_000;
/**
 * The gap between upgrade attempts, and the ceiling once they keep failing.
 * The FIRST attempt goes out on the next reconcile tick, not after this delay.
 */
const RELAY_UPGRADE_MIN_MS = 15_000;
const RELAY_UPGRADE_MAX_MS = 5 * 60_000;
/** Silence after which we check a peer is really still there. */
const PEER_SILENCE_MS = 12_000;
const PEER_PING_TIMEOUT_MS = 5_000;
/** Consecutive unanswered pings before we call a peer gone. */
const PING_MISSES_ALLOWED = 2;
/** A fresh stream is pinged this often until its first pong. */
const STREAM_CONFIRM_INTERVAL_MS = 700;
const STREAM_CONFIRM_ATTEMPTS = 8;
// Liveness lives at this layer rather than as a libp2p service: the ping
// package pulls in a second copy of @libp2p/interface and the type skew breaks
// the build. These ride the direct stream we already keep open. Pings carry a
// nonce the pong echoes, so a pong can only confirm the stream whose ping it
// answers - an in-flight pong for an aborted stream must not confirm a brand
// new unproven one and flush app frames into the exact window this exists to
// close.
const MAX_LIVENESS_FRAME_BYTES = 64;
const FRAME_DECODER = new TextDecoder();
function pingFrame(nonce: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: "__ping", n: nonce }));
}
function pongFrame(nonce: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: "__pong", n: nonce }));
}
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

/** libp2p streams expose a status; anything but "open" cannot be written to. */
function streamIsOpen(stream: Stream): boolean {
  const status = (stream as unknown as { status?: string }).status;
  return status === undefined || status === "open";
}

function encodeFrame(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + data.byteLength);
  new DataView(frame.buffer).setUint32(0, data.byteLength, false);
  frame.set(data, 4);
  return frame;
}

export interface AppServices {
  pubsub: GossipSub;
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
  /**
   * Frames waiting for a confirmed stream, each carrying its caller's promise.
   * send() must never claim success for a frame that was merely queued: the
   * DM layer removes messages from its PERSISTED offline queue on `true`, so
   * an optimistic true here permanently destroys messages when the stream
   * never confirms. Every path that empties this map must resolve the
   * entries - true only when actually written, false so callers requeue.
   */
  private pendingQueues = new Map<
    string,
    Array<{ data: Uint8Array; resolve: (ok: boolean) => void }>
  >();
  private openingStreams = new Map<string, Promise<void>>();
  private dialingPeers = new Set<string>();
  private joinedRooms = new Set<string>();
  /**
   * Who the relay says is in each room. Kept so a peer we failed to reach can
   * be tried again later: dialPeer gives up after a few quick attempts, and a
   * peer whose relay reservation had not completed yet (that can take up to
   * 20s) would otherwise never be dialed again. The pair stays invisible to
   * each other - no profile, no voice, and only the text that gossipsub
   * happens to route through somebody else.
   */
  private roomPeers = new Map<string, Set<string>>();
  /** peerId -> earliest time we may dial it again. */
  private nextDialAt = new Map<string, number>();
  private dialBackoff = new Map<string, number>();
  /**
   * Same, for relay -> direct upgrade attempts.
   *
   * dialPeer tries the WebRTC address first and falls back to a plain circuit,
   * and the first dial routinely loses a race with the other side's relay
   * reservation (up to 20s). Whoever lost that race stayed on the relay for
   * the rest of the session: every app frame through the relay's circuit, and
   * a connection that dies whenever the relay hiccups.
   */
  private nextUpgradeAt = new Map<string, number>();
  private upgradeBackoff = new Map<string, number>();
  /**
   * peerId -> last time something arrived on our DIRECT stream with them.
   * Only proof of that stream counts here; see the pubsub handler.
   */
  private lastInbound = new Map<string, number>();
  private pinging = new Set<string>();
  private pingMisses = new Map<string, number>();
  private pingNonceCounter = 0;
  /** Nonces issued for the CURRENT unconfirmed stream, per peer. */
  private confirmNonces = new Map<string, Set<number>>();
  /**
   * The connection each peer most recently opened a stream to US on.
   *
   * After a peer reloads, several connections to the same peerId exist here
   * and only the newest works - the relay keeps the old circuits looking
   * open. dialProtocol picks among them arbitrarily, so our replies could
   * ride a dead circuit while their traffic reaches us fine. The connection
   * their own stream just arrived on is the one connection PROVEN to work,
   * so outbound streams are opened on it. Closing the others instead was
   * tried twice and regressed sync both times: both sides dial each other,
   * so two live connections are legitimate and each side closed the one the
   * other was using.
   */
  private liveConnections = new Map<string, Connection>();
  /**
   * Outbound streams that have proven they reach the other side.
   *
   * Frames flushed straight after newStream() resolve locally but can vanish
   * before the remote handler is reading - measured directly: pings sent on
   * long-established streams arrived while profile/digest frames flushed at
   * stream open never did. So a fresh stream carries only retried pings until
   * the first pong comes back, and app frames stay queued until then. The
   * pong doubles as per-connection liveness: no pong within the retry budget
   * means the connection underneath is dead, and it gets closed - which is
   * the per-connection judgement that closing "the peer's other connections"
   * could never make safely.
   */
  private confirmedStreams = new WeakSet<Stream>();
  private confirmTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Dev counters. Connection-layer faults are invisible without them: every
   *  side looks connected while writes vanish into a dead circuit. */
  readonly debugStats = {
    identifies: 0,
    connects: 0,
    disconnects: 0,
    staleConnectionsClosed: 0,
    relayUpgradeAttempts: 0,
    relayUpgrades: 0,
    livenessDrops: 0,
    outboundResets: 0,
    liveStreamOpens: 0,
    dialStreamOpens: 0,
    openFailures: 0,
    confirmFailures: 0,
    framesOut: 0,
    framesIn: 0,
    pingsIn: 0,
    pongsIn: 0,
    suppressedStreamErrors: 0,
  };

  // set to true only by disconnect() - prevents any reconnect logic from firing
  private intentionalDisconnect = false;

  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private privateKeyBytes: Uint8Array | null = null;

  constructor() {
    installFaultHook();
  }

  get p2pNode(): Libp2p<AppServices> | null {
    return this.node;
  }

  /**
   * Gossipsub's heartbeat races departing peers: it writes GRAFT/PRUNE to a
   * stream the peer just closed, and the rejection escapes the library as
   * uncaught console noise. The mesh self-heals on the next heartbeat, so
   * this exact error is not actionable - swallow it (counted in debugStats),
   * and only it: every other rejection stays loud.
   */
  private installStreamNoiseFilter(): void {
    if (typeof window === "undefined" || this.noiseFilterInstalled) return;
    this.noiseFilterInstalled = true;
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason as { name?: string; message?: string } | undefined;
      if (
        r?.name === "StreamStateError" &&
        /stream that is closed/i.test(r?.message ?? "")
      ) {
        this.debugStats.suppressedStreamErrors++;
        e.preventDefault();
      }
    });
  }
  private noiseFilterInstalled = false;

  async connect(privateKeyBytes?: Uint8Array | null): Promise<void> {
    this.installStreamNoiseFilter();
    this.intentionalDisconnect = false;

    // A previous failed connect may have left a half-started node behind -
    // stop it so retries don't leak libp2p nodes.
    if (this.node) {
      try {
        await this.node.stop();
      } catch {}
      this.node = null;
    }
    // All per-connection state belongs to the old node. Stale connectedPeers
    // would suppress future "connect" events; stale streams can't be reused.
    // joinedRooms is intentionally KEPT - it's re-subscribed below.
    this.connectedPeers.clear();
    this.relayedPeers.clear();
    this.peerStreams.clear();
    for (const pid of [...this.pendingQueues.keys()])
      this.failPendingQueue(pid);
    this.openingStreams.clear();
    this.dialingPeers.clear();
    this.roomPeers.clear();
    this.nextDialAt.clear();
    this.dialBackoff.clear();
    this.nextUpgradeAt.clear();
    this.upgradeBackoff.clear();
    this.liveConnections.clear();
    this.rendezvousStream = null;

    if (privateKeyBytes) this.privateKeyBytes = privateKeyBytes;

    // js-libp2p keys the node by `privateKey`; there is no `peerId` option any
    // more. Passing one was silently ignored (an object spread hides the excess
    // property from the typechecker), so every start generated a random key:
    // the peerId no longer matched the user's identity, which broke the
    // peerId -> did:key binding that presence, profiles and DM auth rely on.
    const privateKey = this.privateKeyBytes
      ? await this.privateKeyFromRawKey(this.privateKeyBytes)
      : undefined;

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen: ["/webrtc"] },
      transports: [
        webSockets(),
        webRTC(),
        circuitRelayTransport({ reservationCompletionTimeout: 20_000 }),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // The browser's default gater denies insecure websockets AND private
      // addresses, which is exactly what a relay running on localhost is - so
      // docker-compose.dev.yml's own relay address could never be dialled and
      // local dev silently fell back to needing the deployed one. Dev builds
      // only: production dials a public wss relay, which the default allows.
      ...(import.meta.env.DEV
        ? { connectionGater: { denyDialMultiaddr: () => false } }
        : {}),
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
        this.handleInboundStream(
          connection.remotePeer.toString(),
          stream,
          connection
        );
      },
      // Never let a duplicate registration abort a (re)connect; see voice.ts.
      { force: true }
    );

    await this.node.start();

    const relayMa = import.meta.env.VITE_RELAY_MULTIADDR as string;
    this.relayPeerId = relayMa.split("/p2p/").pop() ?? null;

    const myId = this.node.peerId.toString();
    console.log("[LibP2PTransport] node started, selfId:", myId);

    // These MUST be attached before the relay dial. waitForRelayReservation()
    // can block for seconds while the node is already reachable, and any peer
    // that connected in that window used to fire peer:identify into the void:
    // never added to connectedPeers, never sent our profile or the room name.
    // That is why peers showed as offline with a raw did while chat, files and
    // voice all worked - those paths do not depend on this event.
    this.node.services.pubsub.addEventListener("message", (evt: any) => {
      const from = evt.detail.from.toString();
      if (from === myId || this.isRelayPeer(from)) return;
      const topic: string = evt.detail.topic;
      const room = topic.startsWith("app:room:") ? topic.slice(9) : null;
      // Deliberately NOT lastInbound. `from` is the message AUTHOR, and
      // gossipsub routes through whoever is in the mesh, so a third peer
      // forwarding B's message was counted as proof that OUR link to B works.
      // That suppressed the liveness probe - the only thing that notices a
      // direct stream writing into a dead circuit - and send() then returns
      // true for frames that never arrive, which makes the DM layer delete
      // them from its persisted queue. The message itself is the presence
      // signal, so there is nothing further to record here.
      if (room && this.joinedRooms.has(room)) {
        this.emit("message", from, evt.detail.data, room);
      }
    });

    this.node.addEventListener("peer:identify", (evt: any) => {
      const id = evt.detail.peerId.toString();
      if (this.isRelayPeer(id)) return;
      // Handle EVERY identify, not just the first.
      //
      // A peer that reloads keeps its peerId, and the relay keeps the old
      // connection object alive, so it never looks disconnected here. Skipping
      // the repeat identify meant its return went unnoticed: we kept the
      // stream from the dead page, every write vanished into it, and the peer
      // sat there connected but receiving nothing. Identify fires once per
      // connection, so re-running this is cheap, and the app's connect handler
      // is idempotent - it just re-sends who we are and reconciles history,
      // which is exactly what a returning peer needs.
      this.lastInbound.set(id, Date.now());
      this.registerPeer(id);
      this.emit("connect", id);
    });

    try {
      await this.dialRelay();
    } catch (err) {
      // Don't leave a running node behind on a failed connect
      try {
        await this.node.stop();
      } catch {}
      this.node = null;
      throw err;
    }
    await this.requestRelayReservation();
    await this.waitForRelayReservation();

    // Anything that connected before the listeners existed (or whose event we
    // missed for any other reason) is picked up here.
    this.reconcileConnections();
    this.reconcileTimer = setInterval(
      () => this.reconcileConnections(),
      CONNECTION_RECONCILE_MS
    );

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
          this.emit("status", {
            type: "relay-disconnected",
            message: "Relay disconnected - reconnecting...",
          });
          this.scheduleRelayReconnect();
        }
        return;
      }

      // dropPeer() closes connections itself, which lands back here via
      // libp2p's own event - without this guard every liveness drop
      // double-fired the app's disconnect handling and scheduled a duplicate
      // redial.
      if (!this.connectedPeers.has(id)) return;
      this.connectedPeers.delete(id);
      this.relayedPeers.delete(id);
      this.pingMisses.delete(id);
      this.lastInbound.delete(id);
      // peer:disconnect is dispatched only once the LAST connection to the
      // peer is gone, so by definition nothing here is usable - keeping an
      // entry whose status merely still reads "open" leaves a dead connection
      // for provenConnection to hand out.
      this.liveConnections.delete(id);
      this.nextUpgradeAt.delete(id);
      this.upgradeBackoff.delete(id);
      this.cleanupPeerStream(id);
      this.emit("disconnect", id);

      if (!this.intentionalDisconnect) {
        setTimeout(() => this.redialPeer(id), PEER_REDIAL_DELAY_MS);
      }
    });

    // Re-subscribe rooms joined before a reconnect - the new node starts
    // with no subscriptions, and joinRoom() early-returns for known rooms.
    // (startRendezvous re-REGISTERs them with the relay itself.)
    for (const room of this.joinedRooms) {
      this.node.services.pubsub.subscribe(roomTopic(room));
    }

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
    // Otherwise the set grows for the whole session; retryMissingRoomPeers
    // skips unjoined rooms, so this is tidiness rather than a leak of work.
    this.roomPeers.delete(roomCode);
    this.rendezvousSend({ type: "UNREGISTER", room: roomCode });
    try {
      this.node?.services.pubsub.unsubscribe(roomTopic(roomCode));
    } catch {}
  }

  async disconnect(): Promise<void> {
    // mark intentional so no reconnect timers fire
    this.intentionalDisconnect = true;

    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (!this.node) return;

    for (const room of this.joinedRooms) {
      this.rendezvousSend({ type: "UNREGISTER", room });
    }

    // Await + swallow like connect() does, so a throwing stop() can't leave a
    // half-stopped node or reject into a fire-and-forget caller.
    try {
      await this.node.stop();
    } catch {}
    this.node = null;
    this.relayPeerId = null;
    this.rendezvousStream = null;
    this.joinedRooms.clear();
    this.connectedPeers.clear();
    this.relayedPeers.clear();
    this.peerStreams.clear();
    for (const pid of [...this.pendingQueues.keys()])
      this.failPendingQueue(pid);
    this.openingStreams.clear();
    this.dialingPeers.clear();
  }

  /**
   * Send to a peer over the direct-message stream.
   * Resolves true once the frame is handed to an open stream, false if the
   * stream could not be opened or the write failed - so callers (e.g. the
   * DM retry queue) can requeue instead of messages vanishing silently.
   */
  async send(peerId: string, data: Uint8Array): Promise<boolean> {
    if (!this.node || this.isRelayPeer(peerId)) return false;
    if (peerId === this.node.peerId.toString()) return false;
    // Report success: a dropped frame looks exactly like one that was sent and
    // never arrived, which is the failure we are trying to reproduce.
    if (shouldDropFrame(data)) return true;

    const stream = this.peerStreams.get(peerId);
    if (stream) {
      // Only reuse a stream that is still open. A peer that reconnects leaves
      // the old stream closed, and the close event routinely lands after the
      // next write has already been attempted - which throws StreamStateError
      // and, worse, silently loses whatever was being sent. Dropping it here
      // makes the send fall through and open a fresh one.
      if (streamIsOpen(stream) && this.confirmedStreams.has(stream)) {
        return this.writeFrame(peerId, stream, data);
      }
      if (!streamIsOpen(stream)) this.cleanupPeerStream(peerId);
    }

    // Unconfirmed or absent stream: hold the frame and resolve only once it
    // is truly written (confirmation flush) or provably lost.
    return new Promise<boolean>((resolve) => {
      const queue = this.pendingQueues.get(peerId) ?? [];
      queue.push({ data, resolve });
      this.pendingQueues.set(peerId, queue);
      this.ensureOutboundOpen(peerId);
    });
  }

  /** Single-flight outbound stream opening for a peer. */
  private ensureOutboundOpen(peerId: string): void {
    const current = this.peerStreams.get(peerId);
    // An open stream mid-confirmation will flush the queue on its pong.
    if (current && streamIsOpen(current)) return;
    if (this.openingStreams.has(peerId)) return;
    const wrapped: Promise<void> = this.openOutboundStream(peerId)
      .catch((err) => {
        console.warn(
          `[LibP2PTransport] stream open failed for ${peerId}:`,
          err
        );
        this.emit("status", {
          type: "stream-open-failed",
          peerId: peerId.slice(-8),
          message: `Failed to open stream to peer ${peerId.slice(-8)}`,
        });
        this.failPendingQueue(peerId);
      })
      .finally(() => {
        // Identity check: after a node restart a stale open's finally() must
        // not delete the new session's in-flight entry, which would let two
        // opens race and leak the loser at the muxer.
        if (this.openingStreams.get(peerId) === wrapped) {
          this.openingStreams.delete(peerId);
        }
      });
    this.openingStreams.set(peerId, wrapped);
  }

  /** Resolve every queued frame as failed so callers requeue. */
  private failPendingQueue(peerId: string): void {
    const queue = this.pendingQueues.get(peerId);
    if (!queue) return;
    this.pendingQueues.delete(peerId);
    for (const entry of queue) entry.resolve(false);
  }

  /**
   * Returns the publish promise. Callers usually ignore it, but a leave has to
   * be flushed before the node is stopped or it never leaves the machine.
   */
  async broadcast(data: Uint8Array, roomCode: string): Promise<void> {
    if (!this.node || !this.joinedRooms.has(roomCode)) return;
    if (shouldDropFrame(data)) return;
    try {
      await this.node.services.pubsub.publish(roomTopic(roomCode), data);
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

  /**
   * The one connection to this peer that is PROVEN to work - the one their own
   * stream last arrived on - or null if we have no proof yet.
   *
   * Exposed because voice has the same problem this was built for: several
   * connections to one peerId exist at once (the relay keeps superseded
   * circuits looking open), dialProtocol picks among them arbitrarily, and a
   * stream opened on a dead one reports itself open while nothing ever
   * reaches the far side.
   */
  provenConnection(peerId: string): Connection | null {
    const conn = this.liveConnections.get(peerId);
    if (!conn || conn.status !== "open") return null;
    // Deliberately NOT bounded by freshness. The proof ages - a superseded
    // circuit keeps reporting "open" - but the fallback for a null here is
    // dialProtocol, which picks arbitrarily among the several connections a
    // peer has and lands on a dead circuit far more often than this does.
    // Returning the best available guess and letting the caller's own repair
    // loop handle a bad one beats failing open to a worse choice.
    return conn;
  }

  rooms(): string[] {
    return Array.from(this.joinedRooms);
  }

  /**
   * Emit "connect" for peers that are live but unknown to us.
   * peer:identify is a one-shot event: if it fires while we are still setting
   * up (or is missed), that peer would otherwise stay invisible forever even
   * though messages flow over it.
   */
  /**
   * Dial one peer immediately, ignoring whatever backoff it had accumulated.
   *
   * retryMissingRoomPeers doubles its wait to a minute, which is right for a
   * peer that may simply be offline and wrong for one we have just been told
   * is sitting in our call: the voice layer cannot dial a link until the peer
   * connection exists, so the backoff became the wait. Cheap to be wrong -
   * dialPeer no-ops if we are already connected.
   */
  dialNow(peerId: string): void {
    if (this.intentionalDisconnect || !this.node) return;
    if (this.connectedPeers.has(peerId) || this.dialingPeers.has(peerId)) return;
    this.nextDialAt.delete(peerId);
    this.dialBackoff.delete(peerId);
    this.dialPeer(peerId).catch(() => {});
  }

  /**
   * Reconnect anything that drifted, right now. Clears the dial backoff, so a
   * peer we had given up on for the next minute is retried immediately. Meant
   * for the moment a user returns to a page that sat in the background.
   */
  reconcileNow(): void {
    this.nextDialAt.clear();
    this.dialBackoff.clear();
    this.nextUpgradeAt.clear();
    this.upgradeBackoff.clear();
    this.reconcileConnections();
  }

  /**
   * Mark a peer as connected, discarding anything held over from a previous
   * incarnation.
   *
   * A peer that reloads comes back with the same peerId, and the stream we
   * held for it can still report itself open long after the far end is gone -
   * so every write lands in a black hole. Nothing errors, nothing retries, and
   * the peer sits there connected but deaf: no profile, no presence, no
   * history. Dropping the cached stream forces the next send to open a fresh
   * one.
   */
  private registerPeer(peerId: string): void {
    // A peer we are seeing again must not reuse the stream from its previous
    // incarnation: that stream can still report itself open while the far end
    // is gone, so every write disappears into it.
    this.cleanupPeerStream(peerId);
    // Fresh incarnation, fresh liveness: a stale miss count from before a
    // reconnect would let a single missed probe drop a healthy peer, and an
    // unseeded lastInbound made the probe fire the moment a reconciled peer
    // appeared.
    this.pingMisses.delete(peerId);
    this.lastInbound.set(peerId, Date.now());
    this.connectedPeers.add(peerId);
    this.updateRelayedStatus(peerId);
    this.nextDialAt.delete(peerId);
    this.dialBackoff.delete(peerId);
    // Same reasoning as the dial backoff above: a peer that was unreachable by
    // WebRTC ten minutes ago may be reachable now that it has reconnected, and
    // inheriting a five-minute ceiling would keep the whole session on the
    // relay.
    this.nextUpgradeAt.delete(peerId);
    this.upgradeBackoff.delete(peerId);
  }

  /** Forget a peer and tear down everything we hold for it. */
  /**
   * Ask peers that have gone quiet whether they are still there, and drop the
   * ones that do not answer.
   *
   * Nothing else in the stack notices a peer is gone. A relayed connection
   * keeps looking alive after the far end reloads or crashes - the relay holds
   * the circuit open - so libp2p reports it connected, no disconnect fires,
   * and everything we send disappears into it while both sides still look
   * fine.
   *
   * Silence-triggered, so an active room costs nothing: any inbound frame
   * counts as proof of life. Skipped entirely while the tab is hidden, where
   * there is no UI to keep honest and a phone radio to leave alone - returning
   * to the page runs a full resync anyway.
   */
  private probeSilentPeers(): void {
    if (!this.node || this.intentionalDisconnect) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    for (const peerId of [...this.connectedPeers]) {
      if (this.pinging.has(peerId)) continue;
      if (now - (this.lastInbound.get(peerId) ?? 0) < PEER_SILENCE_MS) continue;
      // A stream mid-confirmation is already being pinged on a faster clock.
      const out = this.peerStreams.get(peerId);
      if (out && streamIsOpen(out) && !this.confirmedStreams.has(out)) {
        continue;
      }
      this.pinging.add(peerId);
      const askedAt = Date.now();
      void this.send(peerId, pingFrame(++this.pingNonceCounter)).finally(() => {
        setTimeout(() => {
          this.pinging.delete(peerId);
          if (!this.connectedPeers.has(peerId)) return;
          if ((this.lastInbound.get(peerId) ?? 0) >= askedAt) return;
          // One missed answer is not proof: a slow phone looks the same as a
          // dead one, and dropping a live peer tears down a working call.
          const misses = (this.pingMisses.get(peerId) ?? 0) + 1;
          this.pingMisses.set(peerId, misses);
          if (misses < PING_MISSES_ALLOWED) return;
          console.log("[Transport] peer stopped answering:", peerId.slice(-8));
          this.debugStats.livenessDrops++;
          this.pingMisses.delete(peerId);
          this.dropPeer(peerId);
        }, PEER_PING_TIMEOUT_MS);
      });
    }
  }

  private dropPeer(peerId: string): void {
    this.debugStats.disconnects++;
    this.pingMisses.delete(peerId);
    this.nextUpgradeAt.delete(peerId);
    this.upgradeBackoff.delete(peerId);
    this.confirmNonces.delete(peerId);
    this.liveConnections.delete(peerId);
    this.connectedPeers.delete(peerId);
    this.relayedPeers.delete(peerId);
    this.lastInbound.delete(peerId);
    this.cleanupPeerStream(peerId);
    for (const c of this.node?.getConnections() ?? []) {
      if (c.remotePeer.toString() === peerId) c.close().catch(() => {});
    }
    this.emit("disconnect", peerId);
  }

  private rememberRoomPeer(room: string, peerId: string): void {
    if (!room || !peerId) return;
    const peers = this.roomPeers.get(room) ?? new Set<string>();
    peers.add(peerId);
    this.roomPeers.set(room, peers);
  }

  private reconcileConnections(): void {
    if (!this.node) return;
    const connections = this.node.getConnections();
    // Surface runaway connection growth: the relay's conn manager prunes
    // hard above its high-water mark, and a leak here reads as "peers
    // randomly disconnecting" everywhere else.
    if (connections.length > 50) {
      console.warn(
        `[Transport] high connection count: ${connections.length} ` +
          `(${this.connectedPeers.size} peers)`
      );
    }
    const byPeer = new Map<string, Connection[]>();
    for (const connection of connections) {
      const id = connection.remotePeer.toString();
      const list = byPeer.get(id);
      if (list) list.push(connection);
      else byPeer.set(id, [connection]);
      if (this.isRelayPeer(id) || this.connectedPeers.has(id)) continue;
      console.log("[Transport] reconciled missed peer:", id.slice(-8));
      this.registerPeer(id);
      this.emit("connect", id);
    }
    this.probeSilentPeers();
    this.retryMissingRoomPeers();
    this.upgradeRelayedPeers(byPeer);
  }

  /**
   * Try to promote relayed peers to a direct WebRTC connection.
   *
   * Both sides listen on /webrtc and hold a relay reservation, so the circuit
   * is only ever meant to be the signalling path for a direct connection. When
   * the first dial happens before the other side's reservation completes, the
   * fallback circuit becomes permanent - nothing ever retried the good address.
   *
   * Safe to attempt while connected. libp2p short-circuits a dial when it
   * already holds a connection, EXCEPT when that connection is indirect and
   * one of the dial addresses would be direct - which is exactly this case, so
   * the dial really happens. (Not because circuit connections are "limited":
   * our relay grants infinite limits, so they are not.)
   */
  private upgradeRelayedPeers(byPeer?: Map<string, Connection[]>): void {
    if (this.intentionalDisconnect || !this.node) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    for (const peerId of [...this.connectedPeers]) {
      // Refresh first. updateRelayedStatus only ever ran on connect events, so
      // when a direct connection died the peer stayed marked direct forever -
      // the status shown in the UI went stale, and nothing here would have
      // tried to win the direct connection back. The prefetched connection
      // map keeps this O(peers): getPeers().find() per peer serialized every
      // PeerId per iteration - profiled at over a second of CPU per tick.
      this.updateRelayedStatus(peerId, byPeer?.get(peerId));
      if (!this.relayedPeers.has(peerId)) {
        this.nextUpgradeAt.delete(peerId);
        this.upgradeBackoff.delete(peerId);
        continue;
      }
      if (this.dialingPeers.has(peerId)) continue;
      const due = this.nextUpgradeAt.get(peerId) ?? 0;
      if (now < due) continue;
      const previous = due === 0 ? 0 : (this.upgradeBackoff.get(peerId) ?? 0);
      const next = Math.min(
        Math.max(RELAY_UPGRADE_MIN_MS, previous * 2),
        RELAY_UPGRADE_MAX_MS
      );
      this.upgradeBackoff.set(peerId, next);
      this.nextUpgradeAt.set(peerId, now + next);
      this.upgradeToDirect(peerId).catch(() => {});
    }
  }

  private async upgradeToDirect(peerId: string): Promise<void> {
    if (!this.node || shouldBlockDial(peerId)) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);
    this.debugStats.relayUpgradeAttempts++;
    try {
      if (shouldBlockWebrtcDial()) throw new Error("webrtc dial blocked");
      const relayAddr = import.meta.env.VITE_RELAY_MULTIADDR as string;
      await this.node.dial(
        multiaddr(`${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`)
      );
    } catch {
      return; // still relayed; the backoff decides when to try again
    } finally {
      this.dialingPeers.delete(peerId);
    }

    this.updateRelayedStatus(peerId);
    // The dial can resolve while still handing back something relayed.
    if (this.relayedPeers.has(peerId)) return;

    this.debugStats.relayUpgrades++;
    this.nextUpgradeAt.delete(peerId);
    this.upgradeBackoff.delete(peerId);
    console.log("[Transport] upgraded to direct:", peerId.slice(-8));

    // Stop PREFERRING the circuit for outbound streams. The circuit itself is
    // left open on purpose: closing a peer's other connections regressed sync
    // twice, because both sides dial and each closed the one the other used.
    const live = this.liveConnections.get(peerId);
    if (live && live.remoteAddr.toString().includes("/p2p-circuit")) {
      this.liveConnections.delete(peerId);
    }
    // Move the traffic. resetOutboundStream, NOT cleanupPeerStream: the latter
    // fails the pending queue, and the claim that callers requeue only holds on
    // the connect path, where the app immediately re-sends profile, digest and
    // room name. An upgrade emits no event, so a failed sync batch here would
    // simply be gone. This keeps the queue and re-opens on the new connection.
    this.resetOutboundStream(peerId);
  }

  /**
   * Dial anybody the relay told us shares a room with us and who we still are
   * not connected to. The initial dials can legitimately fail - the other side
   * may not have finished its relay reservation - and without this they were
   * never retried.
   */
  private retryMissingRoomPeers(): void {
    if (this.intentionalDisconnect || !this.node) return;
    const now = Date.now();
    for (const [room, peers] of this.roomPeers) {
      if (!this.joinedRooms.has(room)) continue;
      for (const peerId of peers) {
        if (this.connectedPeers.has(peerId)) {
          this.nextDialAt.delete(peerId);
          this.dialBackoff.delete(peerId);
          continue;
        }
        if (this.dialingPeers.has(peerId)) continue;
        const due = this.nextDialAt.get(peerId) ?? 0;
        if (now < due) continue;
        // Back off from the reconcile interval up to a minute, so an offline
        // peer is not hammered while a peer that is merely slow is picked up
        // quickly.
        const previous = due === 0 ? 0 : (this.dialBackoff.get(peerId) ?? 0);
        const next = Math.min(
          Math.max(CONNECTION_RECONCILE_MS, previous * 2),
          PEER_REDIAL_MAX_MS
        );
        this.dialBackoff.set(peerId, next);
        this.nextDialAt.set(peerId, now + next);
        this.dialPeer(peerId).catch(() => {});
      }
    }
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
      this.emit("status", {
        type: "relay-connected",
        message: "Connected to relay",
      });
    } catch (err) {
      console.error("[Transport] relay dial failed:", err);
      this.emit("status", {
        type: "relay-dial-failed",
        message: "Failed to connect to relay",
      });
      throw err;
    }
  }

  private async requestRelayReservation(): Promise<void> {
    if (!this.node) return;
    const relayMa = import.meta.env.VITE_RELAY_MULTIADDR as string;
    const circuitListenAddr = multiaddr(`${relayMa}/p2p-circuit`);
    try {
      const { transportManager } = (
        this.node as unknown as WithTransportManager
      ).components;
      await transportManager.listen([circuitListenAddr]);
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

    this.emit("status", {
      type: "relay-reconnecting",
      message: "Reconnecting to relay...",
    });

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
        this.emit("status", {
          type: "relay-reconnect-failed",
          message: "Relay reconnect failed - retrying...",
        });
        this.scheduleRelayReconnect();
      }
    }, RELAY_RECONNECT_DELAY_MS);
  }

  private async openOutboundStream(
    peerId: string,
    retried = false
  ): Promise<void> {
    if (!this.node) return;

    // Open on the connection the peer most recently reached us on when we
    // have one - see liveConnections. Falling back to dialProtocol lets
    // libp2p pick (or dial fresh) when they have not reached us yet.
    const live = this.liveConnections.get(peerId);
    let stream: Stream;
    let openedOn: Connection | null = null;
    if (live && live.status === "open") {
      try {
        stream = await live.newStream(DIRECT_MSG_PROTOCOL, {
          runOnLimitedConnection: true,
        });
        openedOn = live;
        this.debugStats.liveStreamOpens++;
      } catch {
        // The proven connection died between proof and use: stop preferring
        // it and let libp2p pick or dial a working one.
        this.debugStats.openFailures++;
        if (this.liveConnections.get(peerId) === live) {
          this.liveConnections.delete(peerId);
        }
        stream = await this.node.dialProtocol(
          peerIdFromString(peerId),
          DIRECT_MSG_PROTOCOL
        );
        this.debugStats.dialStreamOpens++;
      }
    } else {
      stream = await this.node.dialProtocol(
        peerIdFromString(peerId),
        DIRECT_MSG_PROTOCOL
      );
      this.debugStats.dialStreamOpens++;
    }

    // The peer may have arrived on a NEW connection while the open was in
    // flight - a stream bound to the superseded connection would burn the
    // whole confirm budget failing. Retry once on the fresh one.
    const nowLive = this.liveConnections.get(peerId);
    if (openedOn && nowLive && nowLive !== openedOn && !retried) {
      stream.abort(new Error("connection superseded during open"));
      return this.openOutboundStream(peerId, true);
    }

    this.peerStreams.set(peerId, stream);

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      // Only clean up if WE are still the current stream. The close event of
      // a stream that was already replaced arrives late and used to wipe the
      // replacement's pending queue and opening promise - losing exactly the
      // profile reply a freshly reconnected peer was waiting on.
      if (this.peerStreams.get(peerId) === stream) {
        this.cleanupPeerStream(peerId);
      }
    });

    this.beginStreamConfirmation(peerId, stream, openedOn);
  }

  /**
   * Ping until the first pong proves the far end is reading, then flush
   * whatever queued up. See confirmedStreams for why nothing else may be
   * written before that.
   */
  private beginStreamConfirmation(
    peerId: string,
    stream: Stream,
    openedOn: Connection | null
  ): void {
    const prior = this.confirmTimers.get(peerId);
    if (prior) clearInterval(prior);

    let attempts = 0;
    this.confirmNonces.set(peerId, new Set());
    const pingOnce = () => {
      const nonce = ++this.pingNonceCounter;
      this.confirmNonces.get(peerId)?.add(nonce);
      this.writeFrame(peerId, stream, pingFrame(nonce));
    };

    const timer = setInterval(() => {
      if (
        this.peerStreams.get(peerId) !== stream ||
        this.confirmedStreams.has(stream) ||
        !streamIsOpen(stream)
      ) {
        clearInterval(timer);
        // Identity check: a superseded timer must not remove the entry the
        // NEW stream's timer registered.
        if (this.confirmTimers.get(peerId) === timer) {
          this.confirmTimers.delete(peerId);
        }
        return;
      }
      attempts++;
      if (attempts > STREAM_CONFIRM_ATTEMPTS) {
        clearInterval(timer);
        if (this.confirmTimers.get(peerId) === timer) {
          this.confirmTimers.delete(peerId);
        }
        console.log("[Transport] stream never confirmed for", peerId.slice(-8));
        this.debugStats.confirmFailures++;
        this.cleanupPeerStream(peerId);
        if (openedOn && this.liveConnections.get(peerId) === openedOn) {
          // Stop preferring the connection that just failed us.
          this.liveConnections.delete(peerId);
        }
        // Close the connection only when the peer is silent too. A slow
        // device can miss the ~5.6s ping budget while its own traffic flows
        // fine over this very connection - closing it then forces the full
        // disconnect/redial churn this feature exists to eliminate.
        const heardRecently =
          Date.now() - (this.lastInbound.get(peerId) ?? 0) < PEER_SILENCE_MS;
        if (openedOn && !heardRecently) {
          openedOn.close().catch(() => {});
        }
        return;
      }
      pingOnce();
    }, STREAM_CONFIRM_INTERVAL_MS);
    this.confirmTimers.set(peerId, timer);
    pingOnce();
  }

  /** A pong arrived: the current outbound stream provably reaches them. */
  private confirmOutboundStream(peerId: string): void {
    const stream = this.peerStreams.get(peerId);
    if (!stream || this.confirmedStreams.has(stream)) return;
    this.confirmedStreams.add(stream);
    const timer = this.confirmTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.confirmTimers.delete(peerId);
    }
    const queued = this.pendingQueues.get(peerId) ?? [];
    this.pendingQueues.delete(peerId);
    for (const entry of queued) {
      entry.resolve(this.writeFrame(peerId, stream, entry.data));
    }
  }

  private writeFrame(
    peerId: string,
    stream: Stream,
    data: Uint8Array
  ): boolean {
    if (!streamIsOpen(stream)) {
      this.cleanupPeerStream(peerId);
      return false;
    }
    try {
      const ok = stream.send(encodeFrame(data));
      this.debugStats.framesOut++;
      if (!ok) {
        stream.onDrain().catch(() => this.cleanupPeerStream(peerId));
      }
      return true;
    } catch (err) {
      console.warn(`[LibP2PTransport] write failed for ${peerId}:`, err);
      this.cleanupPeerStream(peerId);
      return false;
    }
  }

  private handleInboundStream(
    fromId: string,
    stream: Stream,
    connection?: Connection
  ): void {
    // Reset our outbound stream ONLY when the peer reaches us over a NEW
    // connection: that is the one reliable sign their previous incarnation -
    // and with it the stream we hold - is gone. Resetting on every inbound
    // stream instead caused a storm: a pong reply opens a stream, the reset
    // forces the other side to reopen, which opens a stream back, and the two
    // sides reset each other hundreds of times without a single confirmation
    // completing.
    if (connection) {
      const prev = this.liveConnections.get(fromId);
      this.liveConnections.set(fromId, connection);
      if (prev && prev !== connection) {
        this.resetOutboundStream(fromId);
      }
    }
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
        if (len > MAX_DIRECT_FRAME_BYTES) {
          console.warn(
            `[LibP2PTransport] oversized direct frame (${len}b) from ${fromId.slice(-8)}, aborting stream`
          );
          this.cleanupPeerStream(fromId);
          stream.abort(new Error("frame too large"));
          return;
        }
        if (buf.byteLength < 4 + len) break;
        const payload = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);

        // Anything at all from this peer proves it is alive.
        this.debugStats.framesIn++;
        this.lastInbound.set(fromId, Date.now());
        this.pingMisses.delete(fromId);

        // Liveness frames are ours, not the app's.
        if (payload.byteLength <= MAX_LIVENESS_FRAME_BYTES) {
          let live: { type?: string; n?: number } | null = null;
          try {
            live = JSON.parse(FRAME_DECODER.decode(payload));
          } catch {
            live = null;
          }
          if (live?.type === "__ping") {
            this.debugStats.pingsIn++;
            // Reply straight onto our outbound stream even if it is not yet
            // confirmed: the pong IS the confirmation signal, so gating it on
            // confirmation would deadlock both sides.
            const reply = pongFrame(typeof live.n === "number" ? live.n : 0);
            const out = this.peerStreams.get(fromId);
            if (out && streamIsOpen(out)) {
              this.writeFrame(fromId, out, reply);
            } else {
              void this.send(fromId, reply);
            }
            continue;
          }
          if (live?.type === "__pong") {
            this.debugStats.pongsIn++;
            // Confirm only when the echoed nonce belongs to the current
            // stream's pings.
            if (
              typeof live.n === "number" &&
              this.confirmNonces.get(fromId)?.has(live.n)
            ) {
              this.confirmOutboundStream(fromId);
            }
            continue;
          }
        }

        // null room = direct message (not pubsub)
        this.emit("message", fromId, payload, null);
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      stream.abort(new Error("remote closed"));
    });
  }

  /** Drop only the outbound stream, keeping anything queued for the retry. */
  private resetOutboundStream(peerId: string): void {
    const stream = this.peerStreams.get(peerId);
    if (!stream) return;
    this.debugStats.outboundResets++;
    this.peerStreams.delete(peerId);
    this.confirmNonces.delete(peerId);
    try {
      stream.abort(new Error("peer reopened its stream"));
    } catch {}
    // Anything already queued has no other trigger to reopen the stream, and
    // the silence probe only fires after PEER_SILENCE_MS - so without this the
    // frames would just sit there for at least that long.
    if (this.pendingQueues.get(peerId)?.length) {
      this.ensureOutboundOpen(peerId);
    }
  }

  private cleanupPeerStream(peerId: string): void {
    this.confirmNonces.delete(peerId);
    const timer = this.confirmTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.confirmTimers.delete(peerId);
    }
    const stream = this.peerStreams.get(peerId);
    if (stream) {
      stream.abort(new Error("cleanup"));
      this.peerStreams.delete(peerId);
    }
    this.failPendingQueue(peerId);
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
        message: "Failed to connect to relay - retrying...",
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
        if (len > MAX_RENDEZVOUS_FRAME_BYTES) {
          console.warn(
            `[Rendezvous] oversized frame (${len}b), aborting stream`
          );
          this.rendezvousReadBuf = new Uint8Array(0);
          stream.abort(new Error("frame too large"));
          return;
        }
        if (this.rendezvousReadBuf.byteLength < 4 + len) break;

        const payload = this.rendezvousReadBuf.slice(4, 4 + len);
        this.rendezvousReadBuf = this.rendezvousReadBuf.slice(4 + len);

        try {
          const msg = JSON.parse(
            FRAME_DECODER.decode(payload)
          ) as RendezvousServerMsg;
          this.handleRendezvousMsg(selfId, msg);
        } catch {}
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      // Only if we are still the current stream. Two reconnect paths race
      // here (this listener and the relay's peer:disconnect), so the loser is
      // left holding an open stream nobody uses - and when the relay finally
      // pruned it, its close handler wiped the LIVE stream. rendezvousSend
      // then silently no-opped, so a leaveRoom UNREGISTER was lost with no
      // retry and the relay kept telling peers we were still in the room.
      if (this.rendezvousStream !== stream) return;
      this.rendezvousStream = null;
      if (!this.intentionalDisconnect && this.node) {
        console.warn("[Rendezvous] stream closed, reconnecting");
        this.emit("status", {
          type: "rendezvous-reconnecting",
          message: "Relay disconnected - reconnecting...",
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

  private async dialPeer(peerId: string, attempt = 0): Promise<void> {
    if (!this.node || this.connectedPeers.has(peerId)) return;
    if (shouldBlockDial(peerId)) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);

    try {
      const relayAddr = import.meta.env.VITE_RELAY_MULTIADDR as string;
      const withWebRTC = multiaddr(
        `${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`
      );
      const withoutWebRTC = multiaddr(`${relayAddr}/p2p-circuit/p2p/${peerId}`);

      try {
        if (shouldBlockWebrtcDial()) throw new Error("webrtc dial blocked");
        await this.node.dial(withWebRTC);
        return;
      } catch {}

      try {
        await this.node.dial(withoutWebRTC);
      } catch (err) {
        // ponytail: 3 attempts with linear backoff; enough for transient
        // reservation races without hammering an offline peer
        if (attempt < 2 && !this.intentionalDisconnect) {
          setTimeout(
            () => this.dialPeer(peerId, attempt + 1).catch(() => {}),
            PEER_REDIAL_DELAY_MS * (attempt + 1)
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("NO_RESERVATION")) {
          console.warn(
            "[Rendezvous] both dials failed for",
            peerId.slice(-8),
            err
          );
          this.emit("status", {
            type: "peer-dial-failed",
            peerId: peerId.slice(-8),
            message: `Could not reach peer ${peerId.slice(-8)}`,
          });
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
          if (peerId === selfId) continue;
          this.rememberRoomPeer(msg.room, peerId);
          if (this.connectedPeers.has(peerId)) continue;
          this.dialPeer(peerId).catch(() => {});
        }
        break;
      }
      case "PEER_JOINED": {
        const peerId = msg.peer;
        if (peerId === selfId) break;
        this.rememberRoomPeer(msg.room, peerId);
        if (this.connectedPeers.has(peerId)) break;
        this.dialPeer(peerId).catch(() => {});
        break;
      }
      case "PEER_LEFT": {
        // Stop retrying somebody who has gone.
        this.roomPeers.get(msg.room)?.delete(msg.peer);
        this.nextDialAt.delete(msg.peer);
        break;
      }
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

        this.emit("status", {
          type: "reservation-timeout",
          message: "Relay reservation timed out - you may not be reachable",
        });
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

  private updateRelayedStatus(
    peerId: string,
    prefetched?: Connection[]
  ): void {
    if (!this.node) return;
    let connections = prefetched;
    if (!connections) {
      const pid = this.node.getPeers().find((p) => p.toString() === peerId);
      // getConnections(undefined) returns EVERY connection in the node, relay
      // included, which reads as "direct" and silently answers a question we
      // cannot answer. A peer with no connections has no status.
      if (pid == null) return;
      connections = this.node.getConnections(pid);
    }
    if (!connections?.length) return;

    // Not a substring test on the address. A direct WebRTC connection is
    // DIALLED through the relay for signalling, so the dialer's own side keeps
    // `.../p2p-circuit/webrtc/p2p/<peer>` as its remoteAddr - which contains
    // "/p2p-circuit" while being exactly the direct connection we wanted. That
    // made every upgrade look like it had failed on the side that performed
    // it, so the traffic never moved off the circuit. libp2p already answers
    // this properly: it sets `direct` from a real circuit matcher when the
    // connection is built, so use its answer rather than a second, wrong one.
    const hasDirect = connections.some((c) => c.direct);

    if (hasDirect) this.relayedPeers.delete(peerId);
    else this.relayedPeers.add(peerId);
  }

  private async privateKeyFromRawKey(privateKeyBytes: Uint8Array) {
    return keys.generateKeyPairFromSeed("Ed25519", privateKeyBytes);
  }

  /** App-level toast through the same pipe the transport statuses use. */
  announce(status: TransportStatus): void {
    this.emit("status", status);
  }

  private emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): void {
    // Suppressing "connect" reproduces the case where one side reloads and the
    // other never notices, so it never re-sends anything about itself.
    if (shouldSuppressEvent(event as string)) return;
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
