import { isConfigured, relayMultiaddr } from "$lib/runtime-config";
import { reservationClockWarning } from "$lib/clock-health";
import { createLibp2p, type Libp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import { identify, type Identify } from "@libp2p/identify";
import { gossipsub, type GossipSub } from "@libp2p/gossipsub";
import { keys } from "@libp2p/crypto";
import { peerIdFromString } from "@libp2p/peer-id";
import { deriveRoomKeys, discoveryIdOf, type DiscoveryId, type RoomKeys, type RoomSecret } from "$lib/room-security/keys";
import { attachRoomStream, ROOM_PROTOCOL } from "$lib/room-security/stream";
import type { SecureRoomChannel } from "$lib/room-security/channel";
import { attachDmIntroduction, DM_INTRODUCTION_PROTOCOL } from "$lib/room-security/dm-introduction-stream";
import { LobbyDialBudget } from "./dm-lobby-budget";
import { FrameAssembler, FrameTooLargeError } from "./frame-assembler";
import { RoomOpenings } from "./room-openings";
import type { DmPqState } from "$lib/room-security/pq-dm";
import { ROOM_SECURITY_V2_RELEASED } from "$lib/room-security/invitation-release";
import { onIdentityLock, type UnlockedSession } from "$lib/identity/identity";
import { roomSfuAdmission } from "$lib/room-security/sfu";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { Connection, Stream } from "@libp2p/interface";
import type { StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";
import { errText, ev } from "$lib/telemetry/event";
import { beginSession, rec, refs } from "$lib/telemetry/recorder";
import { isBenignStreamRejection, recTransportEvent } from "$lib/telemetry/taps";

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

/**
 * How long to wait for the circuit address to appear. Matched to the
 * circuit transport's own `reservationCompletionTimeout` below: at 10s this
 * gave up while libp2p was still legitimately reserving, so a slow relay
 * (or a phone that just woke its radio) reported "not reachable" for a
 * reservation that landed a second later.
 */
const RELAY_RESERVATION_TIMEOUT_MS = 20_000;
/** Reservation attempts per relay reconnect before the node is rebuilt. */
const RELAY_RESERVATION_ATTEMPTS = 3;
const DIRECT_MSG_PROTOCOL = "/app/direct/1.0.0";
const RENDEZVOUS_PROTOCOL = "/awful/rendezvous/2.0.0";
// Upper bound on a single length-prefixed frame. A peer declares the length
// up front, so without a cap a malicious 4-byte length forces us to buffer
// gigabytes waiting for bytes that never come. Direct-stream frames carry app
// messages (profiles-with-avatar, sync batches); rendezvous frames are tiny
// REGISTER/UNREGISTER JSON.
const MAX_DIRECT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RENDEZVOUS_FRAME_BYTES = 16 * 1024;
const PEER_REDIAL_DELAY_MS = 3_000;
const PEER_REDIAL_MAX_MS = 60_000;
/**
 * First relay-reconnect delay, and the ceiling it backs off to.
 *
 * A flat 3s meant a phone whose relay is genuinely down re-dialled twenty
 * times a minute for as long as the app was open - a radio held awake for
 * nothing. Jittered like every other backoff here, and reset to the base as
 * soon as a reconnect actually succeeds.
 */
const RELAY_RECONNECT_DELAY_MS = 3_000;
const RELAY_RECONNECT_MAX_MS = 60_000;
// The FIRST relay dial gets retries of its own. libp2p's dial has no
// failure cooldown, so a re-dial genuinely re-attempts, and a browser that
// just woke a radio, switched networks or lost a TLS handshake fails the
// first one routinely. Without this, one transient WebSocket error made
// connect() throw - the app papered over it with its own connect retry, but
// device sync had no such net and simply died ("relay dial failed").
const RELAY_DIAL_ATTEMPTS = 4;
const RELAY_DIAL_BASE_MS = 700;
const RELAY_DIAL_MAX_MS = 6_000;
const CONNECTION_RECONCILE_MS = 5_000;
/**
 * Upstream libp2p's own grace period for `connection.close()` to finish
 * (`@libp2p/connection-manager`'s `CONNECTION_CLOSE_TIMEOUT`). A connection
 * dropPeer just closed still shows up in `getConnections()` for up to this
 * long - the window a reconcile tick can walk into and re-register a peer
 * whose old connection has not actually gone yet.
 */
const CONNECTION_CLOSE_TIMEOUT_MS = 1_000;
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
const DRAIN_BUDGET_BASE_MS = 30_000;
const DRAIN_BUDGET_FLOOR_BYTES_PER_MS = 20;
function drainBudgetMs(bytes: number): number {
  return DRAIN_BUDGET_BASE_MS + bytes / DRAIN_BUDGET_FLOOR_BYTES_PER_MS;
}
/**
 * How long probeSilentPeers waits before judging one missed probe,
 * independent of the send() promise it rides on. A stream that never
 * confirms holds the ping on the pending queue for the whole confirm
 * budget before send() resolves at all - chaining the release to that
 * promise doubled the stated timeout, and an unbounded queue could pin it
 * forever. This is the stated bound instead.
 */
const PEER_PROBE_RELEASE_MS =
  STREAM_CONFIRM_INTERVAL_MS * STREAM_CONFIRM_ATTEMPTS + PEER_PING_TIMEOUT_MS;
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
  // `w` is this side's wall clock at reply time. The pong is built inline on
  // the receive path, so one timestamp serves as both the NTP t1 (received)
  // and t2 (sent) - it makes the ping path double as a clock-offset probe
  // (measureClock) for watch-together sync. Old peers ignore the field, and
  // a pong without it simply yields no clock sample.
  return new TextEncoder().encode(
    JSON.stringify({ type: "__pong", n: nonce, w: Date.now() })
  );
}
/**
 * First rendezvous retry, and the ceiling it backs off to.
 *
 * A flat 2s turned a relay restart into every client re-dialling it every
 * two seconds, in lockstep, for as long as it was down - and all of them at
 * once the moment it came back. Jittered and doubling like the relay
 * reconnect, and back to the first delay once a stream has proven itself.
 */
const RENDEZVOUS_RECONNECT_DELAY_MS = 2_000;
const RENDEZVOUS_RECONNECT_MAX_MS = 60_000;
/**
 * How often a registered rendezvous stream proves it is alive. The relay
 * closes a registered stream that stays quiet for three intervals
 * (`rendezvousLivenessTimeout` in relay/main.go), so this number is a
 * contract with the relay: raising it eats the two-miss margin.
 */
const RENDEZVOUS_PING_INTERVAL_MS = 20_000;
/**
 * Unanswered PINGs before the rendezvous stream is called half-open.
 *
 * The relay answers PING with PONG. A phone that changes network keeps the
 * socket looking open in both directions while nothing crosses it, and
 * nothing else in this file ever notices: the reads simply stop. Two misses
 * is 40s of silence on a link that should speak every 20s.
 */
const RENDEZVOUS_PONG_MISSES_ALLOWED = 2;
/** Lobby peers waiting out DM_LOBBY_INTRODUCE_DELAY_MS at once, at most. */
const DM_LOBBY_PENDING_MAX = 32;
/** Grace for an already-upgraded peer to show up in the post-quantum room. */
const DM_LOBBY_INTRODUCE_DELAY_MS = 5_000;
/**
 * DM lobbies register this long after being held: past the relay's one-minute
 * empty-register window (maxEmptyRegisters in relay/main.go), so the room
 * joins that caused them spend that window's budget, not the lobbies.
 */
const DM_LOBBY_REGISTER_DELAY_MS = 70_000;
/** Lobbies held at once; each is a registration, usually into an empty room. */
const DM_LOBBY_MAX = 64;
/** Budget for the one-off liveness probe a network change triggers. */
const RELAY_LIVENESS_TIMEOUT_MS = 5_000;
/**
 * Room channels - one /awful/room/2.0.0 stream per room and peer - that one
 * connection may hold once they have proven their room, and the handshakes
 * it may have under way on top. Both used to share one cap of 32, counting
 * both directions, and libp2p's own default is 32 inbound streams per
 * protocol: two devices sharing a 17th room could not open it at all, and a
 * user's own phone and laptop share every room. libp2p is told the same
 * numbers (handleRoomStreams); an older peer still holds us to its 32.
 */
const ROOM_CHANNELS_PER_CONNECTION = 256;
const ROOM_HANDSHAKES_PER_CONNECTION = 64;
/**
 * Proven room channels held at once. Past this the least recently used one
 * that has carried nothing for ROOM_CHANNEL_QUIET_MS is closed; its member
 * stays a member, and the next send to them opens a fresh channel
 * (trimRoomChannels).
 */
const ROOM_CHANNELS_MAX = 1024;
const ROOM_CHANNEL_QUIET_MS = 30_000;
/** Inbound handshakes under way at once, across every connection. */
const ROOM_HANDSHAKES_MAX = 256;
/**
 * How long after our channel to a peer with a larger ID proves itself a
 * fresh stream of theirs for the same room may still be the one they opened
 * as ours crossed it - the handshake's own 10 s (admitRoomStream).
 */
const ROOM_CROSSING_MS = 10_000;
/** Room channels being opened at once, and how many more may wait a turn. */
const ROOM_OPENINGS_MAX = 64;
const ROOM_OPENINGS_QUEUED_MAX = 4096;
/** Retrying a pair the relay lists in a room that has not proven it yet. */
const ROOM_PROVE_RETRY_MS = 5_000;
const ROOM_PROVE_RETRY_MAX_MS = 5 * 60_000;

type RendezvousClientMsg =
  | { type: "REGISTER"; room: string }
  | { type: "UNREGISTER"; room: string }
  | { type: "PING" };

type RendezvousServerMsg =
  | { type: "PEERS"; room: string; peers: string[] }
  | { type: "PEER_JOINED"; room: string; peer: string }
  | { type: "PEER_LEFT"; room: string; peer: string }
  | { type: "PONG" };

/** One room stream, opened by either end, before and after it proves its room. */
type RoomStreamEntry = {
  connection: Connection;
  peer: string;
  /** We opened it. */
  outgoing: boolean;
  /** From the start when we open it, from its hello when they do. */
  room: DiscoveryId | null;
  /** Set once both ends have proven the room. */
  channel: SecureRoomChannel | null;
  /** Last send or receipt, for choosing which idle channel to close first. */
  usedAt: number;
  /** When it proved its room. */
  provenAt: number;
  /** Closed by us because the peer's own stream for the room won (admitRoomStream). */
  superseded: boolean;
  /** Ours, let stay beside this inbound one until this one proves its room too (admitRoomStream). */
  replaces: RoomStreamEntry | null;
  /** The relay said its peer left the room after it proved (ensureSecureRoom). */
  departed: boolean;
  close: () => void;
  getChannel: () => SecureRoomChannel | null;
};

/**
 * `navigator.connection`, which is not in lib.dom yet. A phone hopping
 * between wifi and cellular fires `change` here and nothing else - no
 * offline, no socket close, no error.
 */
interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
  readonly effectiveType?: string;
}

function roomTopic(roomCode: string) {
  return `app:room:${roomCode}`;
}

/**
 * The handle a timer returns. The browser hands back a number and Node hands
 * back an object, and @types/node is in scope here, so the type is named once
 * rather than spelled out at every field that holds one.
 */
type TimerHandle = ReturnType<typeof setInterval>;

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
  private dmIdentity: () => UnlockedSession | null = () => null;
  private dmIdentityManaged = false;
  private dmSessions = new Map<string, UnlockedSession>();
  private dmCurrent(room: string): boolean {
    const local = this.localRoom(room);
    return !local.startsWith("dm-") || !this.dmIdentityManaged ||
      (!!this.dmIdentity() && this.dmSessions.get(local) === this.dmIdentity());
  }
  private dmVerified: (peer: string, did: string, secret: RoomSecret, pqPending: boolean) => Promise<void> = async () => {};
  private dmUpgraded: ((peer: string, did: string, state: DmPqState) => Promise<void>) | undefined;
  private dmIntroductions = new Map<Connection, { close: () => void; ready: Promise<boolean>; outgoing: boolean }>();
  private dmOpening = new Map<string, Promise<boolean>>();

  /**
   * `upgraded` receives a DM's post-quantum state once an introduction has
   * agreed on one with that peer (room-security/pq-dm.ts); without it this
   * device still answers introductions, but never upgrades a conversation.
   * `pqPending` tells `verified` such an upgrade is about to follow.
   */
  setDmIntroduction(identity: () => UnlockedSession | null,
    verified: (peer: string, did: string, secret: RoomSecret, pqPending: boolean) => Promise<void>,
    upgraded?: (peer: string, did: string, state: DmPqState) => Promise<void>): void {
    this.dmIdentity = identity; this.dmVerified = verified; this.dmUpgraded = upgraded; this.dmIdentityManaged = true;
  }

  private attachIntroduction(stream: Stream, connection: Connection, initiate?: { expectedDid?: string }) {
    for (const [conn, handle] of this.dmIntroductions) if (conn.status !== "open") handle.close();
    const existing = this.dmIntroductions.get(connection);
    if (existing) {
      // Simultaneous first contact converges on the smaller device's stream.
      if (!initiate && existing.outgoing && this.selfId() > connection.remotePeer.toString()) existing.close();
      else { stream.abort(new Error("Introduction already pending")); return initiate ? existing : null; }
    }
    if (this.dmIntroductions.size >= 32 || !this.dmIdentity()) {
      stream.abort(new Error("Introduction unavailable")); return null;
    }
    const upgraded = this.dmUpgraded;
    const handle = attachDmIntroduction({ stream, connection, local: this.selfId(),
      identity: this.dmIdentity, initiate,
      verified: (did, secret, pqPending) => this.dmVerified(connection.remotePeer.toString(), did, secret, pqPending),
      upgraded: upgraded && ((did, state) => upgraded(connection.remotePeer.toString(), did, state)),
      onClose: () => { this.dmIntroductions.delete(connection); },
    });
    this.dmIntroductions.set(connection, { ...handle, outgoing: !!initiate });
    return handle;
  }

  /** Synchronous revocation hook for lock/logout, before asynchronous teardown. */
  clearRoomSecurity(): void {
    for (const handle of this.dmIntroductions.values()) handle.close();
    for (const room of [...this.secureRooms.keys()]) this.leaveRoom(room);
    for (const localId of [...this.dmLobbyOf.keys()]) this.releaseDmLobby(localId);
    if (this.lobbyRegisterTimer) clearTimeout(this.lobbyRegisterTimer);
    this.lobbyRegisterTimer = null;
    this.lobbyBudget.clear();
    this.lobbyPending.clear();
    this.dmSessions.clear();
    this.secureOpening.clear();
    this.roomOpenings.clear();
    this.roomMembers.clear();
    this.roomProveRetry.clear();
  }

  introduceDm(peer: string, expectedDid?: string): Promise<boolean> {
    const existing = this.dmOpening.get(peer);
    if (existing) return existing;
    const node = this.node, identity = this.dmIdentity();
    if (!node || !identity || this.dmOpening.size >= 32 || this.isRelayPeer(peer)) return Promise.resolve(false);
    const job = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await this.dialPeer(peer);
      if (node !== this.node || identity !== this.dmIdentity()) return false;
      const connection = await node.dial(peerIdFromString(peer), { signal });
      const stream = await connection.newStream(DM_INTRODUCTION_PROTOCOL, { signal, runOnLimitedConnection: true });
      if (node !== this.node || identity !== this.dmIdentity()) { stream.abort(new Error("Session ended")); return false; }
      return await (this.attachIntroduction(stream, connection, { expectedDid })?.ready ?? false);
    })().catch(() => false).finally(() => { if (this.dmOpening.get(peer) === job) this.dmOpening.delete(peer); });
    this.dmOpening.set(peer, job); return job;
  }
  private secureRooms = new Map<DiscoveryId, RoomKeys>();
  private unobserveLock: (() => void) | null = null;
  private lifecycleGeneration = 0;
  // Local conversation references never become network discovery identifiers.
  // Retain bindings after leave/disconnect: stale sends must fail closed rather
  // than interpreting a previously protected reference as a legacy room.
  private secureAliases = new Map<string, DiscoveryId>();
  private secureLocalIds = new Map<DiscoveryId, string>();

  private wireRoom(room: string): string {
    return this.secureAliases.get(room) ?? room;
  }

  private localRoom(room: string): string {
    return this.secureLocalIds.get(room as DiscoveryId) ?? room;
  }

  isSecureRoom(room: string): boolean {
    return room.startsWith("dm-") || this.wireRoom(room).startsWith("rd2_");
  }

  /**
   * Keep an existing DM storage ID while using a private capability on wire.
   *
   * `classical` is passed when `secret` is the conversation's post-quantum
   * secret (room-security/pq-dm.ts): it names the classical discovery ID the
   * conversation is anchored at, whether or not it was ever joined there.
   * That anchor is what allows moving a conversation that is live under its
   * classical secret onto a post-quantum one in place - and only that way
   * round: once bound post-quantum, a join with the classical secret alone
   * is a conflict, exactly like any other capability swap, so a stale caller
   * cannot drag the conversation back.
   */
  joinSecureConversation(localId: string, secret: RoomSecret, classical?: RoomSecret, peerDid?: string): DiscoveryId {
    if (!/^dm-[a-f0-9]{40}$/.test(localId)) throw new Error("Invalid local DM reference");
    const session = this.dmIdentity();
    if (this.dmIdentityManaged && !session) throw new Error("Identity locked");
    if (this.dmSessions.has(localId) && this.dmSessions.get(localId) !== session) this.leaveRoom(localId);
    const discoveryId = discoveryIdOf(secret);
    const anchor = classical ? discoveryIdOf(classical) : discoveryId;
    if (classical && anchor === discoveryId) throw new Error("Post-quantum secret is the classical one");
    const previous = this.secureAliases.get(localId);
    const owner = this.secureLocalIds.get(discoveryId);
    const known = this.dmAnchors.get(localId);
    const anchorOwner = this.secureLocalIds.get(anchor);
    const upgrade = !!classical && !!previous && previous !== discoveryId &&
      (previous === anchor || known === anchor);
    if ((known && known !== anchor) || (anchorOwner && anchorOwner !== localId) ||
        (previous && previous !== discoveryId && !upgrade) || (owner && owner !== localId)) {
      throw new Error("Conflicting conversation capability");
    }
    if (!previous && this.secureAliases.size >= 512) throw new Error("Conversation binding limit");
    if (!previous && this.joinedRooms.has(localId)) {
      throw new Error("Leave legacy discovery before binding a protected conversation");
    }
    // Leave the old wire room first: nothing may go out under the classical
    // key once the post-quantum one exists.
    if (upgrade) this.leaveRoom(localId);
    this.secureAliases.set(localId, discoveryId);
    this.secureLocalIds.set(discoveryId, localId);
    this.secureLocalIds.set(anchor, localId);
    this.dmAnchors.set(localId, anchor);
    if (session) this.dmSessions.set(localId, session);
    if (classical && peerDid) this.holdDmLobby(localId, anchor, peerDid);
    return this.joinSecureRoom(secret);
  }

  /**
   * DM lobbies. A device whose conversation went post-quantum stops joining
   * it under the classical discovery ID - but the other side's devices that
   * have not upgraded yet (one that was offline, a sibling restored later)
   * still meet there, and nowhere else. Left alone they would never find an
   * upgraded device again: no shared room, so no profile, so nothing to
   * start the introduction that would upgrade them too.
   *
   * So the classical ID stays registered at the rendezvous as a lobby: never
   * joined as a room (no keys, no traffic - a peer trying to open the
   * classical room with us is refused like any non-member), only watched.
   * Whoever turns up there is dialled and introduced, which upgrades them if
   * they can be and merely re-binds their DID if they cannot (an older
   * build). Bounded per peer, per lobby and overall (dm-lobby-budget.ts), so
   * an older build is not re-introduced on every rendezvous reply and a
   * relay listing made-up peers gets only a handful of dials out of us.
   *
   * Lobbies are second-class registrations, on purpose. The relay allows a
   * peer only so many REGISTERs into empty rooms a minute
   * (maxEmptyRegisters), and a lobby is usually empty - so a lobby must never
   * crowd out a real room. They are registered in one batch well after
   * whatever burst of room joins caused them, in a later budget window, and
   * at most DM_LOBBY_MAX of them. A conversation past the cap still works;
   * it only loses this way of finding stragglers.
   *
   * The relay decides who is listed in a lobby, so it would decide whom we
   * dial and introduce. The introduction therefore expects the one identity
   * the conversation is with, and ends for anyone else before binding them.
   */
  private dmAnchors = new Map<string, DiscoveryId>();
  private dmLobbyOf = new Map<string, DiscoveryId>();
  private dmLobbies = new Map<DiscoveryId, { localId: string; peerDid: string }>();
  private lobbyRegistered = new Set<DiscoveryId>();
  private lobbyRegisterTimer: TimerHandle | null = null;
  /** Who we may still introduce from a lobby - see dm-lobby-budget.ts. */
  private lobbyBudget = new LobbyDialBudget();
  private lobbyPending = new Set<string>();

  /** Hold (or keep) this conversation's classical ID as a lobby. */
  holdDmLobby(localId: string, anchor: DiscoveryId, peerDid: string): void {
    const held = this.dmLobbies.get(anchor);
    if (this.dmLobbyOf.get(localId) === anchor && held?.peerDid === peerDid) return;
    this.releaseDmLobby(localId);
    if (this.dmLobbies.size >= DM_LOBBY_MAX) return;
    this.dmLobbyOf.set(localId, anchor);
    this.dmLobbies.set(anchor, { localId, peerDid });
    this.scheduleLobbyRegistration();
  }

  private scheduleLobbyRegistration(): void {
    if (this.lobbyRegisterTimer) return;
    this.lobbyRegisterTimer = setTimeout(() => {
      this.lobbyRegisterTimer = null;
      for (const room of this.dmLobbies.keys()) {
        if (this.lobbyRegistered.has(room) || this.joinedRooms.has(room)) continue;
        this.lobbyRegistered.add(room);
        this.rendezvousSend({ type: "REGISTER", room });
      }
    }, DM_LOBBY_REGISTER_DELAY_MS);
  }

  private releaseDmLobby(localId: string): void {
    const anchor = this.dmLobbyOf.get(localId);
    if (!anchor) return;
    this.dmLobbyOf.delete(localId);
    this.dmLobbies.delete(anchor);
    this.lobbyBudget.forgetLobby(anchor);
    if (this.lobbyRegistered.delete(anchor) && !this.joinedRooms.has(anchor)) {
      this.rendezvousSend({ type: "UNREGISTER", room: anchor });
    }
  }

  /** A lobby is watched, never joined; a room joined for real is not one. */
  private isDmLobby(room: string): boolean {
    return this.dmLobbies.has(room as DiscoveryId) && !this.joinedRooms.has(room);
  }

  private lobbyPeer(room: DiscoveryId, peer: string): void {
    const lobby = this.dmLobbies.get(room);
    if (!lobby || !peer || peer === this.selfId() || this.isRelayPeer(peer)) return;
    const { localId, peerDid } = lobby;
    // The relay chooses who is listed here, so the cheap checks come first
    // and bound what a listing of thousands of made-up peers can cost: one
    // wait per peer, and only so many waiting at once.
    if (this.lobbyPending.has(peer) || this.lobbyPending.size >= DM_LOBBY_PENDING_MAX ||
        !this.lobbyBudget.mayTry(peer)) return;
    this.lobbyPending.add(peer);
    // A device that has upgraded is in the lobby too and will be in the
    // post-quantum room with us moments later: give that the chance to land
    // before paying for an introduction that would change nothing. The
    // budget is spent only on a real dial, so those devices - every one of
    // the other side's upgraded devices shows up here - never use it up.
    setTimeout(() => {
      this.lobbyPending.delete(peer);
      if (this.dmLobbies.get(room) !== lobby || this.isRoomPeer(localId, peer)) return;
      if (!this.lobbyBudget.allow(room, peer)) return;
      void this.introduceDm(peer, peerDid);
    }, DM_LOBBY_INTRODUCE_DELAY_MS);
  }
  private secureOpening = new Map<string, Promise<SecureRoomChannel | null>>();
  private secureStreams = new Set<RoomStreamEntry>();
  private roomOpenings = new RoomOpenings(ROOM_OPENINGS_MAX, ROOM_OPENINGS_QUEUED_MAX);
  /**
   * Who has proven each room to us, and over which connection it last did.
   *
   * peersInRoom used to be the set of open channels, so a channel that
   * closed took its member with it - and every room path gates on
   * peersInRoom, so that member silently stopped hearing from us: no chat,
   * typing, presence or sync, until the relay happened to list them again.
   * Channels close for plenty of reasons that are not the member leaving: we
   * close idle ones past ROOM_CHANNELS_MAX, the other end does the same, a
   * write stalls. So membership lives here, counted while the member stays
   * connected, and the next send opens a fresh channel, which proves it
   * again. It ends when we leave the room, when the relay says they left,
   * or when a fresh channel is refused.
   */
  private roomMembers = new Map<DiscoveryId, Map<string, Connection>>();
  /** "room\npeer" -> the next try for a pair the relay lists that has not proven the room. */
  private roomProveRetry = new Map<string, { at: number; delay: number }>();
  private roomRefusalWarnedAt = new Map<string, number>();
  /** When idle channels close (trimRoomChannels); a field so tests can bring it closer. */
  private roomChannelLimits = {
    total: ROOM_CHANNELS_MAX, perConnection: ROOM_CHANNELS_PER_CONNECTION, idleMs: ROOM_CHANNEL_QUIET_MS,
  };
  private roomTrimQueued = false;

  /** Explicit v2 API: only the derived public ID reaches rendezvous. */
  joinSecureRoom(secret: RoomSecret): DiscoveryId {
    this.unobserveLock ??= onIdentityLock(() => { void this.disconnect(); });
    const keys = deriveRoomKeys(secret);
    if (this.secureRooms.has(keys.discoveryId)) return keys.discoveryId;
    this.secureRooms.set(keys.discoveryId, keys);
    this.joinRoom(keys.discoveryId);
    return keys.discoveryId;
  }

  private attachSecureStream(stream: Stream, connection: Connection, initiate?: RoomKeys): RoomStreamEntry | null {
    for (const old of this.secureStreams) if (old.connection.status !== "open") old.close();
    const peer = connection.remotePeer.toString();
    if (!initiate) {
      // A handshake is what anybody who can reach us can make us hold, so
      // handshakes are what is capped here. Channels that have proven a
      // room are bounded by closing idle ones instead (trimRoomChannels).
      let total = 0, here = 0;
      for (const entry of this.secureStreams) {
        if (entry.outgoing || entry.channel) continue;
        total++;
        if (entry.connection === connection) here++;
      }
      if (total >= ROOM_HANDSHAKES_MAX || here >= ROOM_HANDSHAKES_PER_CONNECTION) {
        this.noteRoomRefusal("handshakes", peer);
        stream.abort(new Error("Room connection limit"));
        return null;
      }
    }
    const entry: RoomStreamEntry = {
      connection, peer, outgoing: !!initiate, room: initiate?.discoveryId ?? null, channel: null,
      usedAt: Date.now(), provenAt: 0, superseded: false, replaces: null, departed: false,
      close: () => {}, getChannel: () => null,
    };
    this.secureStreams.add(entry);
    const handle = attachRoomStream({
      stream, connection, local: this.selfId(), rooms: this.secureRooms, initiate,
      admit: (room) => this.admitRoomStream(entry, room),
      onReady: (room, channel) => {
        if (!this.secureRooms.has(room) || !this.dmCurrent(room)) { entry.close(); return; }
        entry.room = room; entry.channel = channel; entry.usedAt = entry.provenAt = Date.now();
        // Theirs proved, so it was no crossing: their end of ours is gone.
        entry.replaces?.close();
        entry.replaces = null;
        // News only. A channel reopened for a member already counted changes
        // nothing the app can see, and announcing it would replay the app's
        // whole catch-up for that member on every reopen.
        if (this.noteRoomMember(room, peer, connection)) this.emit("roomPeers", this.localRoom(room), [peer]);
        if (this.trimRoomChannels() && !this.roomTrimQueued) {
          // Channels proven in the same burst are still finishing their last
          // handshake frame: one more pass once they have, not at the next tick.
          this.roomTrimQueued = true;
          setTimeout(() => { this.roomTrimQueued = false; this.trimRoomChannels(); }, 0);
        }
      },
      onData: (room, data) => {
        entry.usedAt = Date.now();
        if (this.secureRooms.has(room) && this.dmCurrent(room) && connection.status === "open") {
          this.emit("message", peer, data, this.localRoom(room));
        }
      },
      onClose: () => { this.secureStreams.delete(entry); },
    });
    entry.close = handle.close;
    entry.getChannel = handle.getChannel;
    return entry;
  }

  /**
   * An inbound stream has named its room: keep it, or refuse it.
   *
   * Both ends of a pair learn of each other from the same rendezvous reply
   * and open a channel at the same moment, so every pair ended up holding
   * two - twice the streams against every limit - and nothing ever closed
   * the spare. Simultaneous opening now converges on the stream the smaller
   * peer ID started, as DM introductions do, so both ends reach the same
   * answer without a word about it. Any other stream the peer already had
   * for the room gives way to the new one: a peer opens another only when
   * its end of the first is gone - it reloaded, or closed it as idle and
   * the reset has not landed here yet.
   *
   * Except ours, when we are the smaller peer, for ROOM_CROSSING_MS after it
   * proved. Over two connections the larger peer's hello can land after
   * ours has proven itself, by when they have closed that stream in ours'
   * favour - and closing ours for it left neither end a channel, with what
   * was sent on ours in between reported sent and lost. So theirs is let in
   * beside ours and takes over only once it proves too: one they gave up
   * never does, and one they opened because their end of ours is gone does.
   */
  private admitRoomStream(entry: RoomStreamEntry, room: DiscoveryId): boolean {
    for (const other of [...this.secureStreams]) {
      if (other === entry || other.room !== room || other.peer !== entry.peer || other.connection.status !== "open") continue;
      if (other.outgoing && this.selfId() < entry.peer) {
        if (!other.channel) return false;
        if (Date.now() - other.provenAt < ROOM_CROSSING_MS) { entry.replaces = other; continue; }
      }
      other.superseded = other.outgoing && !other.channel;
      other.close();
    }
    entry.room = room;
    return true;
  }

  /**
   * Count a member in; true when that is news - a new member, or one on a
   * different connection than before, which is what a reload looks like
   * (the relay keeps the old circuit reading "open" for a while).
   */
  private noteRoomMember(room: DiscoveryId, peer: string, connection: Connection): boolean {
    let members = this.roomMembers.get(room);
    if (!members) this.roomMembers.set(room, members = new Map());
    const before = members.get(peer);
    members.set(peer, connection);
    this.roomProveRetry.delete(`${room}\n${peer}`);
    return before !== connection;
  }

  /** The proven channel a peer has with us for a room, on a connection still open. */
  private liveRoomChannel(room: DiscoveryId, peer: string): RoomStreamEntry | null {
    for (const entry of this.secureStreams) {
      if (entry.room === room && entry.peer === peer && entry.channel?.verified &&
          entry.connection.status === "open") return entry;
    }
    return null;
  }

  /** A handshake under way between us for a room - theirs or ours. */
  private roomHandshake(room: DiscoveryId, peer: string): SecureRoomChannel | null {
    for (const entry of this.secureStreams) {
      if (entry.room !== room || entry.peer !== peer || entry.channel || entry.connection.status !== "open") continue;
      const pending = entry.getChannel();
      if (pending) return pending;
    }
    return null;
  }

  private isRoomMember(room: DiscoveryId, peer: string): boolean {
    return (this.roomMembers.get(room)?.has(peer) === true && this.connectedPeers.has(peer)) ||
      this.liveRoomChannel(room, peer) !== null;
  }

  /**
   * Close the least recently used idle room channels past the limits, and
   * say whether any limit is still exceeded.
   *
   * Their members stay members (roomMembers) and the next send to them
   * opens a fresh channel, so running out of room costs a handshake, never a
   * member. Only a channel that has carried nothing either way for a while
   * is closed: the other end cannot see it coming, and a frame it sent the
   * moment ours closed would be lost - the quieter the channel, the less
   * likely that is. One in use waits for a later pass, so the limits bend
   * for real traffic instead of churning it.
   */
  private trimRoomChannels(): boolean {
    const { total, perConnection, idleMs } = this.roomChannelLimits;
    if (this.secureStreams.size <= Math.min(total, perConnection)) return false;
    const quietSince = Date.now() - idleMs;
    const closeIdle = (entries: RoomStreamEntry[], limit: number): number => {
      let excess = entries.filter((e) => e.channel?.verified).length - limit;
      if (excess <= 0) return 0;
      const idle = entries.filter((e) => e.channel?.idle && e.usedAt <= quietSince).sort((a, b) => a.usedAt - b.usedAt);
      for (const entry of idle) {
        if (excess <= 0) break;
        excess--;
        this.debugStats.roomChannelsClosedIdle++;
        entry.close();
      }
      return excess;
    };
    const proven = [...this.secureStreams].filter((e) => e.channel?.verified);
    let over = closeIdle(proven, total);
    const byConnection = new Map<Connection, RoomStreamEntry[]>();
    for (const entry of proven) {
      const list = byConnection.get(entry.connection);
      if (list) list.push(entry);
      else byConnection.set(entry.connection, [entry]);
    }
    for (const entries of byConnection.values()) over += closeIdle(entries, perConnection);
    return over > 0;
  }

  /**
   * A room channel we could not have, said out loud. These were silent: the
   * member simply never heard from us in that room, and nothing anywhere
   * said why.
   */
  private noteRoomRefusal(reason: "handshakes" | "queue" | "refused", peer: string, room?: DiscoveryId): void {
    this.debugStats.roomChannelRefusals++;
    rec(ev("session.config", {
      sev: "warn", peer, room: room ? refs().roomRef(room) : null, d: { roomChannel: "refused", reason },
    }));
    const now = Date.now();
    if (now - (this.roomRefusalWarnedAt.get(reason) ?? 0) < 30_000) return;
    this.roomRefusalWarnedAt.set(reason, now);
    console.warn(`[LibP2PTransport] room channel refused (${reason}) for ${peer.slice(-8)}`);
  }

  async sendSecureRoom(peerId: string, room: DiscoveryId, data: Uint8Array): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const channel = await this.ensureSecureRoom(peerId, room);
      if (!channel || !this.dmCurrent(room)) return false;
      const sent = await channel.trySend(data);
      if (sent !== "unsent") return sent === "sent";
      // Closed before any of it went - the other end closed it as idle, or
      // it lost to a duplicate - so once more, on a fresh channel.
    }
    return false;
  }

  /** Room-scoped application traffic must use this instead of raw send().
   * A v2 capability failure must never fall back to the plaintext protocol.
   */
  sendRoom(peerId: string, room: string, data: Uint8Array): Promise<boolean> {
    if (!this.dmCurrent(room)) return Promise.resolve(false);
    room = this.wireRoom(room);
    if (room.startsWith("r2_")) return Promise.resolve(false);
    if (room.startsWith("dm-")) return Promise.resolve(false);
    if (room.startsWith("rd2_")) return this.sendSecureRoom(peerId, room as DiscoveryId, data);
    if (ROOM_SECURITY_V2_RELEASED) return Promise.resolve(false);
    return this.send(peerId, data);
  }

  sfuAdmission(room: string, nonce: string, peer: string): { roomCode: string; capability: string } | undefined {
    if (!this.dmCurrent(room)) throw new Error("Identity session ended");
    room = this.wireRoom(room);
    if (room.startsWith("dm-")) throw new Error("DM capability unavailable");
    if (room.startsWith("r2_")) throw new Error("Room secret cannot be an SFU identifier");
    if (!room.startsWith("rd2_")) {
      if (ROOM_SECURITY_V2_RELEASED) throw new Error("Legacy rooms are read-only");
      return undefined;
    }
    const keys = this.secureRooms.get(room as DiscoveryId);
    if (!keys) throw new Error("Room capability unavailable");
    return roomSfuAdmission(keys, nonce, peer);
  }

  private ensureSecureRoom(peerId: string, room: DiscoveryId): Promise<SecureRoomChannel | null> {
    if (!this.dmCurrent(room)) return Promise.resolve(null);
    const keys = this.secureRooms.get(room);
    const node = this.node;
    if (!keys || !node || peerId === this.selfId() || this.isRelayPeer(peerId)) return Promise.resolve(null);
    const live = this.liveRoomChannel(room, peerId);
    if (live?.channel) {
      live.usedAt = Date.now();
      // A live channel is proof enough to keep counting them once it closes,
      // even if a relay bounce's PEER_LEFT dropped them in between - but not
      // one the relay has since said they left: that is the reset of their
      // leaving still on its way, and it proves nothing past its close. The
      // relay listing them again clears that (verifyDiscoveredRoomPeer).
      if (!live.departed && !this.roomMembers.get(room)?.has(peerId)) this.noteRoomMember(room, peerId, live.connection);
      return Promise.resolve(live.channel);
    }
    const openingKey = `${room}:${peerId}`;
    const existing = this.secureOpening.get(openingKey);
    if (existing) return existing;
    const job = this.openSecureRoom(node, keys, peerId).catch(() => null).finally(() => {
      if (this.secureOpening.get(openingKey) === job) this.secureOpening.delete(openingKey);
    });
    this.secureOpening.set(openingKey, job);
    return job;
  }

  /**
   * Open a room channel to a peer, or join the one already being opened
   * between us. A handshake that fails gets one more try: ours loses the
   * race to the peer's own opening now and then, and an older peer at its
   * own limit turns streams away until one of its others closes.
   */
  private async openSecureRoom(node: Libp2p<AppServices>, keys: RoomKeys, peerId: string): Promise<SecureRoomChannel | null> {
    const room = keys.discoveryId;
    const current = () => this.node === node && this.secureRooms.get(room) === keys && this.dmCurrent(room);
    let refusals = 0;
    for (let pass = 0; pass < 4 && refusals < 2 && current(); pass++) {
      // Theirs, or a stream we left behind: joined rather than raced.
      for (let waits = 0; waits < 3; waits++) {
        const pending = this.liveRoomChannel(room, peerId) ? null : this.roomHandshake(room, peerId);
        if (!pending) break;
        await pending.ready.catch(() => {});
      }
      if (!current()) return null;
      const live = this.liveRoomChannel(room, peerId);
      if (live?.channel) return live.channel;
      const end = this.roomOpenings.tryEnter() ?? await this.roomOpenings.enter();
      if (!end) {
        this.noteRoomRefusal("queue", peerId, room);
        return null;
      }
      let entry: RoomStreamEntry | null = null;
      try {
        if (!current()) return null;
        const signal = AbortSignal.timeout(30_000);
        const connection = await node.dial(peerIdFromString(peerId), { signal });
        if (!current()) return null;
        const stream = await connection.newStream(ROOM_PROTOCOL, { runOnLimitedConnection: true, signal });
        if (!current()) { stream.abort(new Error("Room session ended")); return null; }
        if (this.liveRoomChannel(room, peerId) || this.roomHandshake(room, peerId)) {
          // Theirs got here while ours was opening.
          stream.abort(new Error("Room channel already opening"));
          continue;
        }
        entry = this.attachSecureStream(stream, connection, keys);
        const channel = entry?.getChannel();
        if (!channel) return null;
        await channel.ready;
      } catch {
        // No stream at all is the network's doing - nothing to try again
        // here. A handshake that went nowhere is the peer's answer, unless
        // it was ours that gave way to theirs.
        if (!entry) return null;
        if (!entry.superseded) refusals++;
        continue;
      } finally {
        end();
      }
      if (!current()) { entry?.close(); return null; }
      if (entry?.channel?.verified) return entry.channel;
    }
    if (refusals >= 2 && current() && !this.liveRoomChannel(room, peerId)) {
      // Turned away twice: whatever proved the room before no longer does.
      // They left it without the relay saying so, or cannot hold another
      // channel; either way they are not reachable here now.
      this.roomMembers.get(room)?.delete(peerId);
      this.noteRoomRefusal("refused", peerId, room);
    }
    return null;
  }

  private verifyDiscoveredRoomPeer(room: string, peer: string): void {
    const keys = this.secureRooms.get(room as DiscoveryId);
    if (!keys) return;
    // The relay lists them in the room again: a PEER_LEFT before this was a
    // relay bounce, and their open channel counts as proof once more.
    for (const entry of this.secureStreams) {
      if (entry.room === room && entry.peer === peer) entry.departed = false;
    }
    // dialPeer knows the relay's circuit addresses; ordinary node.dial does not
    // necessarily have an address for a freshly discovered peer yet.
    void this.dialPeer(peer).then(() => {
      if (this.secureRooms.get(room as DiscoveryId) === keys) {
        return this.ensureSecureRoom(peer, room as DiscoveryId);
      }
    }).catch(() => {});
  }
  private node: Libp2p<AppServices> | null = null;
  private handlers = new Map<keyof TransportEvents, Set<Function>>();
  private relayedPeers = new Set<string>();
  private connectedPeers = new Set<string>();
  /**
   * peerId -> when dropPeer last closed this peer's connections.
   *
   * dropPeer calls connection.close() without awaiting it, and libp2p's
   * graceful close can take up to CONNECTION_CLOSE_TIMEOUT_MS - during
   * which getConnections() still returns the dying connection. Without this,
   * the next reconcile tick sees it, re-registers the peer, and resends
   * everything into a connection that is about to die: a connect/disconnect
   * flap every few seconds.
   */
  private droppedAt = new Map<string, number>();
  private relayPeerId: string | null = null;
  private rendezvousStream: Stream | null = null;
  private rendezvousReadBuf: Uint8Array = new Uint8Array(0);
  /**
   * True while a rendezvous dial is in flight. Four call sites start the
   * rendezvous - connect, the relay-reconnect retry, the dial-failure retry
   * and the stream's own close handler - and two of them can fire for the
   * same drop. Without this guard each dial opened its own stream and the
   * last assignment won, so every earlier stream stayed open on the relay,
   * unread, holding a slot against the relay's per-peer stream ceiling.
   */
  private rendezvousStarting = false;
  private rendezvousPingTimer: TimerHandle | null = null;
  /**
   * Whether this NODE has ever seen a PONG on the rendezvous stream, and
   * when the last one arrived.
   *
   * The half-open check is armed by the first PONG and not before: a relay
   * from before the PING/PONG contract answers nothing, and treating its
   * silence as a dead link would put those deployments into a permanent
   * reconnect loop.
   */
  private rendezvousPongSeen = false;
  private rendezvousPongAt = 0;
  private rendezvousPingsSincePong = 0;
  /** Current rendezvous-retry backoff, and the one retry waiting to fire. */
  private rendezvousRetryDelay = RENDEZVOUS_RECONNECT_DELAY_MS;
  private rendezvousRetryTimer: TimerHandle | null = null;
  /**
   * navigator says the radio is down. Dialling into that is a storm with no
   * chance of connecting and a phone battery paying for it, so every dial
   * path checks this. Cleared by "online", which also probes the relay link.
   */
  private offline = false;
  private networkListenersInstalled = false;
  /** Current relay-reconnect backoff; reset once a reconnect completes. */
  private relayReconnectDelay = RELAY_RECONNECT_DELAY_MS;

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
  /**
   * When each outstanding RTT probe was sent, by nonce.
   *
   * Separate from the liveness pings, which only ever asked "did anything
   * come back", never "how long did it take". A probe answers on the peer's
   * receive path BEFORE any app work - signing, the reducer, rendering - so
   * what this measures is the connection rather than the application, which
   * is the useful half: a fast ping with slow chat points at the relay or
   * the message pipeline instead of at the link.
   */
  private rttProbes = new Map<
    number,
    {
      peerId: string;
      sentAt: number;
      settle: (rtt: number | null) => void;
      /** Set by measureClock probes: wall clock at send, and a resolver fed
       *  the pong's remote wall timestamp (or null when the peer's build
       *  predates it). */
      sentWallAt?: number;
      settleClock?: (remoteWallMs: number | null) => void;
    }
  >();
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
  private confirmTimers = new Map<string, TimerHandle>();
  /** Dev counters. Connection-layer faults are invisible without them: every
   *  side looks connected while writes vanish into a dead circuit. */
  readonly debugStats = {
    identifies: 0,
    connects: 0,
    disconnects: 0,
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
    roomChannelRefusals: 0,
    roomChannelsClosedIdle: 0,
  };

  // set to true only by disconnect() - prevents any reconnect logic from firing
  private intentionalDisconnect = false;

  private relayReconnectTimer: TimerHandle | null = null;
  private reconcileTimer: TimerHandle | null = null;
  private privateKeyBytes: Uint8Array | null = null;
  /** Distinguishes chat-session events from a device-sync instance's. Only
   *  the main bus may call `beginSession`, or a sync session erases the
   *  chat session's history. */
  private readonly diagBus: string;
  private diagSessionId: string | null = null;

  constructor(opts?: { diagBus?: string }) {
    installFaultHook();
    this.diagBus = opts?.diagBus ?? "main";
    this.installNetworkListeners();
  }

  get p2pNode(): Libp2p<AppServices> | null {
    return this.node;
  }

  /**
   * Is the relay link actually usable right now?
   *
   * Every flag the app keeps says "connected" for a page restored from the
   * back-forward cache, or a tab the browser froze and thawed: the node
   * object survives with sockets that are gone. This asks libp2p and the
   * rendezvous stream instead of asking a flag.
   */
  relayLinkLive(): boolean {
    if (!this.node || !this.relayPeerId) return false;
    if (!this.rendezvousStream || !streamIsOpen(this.rendezvousStream)) {
      return false;
    }
    try {
      return this.node
        .getConnections(peerIdFromString(this.relayPeerId))
        .some((c) => c.status === "open");
    } catch {
      return false;
    }
  }

  /**
   * One PING, five seconds, and the relay link is judged.
   *
   * Called on the events that break a circuit without closing it: coming
   * back online, and `navigator.connection` reporting a change. Left alone
   * for a relay that has never answered a PONG, same arming rule as the
   * periodic check.
   */
  async checkRelayLiveness(): Promise<void> {
    if (this.intentionalDisconnect || !this.node) return;
    const stream = this.rendezvousStream;
    if (!stream || !streamIsOpen(stream)) {
      this.scheduleRelayReconnect();
      return;
    }
    if (!this.rendezvousPongSeen) return;
    const before = this.rendezvousPongAt;
    this.rendezvousSend({ type: "PING" });
    await new Promise((r) => setTimeout(r, RELAY_LIVENESS_TIMEOUT_MS));
    if (this.rendezvousStream !== stream) return;
    if (this.rendezvousPongAt > before) return;
    this.dropHalfOpenRendezvous(stream, "liveness probe");
  }

  /**
   * Retire a rendezvous stream the relay has stopped answering on, and take
   * the whole relay link with it.
   *
   * The stream reference is cleared BEFORE the abort so its own close
   * handler bails out: that handler only re-opens the rendezvous, and a
   * half-open circuit needs the full re-dial-and-re-reserve path.
   */
  private dropHalfOpenRendezvous(stream: Stream, why: string): void {
    if (this.rendezvousStream !== stream) return;
    console.warn(`[Rendezvous] relay silent (${why}), rebuilding relay link`);
    rec(ev("rv.close", { d: { halfOpen: true, why } }));
    this.stopRendezvousPing();
    this.rendezvousStream = null;
    stream.abort(new Error("rendezvous half-open"));
    this.emit("status", {
      type: "relay-disconnected",
      message: "Relay stopped responding - reconnecting...",
    });
    this.scheduleRelayReconnect();
  }

  private installNetworkListeners(): void {
    if (typeof window === "undefined" || this.networkListenersInstalled) return;
    this.networkListenersInstalled = true;
    window.addEventListener("offline", () => {
      // Only the dial storm is this layer's business; the app owns the
      // banner and the relayConnected flag.
      this.offline = true;
    });
    window.addEventListener("online", () => {
      this.offline = false;
      void this.checkRelayLiveness();
    });
    const conn = (navigator as Navigator & { connection?: unknown })
      .connection as NetworkInformationLike | undefined;
    conn?.addEventListener?.("change", () => {
      this.offline = typeof navigator.onLine === "boolean" && !navigator.onLine;
      if (!this.offline) void this.checkRelayLiveness();
    });
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
      if (isBenignStreamRejection(e.reason)) {
        this.debugStats.suppressedStreamErrors++;
        rec(
          ev("stream.reset", {
            d: { suppressed: true, err: errText(e.reason) },
          })
        );
        e.preventDefault();
      }
    });
  }
  private noiseFilterInstalled = false;

  async connect(privateKeyBytes?: Uint8Array | null): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    let startingNode: Libp2p<AppServices> | null = null;
    const assertCurrent = () => {
      if (generation === this.lifecycleGeneration) return;
      try { void Promise.resolve(startingNode?.stop()).catch(() => {}); } catch {}
      throw new Error("Transport connection cancelled");
    };
    for (const entry of this.secureStreams) entry.close();
    this.secureOpening.clear();
    // A new node means new connections to everyone: rooms are proven afresh
    // as the relay lists their members again.
    this.roomOpenings.clear();
    this.roomMembers.clear();
    this.roomProveRetry.clear();
    this.installStreamNoiseFilter();
    this.intentionalDisconnect = false;

    // Minted once per connect(); a reconnect keeps the session so a bundle
    // tells the whole story. Only main resets the ring - a sync instance
    // must never erase the chat session's history.
    this.diagSessionId = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (b) => b.toString(16).padStart(2, "0")
    ).join("");
    if (this.diagBus === "main") {
      beginSession(this.diagSessionId, Date.now());
    }
    rec(ev("session.start", { d: { bus: this.diagBus } }));

    // A reconnect used to leak the previous node's timers: reconcileTimer was
    // overwritten (leaving an interval running against a dead node forever)
    // and a pending relayReconnectTimer could fire into the new one.
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }

    // A previous failed connect may have left a half-started node behind -
    // stop it so retries don't leak libp2p nodes.
    if (this.node) {
      try {
        await this.node.stop();
      } catch {}
      assertCurrent();
      this.node = null;
    }
    // Stopping the old node fires its own relay peer:disconnect, which
    // schedules a reconnect against a node that no longer exists - the clear
    // above happens too early to catch it, and the timer then fired into the
    // NEW node and re-dialled a relay it was already connected to.
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    // All per-connection state belongs to the old node. Stale connectedPeers
    // would suppress future "connect" events; stale streams can't be reused.
    // joinedRooms is intentionally KEPT - it's re-subscribed below.
    this.connectedPeers.clear();
    // Announced, not just cleared. The app mirrors this set reactively, and
    // a silent wipe leaves stale entries behind: a peer that reconnects
    // DIRECTLY then produces no relayChanged (was === false already), so its
    // relay badge stays lit for the rest of the session.
    for (const id of this.relayedPeers) this.emit("relayChanged", id, false);
    this.relayedPeers.clear();
    // Same reasoning as relayedPeers above: announce the withdrawal, don't
    // just drop it, or the app's provenPeers mirror keeps a peer proven
    // across a reconnect that gave them a brand new, unconfirmed stream.
    for (const [id, stream] of this.peerStreams) {
      if (this.confirmedStreams.has(stream)) this.emit("streamLost", id);
    }
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
    this.stopRendezvousPing();
    this.rendezvousStarting = false;
    this.rendezvousStream = null;
    // Per NODE: the half-open check arms on the first PONG this node sees,
    // so a rebuilt node has to earn it again.
    this.rendezvousPongSeen = false;
    this.rendezvousPongAt = 0;
    this.rendezvousPingsSincePong = 0;
    this.stopRendezvousRetry();
    this.relayReconnectDelay = RELAY_RECONNECT_DELAY_MS;
    this.offline =
      typeof navigator !== "undefined" &&
      typeof navigator.onLine === "boolean" &&
      !navigator.onLine;

    if (privateKeyBytes) this.privateKeyBytes = privateKeyBytes;

    // js-libp2p keys the node by `privateKey`; there is no `peerId` option any
    // more. Passing one was silently ignored (an object spread hides the excess
    // property from the typechecker), so every start generated a random key:
    // the peerId no longer matched the user's identity, which broke the
    // peerId -> did:key binding that presence, profiles and DM auth rely on.
    const privateKey = this.privateKeyBytes
      ? await this.privateKeyFromRawKey(this.privateKeyBytes)
      : undefined;
    assertCurrent();

    startingNode = await createLibp2p({
      start: false,
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
    assertCurrent();
    this.node = startingNode;

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
      // runOnLimitedConnection matches the dial side (openOutboundStream,
      // rendezvous): currently a no-op, since the relay grants circuits no
      // limits, but the assumption lives in the Go relay while this was the
      // one registration that omitted it - a relay that ever grants limits
      // would make every relayed peer connect and carry nothing.
      { force: true, runOnLimitedConnection: true }
    );
    assertCurrent();

    await this.handleRoomStreams(this.node);
    assertCurrent();

    await this.node.handle(DM_INTRODUCTION_PROTOCOL, (stream: Stream, connection: Connection) => {
      this.attachIntroduction(stream, connection);
    }, { force: true, runOnLimitedConnection: true, maxInboundStreams: 1 });
    assertCurrent();

    await this.node.start();
    assertCurrent();

    const relayMa = relayMultiaddr();
    this.relayPeerId = relayMa.split("/p2p/").pop() ?? null;

    const myId = this.node.peerId.toString();
    console.log("[LibP2PTransport] node started, selfId:", myId);
    rec(
      ev("session.config", {
        d: {
          selfId: myId,
          relayPeerId: this.relayPeerId ?? "",
          configured: isConfigured(),
        },
      })
    );

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
      if (!ROOM_SECURITY_V2_RELEASED && room && !room.startsWith("rd2_") && this.joinedRooms.has(room)) {
        this.emit("message", from, evt.detail.data, room);
      }
    });

    this.node.addEventListener("peer:identify", (evt: any) => {
      const id = evt.detail.peerId.toString();
      if (this.isRelayPeer(id)) return;
      this.debugStats.identifies++;
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
      assertCurrent();
    } catch (err) {
      // Don't leave a running node behind on a failed connect
      try {
        await startingNode.stop();
      } catch {}
      assertCurrent();
      this.node = null;
      throw err;
    }
    await this.requestRelayReservation();
    assertCurrent();
    const reserved = await this.waitForRelayReservation();
    assertCurrent();
    if (!reserved) {
      // No reservation means nobody can reach US: a browser cannot listen, so
      // every inbound path runs through the relay circuit. One more attempt
      // covers the common case of the first request racing the relay dial.
      // (A reservation that failed with a DialError poisons libp2p's own
      // relay filter for the lifetime of this node - the retry then fails
      // fast with "previously invalid", and the app's connect retry, which
      // builds a FRESH node, is the real recovery.)
      console.warn("[Transport] no relay reservation, retrying once");
      await this.requestRelayReservation();
      assertCurrent();
      await this.waitForRelayReservation();
      assertCurrent();
    }

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

    // updateRelayedStatus otherwise only ran on connect events and the
    // hidden-gated upgrade refresh - so a peer whose direct connection died
    // while its circuit survived kept its "direct" marking until the next
    // visible reconcile tick, and the relay badge lied in the meantime.
    this.node.addEventListener(
      "connection:close",
      (evt: CustomEvent<Connection>) => {
        for (const entry of this.secureStreams) {
          if (entry.connection === evt.detail) entry.close();
        }
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
      this.droppedAt.delete(id);
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
      if (!room.startsWith("rd2_")) this.node.services.pubsub.subscribe(roomTopic(room));
    }

    this.startRendezvous();
  }

  /**
   * Take room streams, with libp2p's per-connection limits for the protocol
   * raised to ours: proven channels plus handshakes, either direction (its
   * default is 32 inbound). Its own method so the integration tests register
   * exactly what a real node does.
   */
  private async handleRoomStreams(node: Libp2p<AppServices>): Promise<void> {
    const limit = ROOM_CHANNELS_PER_CONNECTION + ROOM_HANDSHAKES_PER_CONNECTION;
    await node.handle(ROOM_PROTOCOL, (stream: Stream, connection: Connection) => {
      this.attachSecureStream(stream, connection);
    }, { force: true, runOnLimitedConnection: true, maxInboundStreams: limit, maxOutboundStreams: limit });
  }

  joinRoom(roomCode: string): void {
    if (ROOM_SECURITY_V2_RELEASED && !roomCode.startsWith("rd2_")) throw new Error("Legacy rooms are read-only");
    roomCode = this.wireRoom(roomCode);
    if (roomCode.startsWith("dm-")) throw new Error("Missing room capability");
    if (roomCode.startsWith("r2_")) throw new Error("Room secrets require joinSecureRoom");
    if (roomCode.startsWith("rd2_") && !this.secureRooms.has(roomCode as DiscoveryId)) {
      throw new Error("Missing room capability");
    }
    if (this.joinedRooms.has(roomCode)) return;
    this.joinedRooms.add(roomCode);
    if (!roomCode.startsWith("rd2_")) this.node?.services.pubsub.subscribe(roomTopic(roomCode));
    this.rendezvousSend({ type: "REGISTER", room: roomCode });
  }

  /**
   * A DM deleted for good: leave it AND drop its binding. leaveRoom keeps the
   * binding so a stale send fails closed, but a deleted conversation has no
   * sends left - and a dm- reference with no binding is refused on the wire
   * anyway. Without this every conversation ever deleted held one of the 512
   * bindings until reload, and junk message requests could use them up.
   */
  forgetConversation(localId: string): void {
    this.leaveRoom(localId);
    if (!localId.startsWith("dm-")) return;
    const discoveryId = this.secureAliases.get(localId);
    const anchor = this.dmAnchors.get(localId);
    for (const id of [discoveryId, anchor]) {
      if (id && this.secureLocalIds.get(id) === localId) this.secureLocalIds.delete(id);
    }
    this.secureAliases.delete(localId);
    this.dmAnchors.delete(localId);
    this.dmSessions.delete(localId);
  }

  leaveRoom(roomCode: string): void {
    if (roomCode.startsWith("dm-")) this.releaseDmLobby(roomCode);
    roomCode = this.wireRoom(roomCode);
    for (const entry of this.secureStreams) {
      // Pending inbound handshakes do not yet have an admitted room. Closing
      // them on leave prevents completion against a removed capability.
      if (entry.room === roomCode || entry.room === null) entry.close();
    }
    const keys = this.secureRooms.get(roomCode as DiscoveryId);
    if (keys) {
      keys.membershipKey.fill(0); keys.encryptionKey.fill(0); keys.sfuSigningSeed.fill(0);
      this.secureRooms.delete(roomCode as DiscoveryId);
    }
    this.roomMembers.delete(roomCode as DiscoveryId);
    for (const key of this.roomProveRetry.keys()) {
      if (key.startsWith(`${roomCode}\n`)) this.roomProveRetry.delete(key);
    }
    if (!this.joinedRooms.has(roomCode)) return;
    this.joinedRooms.delete(roomCode);
    // Otherwise the set grows for the whole session; retryMissingRoomPeers
    // skips unjoined rooms, so this is tidiness rather than a leak of work.
    this.roomPeers.delete(roomCode);
    this.rendezvousSend({ type: "UNREGISTER", room: roomCode });
    try {
      if (!roomCode.startsWith("rd2_")) this.node?.services.pubsub.unsubscribe(roomTopic(roomCode));
    } catch {}
  }

  async disconnect(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.unobserveLock?.();
    this.unobserveLock = null;
    this.clearRoomSecurity();
    for (const handle of this.dmIntroductions.values()) handle.close();
    this.dmOpening.clear();
    this.dmSessions.clear();
    for (const entry of this.secureStreams) entry.close();
    this.secureOpening.clear();
    this.secureRooms.clear();
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
    this.stopRendezvousRetry();

    if (!this.node) return;

    for (const room of this.joinedRooms) {
      this.rendezvousSend({ type: "UNREGISTER", room });
    }

    // Await + swallow like connect() does, so a throwing stop() can't leave a
    // half-stopped node or reject into a fire-and-forget caller.
    try {
      await this.node.stop();
    } catch {}
    if (generation !== this.lifecycleGeneration) return;
    this.node = null;
    this.relayPeerId = null;
    this.stopRendezvousPing();
    this.rendezvousStarting = false;
    this.rendezvousStream = null;
    this.rendezvousPongSeen = false;
    this.rendezvousPongAt = 0;
    this.rendezvousPingsSincePong = 0;
    this.relayReconnectDelay = RELAY_RECONNECT_DELAY_MS;
    this.joinedRooms.clear();
    this.connectedPeers.clear();
    // Announced, not just cleared. The app mirrors this set reactively, and
    // a silent wipe leaves stale entries behind: a peer that reconnects
    // DIRECTLY then produces no relayChanged (was === false already), so its
    // relay badge stays lit for the rest of the session.
    for (const id of this.relayedPeers) this.emit("relayChanged", id, false);
    this.relayedPeers.clear();
    for (const [id, stream] of this.peerStreams) {
      if (this.confirmedStreams.has(stream)) this.emit("streamLost", id);
    }
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
          peerId,
          message: `Failed to open stream to peer ${peerId.slice(-8)}`,
          // The bundle used to record only THAT it failed; a phone's bundle
          // full of these said nothing about why.
          err:
            err instanceof Error
              ? `${err.name}: ${err.message}`
              : typeof Event !== "undefined" && err instanceof Event
                ? `Event: ${err.type}`
                : String(err),
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
    if (!this.dmCurrent(roomCode)) return;
    roomCode = this.wireRoom(roomCode);
    if (roomCode.startsWith("dm-")) throw new Error("DM capability unavailable");
    if (roomCode.startsWith("r2_")) throw new Error("Cannot broadcast a room secret");
    if (roomCode.startsWith("rd2_")) {
      await Promise.all(this.peersInRoom(roomCode).map((peer) => this.sendSecureRoom(peer, roomCode as DiscoveryId, data)));
      return;
    }
    if (ROOM_SECURITY_V2_RELEASED || !this.node || !this.joinedRooms.has(roomCode)) return;
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

  /**
   * Connected peers the RELAY has told us are registered in this room.
   *
   * Filled from the rendezvous PEERS reply and PEER_JOINED, so it is the
   * relay's view of membership rather than anything a peer asserted. Used to
   * decide who may be told that a room exists: a room code is the room's only
   * membership secret, so naming a room to somebody outside it hands them the
   * key to it.
   *
   * A protected room asks the peers themselves instead: those that proved
   * it over a channel and are still connected, whether or not that channel
   * is open right now (roomMembers) - a send to one whose channel closed
   * opens it again.
   */
  peersInRoom(room: string): string[] {
    if (!this.dmCurrent(room)) return [];
    room = this.wireRoom(room);
    if (room.startsWith("dm-")) return [];
    if (room.startsWith("rd2_")) {
      const peers = new Set<string>();
      for (const e of this.secureStreams) {
        if (e.room === room && e.connection.status === "open" && e.channel?.verified) peers.add(e.peer);
      }
      for (const peer of this.roomMembers.get(room as DiscoveryId)?.keys() ?? []) {
        if (this.connectedPeers.has(peer)) peers.add(peer);
      }
      return [...peers];
    }
    const known = this.roomPeers.get(room);
    if (!known) return [];
    return [...known].filter((p) => this.connectedPeers.has(p));
  }

  /**
   * Is this peer registered in this room with the RELAY? Same attestation as
   * peersInRoom, WITHOUT the live-connection filter.
   *
   * Intersecting with the connection list is right for an outbound send -
   * there is nothing to send down otherwise. It is wrong for judging an
   * INBOUND frame: gossipsub relays presence through whoever is in the mesh,
   * so a genuine member we have not dialled yet legitimately arrives with no
   * connection of its own, and that is precisely the peer worth dialling.
   */
  isRoomPeer(room: string, peerId: string): boolean {
    if (!this.dmCurrent(room)) return false;
    room = this.wireRoom(room);
    if (room.startsWith("dm-")) return false;
    if (room.startsWith("rd2_")) return this.isRoomMember(room as DiscoveryId, peerId);
    return this.roomPeers.get(room)?.has(peerId) === true;
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
    return Array.from(this.joinedRooms, (room) => this.localRoom(room));
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
    // A peer we are seeing again on a NEW connection must not reuse the
    // stream from its previous incarnation: that stream can still report
    // itself open while the far end is gone, so every write disappears into
    // it. An ALREADY-connected peer identifying again must NOT be torn down
    // here, though - glare makes two connections per pair routine (both
    // sides dial each other from the same rendezvous reply), and every extra
    // identify used to abort a stream that had just been confirmed.
    // handleInboundStream already resets the outbound stream on a genuinely
    // new connection, which is the one case that actually needs it.
    if (!this.connectedPeers.has(peerId)) this.cleanupPeerStream(peerId);
    // Fresh incarnation, fresh liveness: a stale miss count from before a
    // reconnect would let a single missed probe drop a healthy peer, and an
    // unseeded lastInbound made the probe fire the moment a reconciled peer
    // appeared.
    this.pingMisses.delete(peerId);
    this.lastInbound.set(peerId, Date.now());
    this.connectedPeers.add(peerId);
    this.debugStats.connects++;
    this.droppedAt.delete(peerId);
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
    // A backgrounded tab still needs a detector, not none: a relayed
    // connection keeps looking alive after the far end reloads or crashes
    // (the relay holds the circuit open), and a mobile PWA can sit
    // backgrounded for hours. Scale the threshold instead of skipping
    // outright, so the radio stays quiet without going silent forever.
    const hidden = typeof document !== "undefined" && document.hidden;
    const silence = hidden ? PEER_SILENCE_MS * 4 : PEER_SILENCE_MS;
    const now = Date.now();
    for (const peerId of [...this.connectedPeers]) {
      if (this.pinging.has(peerId)) continue;
      if (now - (this.lastInbound.get(peerId) ?? 0) < silence) continue;
      // A stream mid-confirmation is already being pinged on a faster clock.
      const out = this.peerStreams.get(peerId);
      if (out && streamIsOpen(out) && !this.confirmedStreams.has(out)) {
        continue;
      }
      this.pinging.add(peerId);
      const askedAt = Date.now();
      // Fire and forget: send() can sit on the pending queue for the whole
      // confirm budget before it resolves at all (or, if that queue never
      // drains, forever). The release below no longer waits on it - see
      // PEER_PROBE_RELEASE_MS.
      void this.send(peerId, pingFrame(++this.pingNonceCounter));
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
        rec(
          ev("peer.drop.liveness", {
            peer: peerId,
            d: {
              misses,
              silentMs: Date.now() - (this.lastInbound.get(peerId) ?? askedAt),
            },
          })
        );
        this.dropPeer(peerId);
      }, PEER_PROBE_RELEASE_MS);
    }
  }

  /**
   * Round-trip time to a peer, in milliseconds, or null if it did not answer
   * in time.
   *
   * Null is loss, not slowness: a probe that never returns has no latency to
   * report, and folding it in as a very large number would drag every
   * average and wreck the scale of anything plotting the result.
   */
  async measureRtt(peerId: string, timeoutMs = 2000): Promise<number | null> {
    if (!this.node || !this.connectedPeers.has(peerId)) return null;
    const nonce = ++this.pingNonceCounter;
    return new Promise<number | null>((resolve) => {
      let done = false;
      const settle = (rtt: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.rttProbes.delete(nonce);
        rec(ev("peer.rtt", { peer: peerId, d: { ms: rtt } }));
        resolve(rtt);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      // sentAt is recorded as late as possible - after the frame is built,
      // just before it goes out - so the measurement is the wire, not our
      // own serialisation.
      this.rttProbes.set(nonce, {
        peerId,
        sentAt: performance.now(),
        settle,
      });
      void this.send(peerId, pingFrame(nonce)).catch(() => settle(null));
    });
  }

  /**
   * One NTP-style clock probe: the four timestamps estimateClock (the watch
   * library) folds into an offset. t0/t3 are this side's wall clock around
   * the round trip; t1 = t2 = the peer's wall clock from the pong, one value
   * because the reply is built inline on their receive path. Null when the
   * peer did not answer in time or runs a build whose pongs carry no clock.
   */
  async measureClock(
    peerId: string,
    timeoutMs = 2000
  ): Promise<{ t0: number; t1: number; t2: number; t3: number } | null> {
    if (!this.node || !this.connectedPeers.has(peerId)) return null;
    const nonce = ++this.pingNonceCounter;
    return new Promise((resolve) => {
      let done = false;
      const finish = (
        sample: { t0: number; t1: number; t2: number; t3: number } | null
      ) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.rttProbes.delete(nonce);
        if (sample) {
          rec(
            ev("peer.clock", {
              peer: peerId,
              d: { t0: sample.t0, t1: sample.t1, t2: sample.t2, t3: sample.t3 },
            })
          );
        }
        resolve(sample);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const sentWallAt = Date.now();
      this.rttProbes.set(nonce, {
        peerId,
        sentAt: performance.now(),
        sentWallAt,
        settle: () => {},
        settleClock: (remoteWallMs) => {
          if (remoteWallMs === null) return finish(null);
          finish({
            t0: sentWallAt,
            t1: remoteWallMs,
            t2: remoteWallMs,
            t3: Date.now(),
          });
        },
      });
      void this.send(peerId, pingFrame(nonce)).catch(() => finish(null));
    });
  }

  private dropPeer(peerId: string): void {
    this.debugStats.disconnects++;
    this.droppedAt.set(peerId, Date.now());
    // Probes to a peer that just left resolve as loss now rather than
    // sitting out their full timeout.
    for (const [nonce, probe] of [...this.rttProbes]) {
      if (probe.peerId !== peerId) continue;
      this.rttProbes.delete(nonce);
      // Clock probes resolve through settleClock; without this they sat out
      // their full timeout on every disconnect race, exactly what this loop
      // exists to prevent for RTT probes.
      probe.settleClock?.(null);
      probe.settle(null);
    }
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
    // dropPeer deletes connectedPeers ABOVE closing the connections, so
    // peer:disconnect's own dedup guard (`if (!this.connectedPeers.has(id))
    // return`) sees the entry already gone and never reaches its redial.
    // Without this, a liveness drop is permanent: the peer is absent from
    // connectedPeers, absent from dialingPeers, and nothing else redials it.
    if (!this.intentionalDisconnect) {
      setTimeout(() => this.redialPeer(peerId), PEER_REDIAL_DELAY_MS);
    }
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
      rec(
        ev("session.config", {
          sev: "warn",
          d: {
            connections: connections.length,
            peers: this.connectedPeers.size,
          },
        })
      );
    }
    const byPeer = new Map<string, Connection[]>();
    for (const connection of connections) {
      const id = connection.remotePeer.toString();
      const list = byPeer.get(id);
      if (list) list.push(connection);
      else byPeer.set(id, [connection]);
      if (this.isRelayPeer(id) || this.connectedPeers.has(id)) continue;
      // The connection dropPeer just closed can still show up here for up
      // to CONNECTION_CLOSE_TIMEOUT_MS - re-registering into that window
      // produces the connect/disconnect flap droppedAt exists to prevent.
      const closingStill =
        Date.now() - (this.droppedAt.get(id) ?? 0) < CONNECTION_CLOSE_TIMEOUT_MS;
      if (closingStill) continue;
      console.log("[Transport] reconciled missed peer:", id.slice(-8));
      this.registerPeer(id);
      this.emit("connect", id);
    }
    // peer:disconnect can only fire while the node is alive, so a connection
    // lost across a node restart left a resident connectedPeers entry
    // forever. Safe now that dropPeer redials on its own (finding 2) -
    // dropping a peer nothing would ever dial back used to strand it.
    for (const id of [...this.connectedPeers]) {
      if (!byPeer.has(id)) this.dropPeer(id);
    }
    this.probeSilentPeers();
    this.retryMissingRoomPeers();
    this.retryUnprovenRoomPeers();
    // Channels busy when the limit was last reached are closable now.
    this.trimRoomChannels();
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
    // Only the DIAL below is skipped while hidden, not the refresh - a
    // relayed connection keeps looking alive after the far end reloads or
    // crashes (the relay holds the circuit open), and gating the refresh
    // too left the badge showing "direct" long after the direct connection
    // actually died in the background.
    const hidden = typeof document !== "undefined" && document.hidden;
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
      if (hidden) continue; // keep the radio quiet in the background
      if (this.dialingPeers.has(peerId)) continue;
      const due = this.nextUpgradeAt.get(peerId) ?? 0;
      if (now < due) continue;
      const previous = due === 0 ? 0 : (this.upgradeBackoff.get(peerId) ?? 0);
      const next = Math.min(
        Math.max(RELAY_UPGRADE_MIN_MS, previous * 2),
        RELAY_UPGRADE_MAX_MS
      );
      this.upgradeBackoff.set(peerId, next);
      // Jittered like the relay dial below - see retryMissingRoomPeers for
      // why an un-jittered peer backoff stays lockstepped with the pair on
      // the other end of the same reservation race.
      this.nextUpgradeAt.set(peerId, now + next + Math.random() * next * 0.3);
      this.upgradeToDirect(peerId).catch(() => {});
    }
  }

  private async upgradeToDirect(peerId: string): Promise<void> {
    if (!this.node || this.offline || shouldBlockDial(peerId)) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);
    this.debugStats.relayUpgradeAttempts++;
    rec(ev("peer.upgrade.attempt", { peer: peerId }));
    try {
      if (shouldBlockWebrtcDial()) throw new Error("webrtc dial blocked");
      const relayAddr = relayMultiaddr();
      await this.node.dial(
        multiaddr(`${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`)
      );
    } catch (err) {
      rec(
        ev("peer.upgrade.fail", { peer: peerId, d: { reason: errText(err) } })
      );
      return; // still relayed; the backoff decides when to try again
    } finally {
      this.dialingPeers.delete(peerId);
    }

    rec(ev("peer.upgrade.ok", { peer: peerId }));
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
      // Point outbound traffic at the connection the upgrade actually won,
      // not at whichever one dialProtocol picks arbitrarily among several -
      // that routinely landed back on the very circuit just left, so the
      // app believed it was upgraded while every frame still rode the relay.
      const direct = this.node
        ?.getConnections(peerIdFromString(peerId))
        .find((c) => c.direct);
      if (direct) this.liveConnections.set(peerId, direct);
      else this.liveConnections.delete(peerId);
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
    // Same rule as upgradeRelayedPeers: a backgrounded tab has no UI to keep
    // honest, and a dial sweep is the most expensive thing this file can ask
    // of a sleeping phone's radio. Returning to the page runs reconcileNow,
    // which clears the backoff and retries everything immediately.
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.offline) return;
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
        // Jittered like the relay dial below: both sides of a pair learn
        // about each other from the same rendezvous reply and retry in
        // lockstep without this, colliding on the same reservation race
        // every time.
        this.nextDialAt.set(peerId, now + next + Math.random() * next * 0.3);
        this.dialPeer(peerId).catch(() => {});
      }
    }
  }

  /**
   * Try again, backing off, for every pair the relay lists in a protected
   * room we are in that has not proven it: connected, yet no channel. A pair
   * used to get one attempt, when the rendezvous named it, and one refused
   * then - every limit was full at startup, or the handshake timed out -
   * never got another: the two stayed deaf to each other in that room for
   * the rest of the session. Same hidden and offline rules as the dials
   * above.
   */
  private retryUnprovenRoomPeers(): void {
    if (this.intentionalDisconnect || !this.node || this.offline) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    for (const [room, peers] of this.roomPeers) {
      if (!room.startsWith("rd2_") || !this.joinedRooms.has(room) || !this.secureRooms.has(room as DiscoveryId)) continue;
      for (const peer of peers) {
        if (!this.connectedPeers.has(peer) || this.isRoomMember(room as DiscoveryId, peer) ||
            this.secureOpening.has(`${room}:${peer}`)) continue;
        const key = `${room}\n${peer}`;
        const retry = this.roomProveRetry.get(key);
        // First seen here: the attempt the rendezvous reply made gets its turn.
        if (!retry) {
          this.roomProveRetry.set(key, { at: now + ROOM_PROVE_RETRY_MS, delay: ROOM_PROVE_RETRY_MS });
          continue;
        }
        if (now < retry.at) continue;
        const delay = Math.min(retry.delay * 2, ROOM_PROVE_RETRY_MAX_MS);
        this.roomProveRetry.set(key, { at: now + delay + Math.random() * delay * 0.3, delay });
        void this.ensureSecureRoom(peer, room as DiscoveryId);
      }
    }
  }

  private isRelayPeer(peerId: string): boolean {
    return this.relayPeerId !== null && peerId === this.relayPeerId;
  }

  private async dialRelay(): Promise<void> {
    if (!this.node) return;
    const relayMa = relayMultiaddr();
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < RELAY_DIAL_ATTEMPTS; attempt++) {
      // A disconnect() landing mid-backoff must ABORT the connect, not fall
      // through: returning normally would send connect() on to attach
      // listeners to a node that is already stopped (or null).
      if (this.intentionalDisconnect || !this.node) {
        throw new Error("relay dial aborted");
      }
      try {
        await this.node.dial(multiaddr(relayMa));
        console.log("[Transport] relay connected");
        this.emit("status", {
          type: "relay-connected",
          message: "Connected to relay",
        });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === RELAY_DIAL_ATTEMPTS - 1) break;
        // Jittered backoff: two devices starting a sync together would
        // otherwise retry in lockstep and collide on the same failure.
        const wait = Math.min(
          RELAY_DIAL_BASE_MS * 2 ** attempt,
          RELAY_DIAL_MAX_MS
        );
        const delay = wait + Math.random() * wait * 0.3;
        console.warn(
          `[Transport] relay dial attempt ${attempt + 1}/${RELAY_DIAL_ATTEMPTS} failed, retrying in ${Math.round(delay)}ms`
        );
        this.emit("status", {
          type: "relay-dial-retry",
          message: `Relay unreachable - retrying (${attempt + 1}/${RELAY_DIAL_ATTEMPTS})`,
        });
        rec(
          ev("relay.dial.attempt", {
            d: { attempt: attempt + 1, delayMs: Math.round(delay) },
          })
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    console.error("[Transport] relay dial failed:", lastErr);
    this.emit("status", {
      type: "relay-dial-failed",
      message: "Failed to connect to relay",
    });
    // A browser WebSocket failure arrives as a DOM Event, and every caller
    // that showed it to a user rendered "[object Event]". Carry a sentence
    // a person can act on instead, keeping the original as the cause.
    const detail =
      lastErr instanceof Error
        ? lastErr.message
        : lastErr && typeof lastErr === "object" && "type" in lastErr
          ? `websocket ${(lastErr as { type: string }).type}`
          : String(lastErr);
    throw new Error(
      `Could not reach the relay after ${RELAY_DIAL_ATTEMPTS} attempts (${detail}). Check your connection and try again.`,
      { cause: lastErr }
    );
  }

  private async requestRelayReservation(): Promise<void> {
    if (!this.node) return;
    rec(ev("relay.reservation.request"));
    const relayMa = relayMultiaddr();
    const circuitListenAddr = multiaddr(`${relayMa}/p2p-circuit`);
    try {
      const { transportManager } = (
        this.node as unknown as WithTransportManager
      ).components;
      await transportManager.listen([circuitListenAddr]);
    } catch (err) {
      console.warn("[Transport] reservation request failed:", err);
      const clockWarning = reservationClockWarning(err);
      if (clockWarning) {
        this.emit("status", { type: "app-warning", message: clockWarning });
      }
      rec(ev("relay.reservation.timeout", { d: { err: errText(err) } }));
    }
  }

  // re-dials a known peer; skips if they're already connected
  private async redialPeer(peerId: string): Promise<void> {
    if (this.intentionalDisconnect || !this.node) return;
    if (this.connectedPeers.has(peerId)) return;
    console.log("[Transport] re-dialing peer:", peerId.slice(-8));
    await this.dialPeer(peerId);
  }

  /**
   * Reserve, and keep trying. A reservation racing the relay's own view of
   * our connection fails once and works on the next attempt, which is why
   * connect() already retries; the reconnect path threw the answer away
   * entirely and carried on as if a circuit existed.
   */
  private async reserveWithRetries(
    attempts = RELAY_RESERVATION_ATTEMPTS
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.requestRelayReservation();
      if (await this.waitForRelayReservation()) return true;
      if (this.intentionalDisconnect || !this.node) return false;
      if (attempt === attempts - 1) break;
      const wait = Math.min(
        RELAY_DIAL_BASE_MS * 2 ** attempt,
        RELAY_DIAL_MAX_MS
      );
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait * 0.3));
    }
    return false;
  }

  private scheduleRelayReconnect(): void {
    if (this.intentionalDisconnect || this.relayReconnectTimer || !this.node)
      return;

    this.emit("status", {
      type: "relay-reconnecting",
      message: "Reconnecting to relay...",
    });

    const base = this.relayReconnectDelay;
    const delay = base + Math.random() * base * 0.3;
    this.relayReconnectDelay = Math.min(base * 2, RELAY_RECONNECT_MAX_MS);
    rec(
      ev("relay.reconnect.schedule", { d: { delayMs: Math.round(delay) } })
    );

    this.relayReconnectTimer = setTimeout(async () => {
      this.relayReconnectTimer = null;
      if (this.intentionalDisconnect || !this.node) return;
      // A radio that is down cannot be dialled into; the "online" listener
      // restarts this the moment it comes back.
      if (this.offline) {
        this.scheduleRelayReconnect();
        return;
      }

      try {
        await this.dialRelay();
        if (!(await this.reserveWithRetries())) {
          // Dialled but unreachable: a browser cannot listen, so with no
          // circuit nobody can open a stream to us and this connection is
          // worth nothing. Say so and let the app rebuild the node - which
          // is also the only thing that clears libp2p's relay filter after
          // a reservation DialError poisons it.
          console.warn("[Transport] relay reconnect got no reservation");
          rec(ev("relay.reservation.timeout", { d: { phase: "reconnect" } }));
          this.emit("status", {
            type: "relay-reservation-failed",
            message: "Relay would not reserve a slot - reconnecting...",
          });
          return;
        }
        this.relayReconnectDelay = RELAY_RECONNECT_DELAY_MS;
        // startRendezvous re-registers all joinedRooms internally
        this.startRendezvous();
      } catch (err) {
        console.warn("[Transport] relay reconnect failed, retrying:", err);
        rec(ev("relay.reconnect.fail", { d: { err: errText(err) } }));
        this.emit("status", {
          type: "relay-reconnect-failed",
          message: "Relay reconnect failed - retrying...",
        });
        this.scheduleRelayReconnect();
      }
    }, delay);
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
          DIRECT_MSG_PROTOCOL,
          { runOnLimitedConnection: true }
        );
        this.debugStats.dialStreamOpens++;
      }
    } else {
      stream = await this.node.dialProtocol(
        peerIdFromString(peerId),
        DIRECT_MSG_PROTOCOL,
        { runOnLimitedConnection: true }
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
      void this.writeFrame(peerId, stream, pingFrame(nonce));
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
        rec(ev("stream.confirm.fail", { peer: peerId, d: { attempts } }));
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
    // The only proof anything can actually reach this peer - see
    // confirmedStreams and streamProven's own doc for why connectedPeers
    // alone was never enough.
    this.emit("streamProven", peerId);
    const timer = this.confirmTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.confirmTimers.delete(peerId);
    }
    const queued = this.pendingQueues.get(peerId) ?? [];
    this.pendingQueues.delete(peerId);
    for (const entry of queued) {
      void this.writeFrame(peerId, stream, entry.data).then(entry.resolve);
    }
  }

  /**
   * How long a buffered frame may take to drain before the stream is
   * declared dead: half a minute, plus a floor of 20 KB/s for its size. A
   * 2.5 MB sync batch over a relayed or TURN path gets about two and a half
   * minutes, which a link that is merely slow meets and a dead one never
   * does.
   */
  private async writeFrame(
    peerId: string,
    stream: Stream,
    data: Uint8Array
  ): Promise<boolean> {
    if (!streamIsOpen(stream)) {
      this.cleanupPeerStream(peerId);
      return false;
    }
    try {
      const ok = stream.send(encodeFrame(data));
      this.debugStats.framesOut++;
      if (ok) return true;
      // A false return means the frame is BUFFERED, not flushed. Resolving
      // true here let send() report success for a frame that later dropped
      // on backpressure - and the DM layer deletes a message from its
      // persisted queue on true, so an optimistic true here destroyed it.
      // Report the real outcome once the stream actually drains - within a
      // budget. A far end that stopped reading (a phone asleep mid
      // transfer) never sends the window update yamux waits for, and this
      // await used to sit forever, which every caller inherited: the device
      // sync parked at its last percentage with no error. The budget scales
      // with the frame so a slow, alive link is not mistaken for a dead one.
      let budget: ReturnType<typeof setTimeout> | null = null;
      const stalled = new Promise<false>((resolve) => {
        budget = setTimeout(() => resolve(false), drainBudgetMs(data.byteLength));
      });
      const drained = await Promise.race([
        stream.onDrain().then(
          () => true,
          () => false
        ),
        stalled,
      ]);
      if (budget) clearTimeout(budget);
      if (!drained) {
        rec(
          ev("stream.write.fail", {
            peer: peerId,
            d: { err: "drain-timeout", bytes: data.byteLength },
          })
        );
        this.cleanupPeerStream(peerId);
      }
      return drained;
    } catch (err) {
      console.warn(`[LibP2PTransport] write failed for ${peerId}:`, err);
      rec(
        ev("stream.write.fail", {
          peer: peerId,
          d: { err: errText(err), bytes: data.byteLength },
        })
      );
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
    // Frames out of the stream's chunks, each byte copied once: see
    // frame-assembler.ts for why merging per chunk had to go.
    const assembler = new FrameAssembler(MAX_DIRECT_FRAME_BYTES);

    stream.addEventListener("message", (evt: StreamMessageEvent) => {
      const chunk: Uint8Array =
        evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();

      let frames: Uint8Array[];
      try {
        frames = assembler.push(chunk);
      } catch (err) {
        const len = err instanceof FrameTooLargeError ? err.bytes : -1;
        console.warn(
          `[LibP2PTransport] oversized direct frame (${len}b) from ${fromId.slice(-8)}, aborting stream`
        );
        rec(ev("rv.frame.oversize", { peer: fromId, d: { bytes: len } }));
        this.cleanupPeerStream(fromId);
        stream.abort(new Error("frame too large"));
        return;
      }

      for (const payload of frames) {

        // Anything at all from this peer proves it is alive.
        this.debugStats.framesIn++;
        this.lastInbound.set(fromId, Date.now());
        this.pingMisses.delete(fromId);

        // Liveness frames are ours, not the app's.
        if (payload.byteLength <= MAX_LIVENESS_FRAME_BYTES) {
          let live: { type?: string; n?: number; w?: number } | null = null;
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
              void this.writeFrame(fromId, out, reply);
            } else {
              void this.send(fromId, reply);
            }
            continue;
          }
          if (live?.type === "__pong") {
            this.debugStats.pongsIn++;
            if (typeof live.n === "number") {
              const probe = this.rttProbes.get(live.n);
              if (probe) {
                this.rttProbes.delete(live.n);
                // A clock probe wants the remote wall timestamp; an RTT
                // probe deliberately ignores it. Timed on this side only:
                // subtracting timestamps taken on two machines would measure
                // their clock disagreement, which is unbounded, not the
                // round trip.
                probe.settleClock?.(
                  typeof live.w === "number" && Number.isFinite(live.w)
                    ? live.w
                    : null
                );
                probe.settle(performance.now() - probe.sentAt);
              }
            }
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
    rec(ev("stream.reset", { peer: peerId }));
    const wasProven = this.confirmedStreams.has(stream);
    this.peerStreams.delete(peerId);
    this.confirmNonces.delete(peerId);
    try {
      stream.abort(new Error("peer reopened its stream"));
    } catch {}
    if (wasProven) this.emit("streamLost", peerId);
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
      // Withdraw proof only if this stream actually held it - most callers
      // tear down a stream that never confirmed, and announcing a loss that
      // was never a gain would just be noise.
      const wasProven = this.confirmedStreams.has(stream);
      stream.abort(new Error("cleanup"));
      this.peerStreams.delete(peerId);
      if (wasProven) this.emit("streamLost", peerId);
    }
    this.failPendingQueue(peerId);
    this.openingStreams.delete(peerId);
  }

  private async startRendezvous(): Promise<void> {
    if (this.intentionalDisconnect || !this.node || !this.relayPeerId) return;
    if (this.rendezvousStarting) return;
    this.rendezvousStarting = true;

    const selfId = this.node.peerId.toString();

    let stream: Stream;
    try {
      stream = await this.node.dialProtocol(
        peerIdFromString(this.relayPeerId),
        RENDEZVOUS_PROTOCOL,
        { runOnLimitedConnection: true }
      );
    } catch (err) {
      this.rendezvousStarting = false;
      console.warn("[Rendezvous] failed to open stream, retrying:", err);
      this.emit("status", {
        type: "rendezvous-failed",
        message: "Failed to connect to relay - retrying...",
      });
      this.scheduleRendezvousRetry();
      return;
    }

    // Take the reference first, then retire the old stream. The close handler
    // below bails out when it is no longer the current stream, so aborting
    // before the assignment would make the outgoing stream wipe its own
    // replacement and schedule a needless reconnect.
    const previous = this.rendezvousStream;
    this.rendezvousStream = stream;
    this.rendezvousReadBuf = new Uint8Array(0);
    this.rendezvousStarting = false;
    if (previous && previous !== stream) {
      previous.abort(new Error("rendezvous stream superseded"));
    }
    // A stream is open, by this path or the relay reconnect's: any retry
    // still waiting would only open another to supersede it.
    if (this.rendezvousRetryTimer) {
      clearTimeout(this.rendezvousRetryTimer);
      this.rendezvousRetryTimer = null;
    }
    const openedAt = Date.now();

    this.startRendezvousPing(stream);

    // re-register all rooms after rendezvous reconnect
    for (const room of this.joinedRooms) {
      this.rendezvousSend({ type: "REGISTER", room });
    }
    // Lobbies after the rooms, and later: see holdDmLobby.
    this.lobbyRegistered.clear();
    if (this.dmLobbies.size > 0) this.scheduleLobbyRegistration();

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
          // The relay is answering: the next drop starts from the first delay.
          if (this.rendezvousStream === stream) {
            this.rendezvousRetryDelay = RENDEZVOUS_RECONNECT_DELAY_MS;
          }
          this.handleRendezvousMsg(selfId, msg);
        } catch (err) {
          // Swallowing this lost the frame with no signal and no reconnect.
          // The liveness ping keeps answering the relay, so the relay never
          // notices that this stream's read side is dead. Abort instead, the
          // way the oversized-frame branch above already does, and let the
          // close handler reconnect.
          console.warn(
            "[Rendezvous] failed to process frame, aborting stream:",
            err
          );
          rec(
            ev("rv.send.fail", {
              d: { phase: "inbound", err: errText(err) },
            })
          );
          this.rendezvousReadBuf = new Uint8Array(0);
          stream.abort(
            err instanceof Error
              ? err
              : new Error("rendezvous frame processing failed")
          );
          return;
        }
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
      rec(ev("rv.close"));
      this.stopRendezvousPing();
      this.rendezvousStream = null;
      if (!this.intentionalDisconnect && this.node) {
        console.warn("[Rendezvous] stream closed, reconnecting");
        this.emit("status", {
          type: "rendezvous-reconnecting",
          message: "Relay disconnected - reconnecting...",
        });
        // A stream that served for a ping interval was a working one, even
        // from a relay too old to answer: this drop is the first of its kind.
        // One closed straight after opening keeps the backoff where it is.
        if (Date.now() - openedAt >= RENDEZVOUS_PING_INTERVAL_MS) {
          this.rendezvousRetryDelay = RENDEZVOUS_RECONNECT_DELAY_MS;
        }
        this.scheduleRendezvousRetry();
      }
    });
  }

  /**
   * Open the rendezvous again, after the current backoff. One retry at a
   * time: a failed open and a closed stream can both ask for the same drop.
   * Nothing is dialled while the radio is down; coming back online repairs
   * the relay link, which reopens the rendezvous itself.
   */
  private scheduleRendezvousRetry(): void {
    if (this.rendezvousRetryTimer || this.intentionalDisconnect || !this.node) return;
    const base = this.rendezvousRetryDelay;
    this.rendezvousRetryDelay = Math.min(base * 2, RENDEZVOUS_RECONNECT_MAX_MS);
    this.rendezvousRetryTimer = setTimeout(() => {
      this.rendezvousRetryTimer = null;
      if (this.offline) {
        this.scheduleRendezvousRetry();
        return;
      }
      void this.startRendezvous();
    }, base + Math.random() * base * 0.3);
  }

  private stopRendezvousRetry(): void {
    if (this.rendezvousRetryTimer) clearTimeout(this.rendezvousRetryTimer);
    this.rendezvousRetryTimer = null;
    this.rendezvousRetryDelay = RENDEZVOUS_RECONNECT_DELAY_MS;
  }

  /**
   * Prove to the relay that a registered stream is still alive. The relay
   * gives a registered stream no read deadline of its own beyond three
   * missed intervals, so a peer whose network vanished without a TCP close
   * stayed advertised in its rooms and every other member kept dialling a
   * peer that was not there.
   */
  private startRendezvousPing(stream: Stream): void {
    this.stopRendezvousPing();
    this.rendezvousPingsSincePong = 0;
    this.rendezvousPingTimer = setInterval(() => {
      if (this.rendezvousStream !== stream) {
        this.stopRendezvousPing();
        return;
      }
      // The PING proved WE were alive to the relay and nothing proved the
      // relay was alive to us - so a link that stopped carrying frames in
      // our direction was invisible, and every peer the rendezvous would
      // have named simply never appeared.
      if (
        this.rendezvousPongSeen &&
        this.rendezvousPingsSincePong >= RENDEZVOUS_PONG_MISSES_ALLOWED
      ) {
        this.dropHalfOpenRendezvous(
          stream,
          `${this.rendezvousPingsSincePong} unanswered pings`
        );
        return;
      }
      this.rendezvousPingsSincePong++;
      this.rendezvousSend({ type: "PING" });
    }, RENDEZVOUS_PING_INTERVAL_MS);
  }

  private stopRendezvousPing(): void {
    if (this.rendezvousPingTimer === null) return;
    clearInterval(this.rendezvousPingTimer);
    this.rendezvousPingTimer = null;
  }

  private rendezvousSend(msg: RendezvousClientMsg): void {
    if (!this.rendezvousStream) return;
    if (msg.type === "REGISTER" || msg.type === "UNREGISTER") {
      rec(
        ev(msg.type === "REGISTER" ? "rv.register" : "rv.unregister", {
          room: refs().roomRef(msg.room),
        })
      );
    }
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);
    try {
      this.rendezvousStream.send(frame);
    } catch (err) {
      console.warn("[Rendezvous] send failed:", err);
      rec(ev("rv.send.fail", { d: { err: errText(err) } }));
    }
  }

  private async dialPeer(peerId: string, attempt = 0): Promise<void> {
    if (!this.node || this.connectedPeers.has(peerId)) return;
    // Every dial below rides the relay circuit, and with no network there is
    // no circuit - the whole sweep would just burn the radio.
    if (this.offline) return;
    if (shouldBlockDial(peerId)) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);
    rec(
      ev("peer.dial.start", { peer: peerId, d: { attempt, viaWebrtc: true } })
    );

    try {
      const relayAddr = relayMultiaddr();
      const withWebRTC = multiaddr(
        `${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`
      );
      const withoutWebRTC = multiaddr(`${relayAddr}/p2p-circuit/p2p/${peerId}`);

      try {
        if (shouldBlockWebrtcDial()) throw new Error("webrtc dial blocked");
        await this.node.dial(withWebRTC);
        return;
      } catch (err) {
        rec(
          ev("peer.dial.fail", {
            peer: peerId,
            d: { form: "webrtc", err: errText(err) },
          })
        );
      }

      try {
        await this.node.dial(withoutWebRTC);
      } catch (err) {
        // ponytail: 3 attempts with linear backoff; enough for transient
        // reservation races without hammering an offline peer. Jittered
        // like the relay dial - both sides of a pair learn about each
        // other from the same rendezvous reply and would otherwise retry
        // in lockstep and lose the same reservation race every time.
        if (attempt < 2 && !this.intentionalDisconnect) {
          const wait = PEER_REDIAL_DELAY_MS * (attempt + 1);
          setTimeout(
            () => this.dialPeer(peerId, attempt + 1).catch(() => {}),
            wait + Math.random() * wait * 0.3
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
            peerId,
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
      case "PONG": {
        this.rendezvousPongSeen = true;
        this.rendezvousPongAt = Date.now();
        this.rendezvousPingsSincePong = 0;
        break;
      }
      case "PEERS": {
        if (this.isDmLobby(msg.room)) {
          for (const peerId of msg.peers ?? []) this.lobbyPeer(msg.room as DiscoveryId, peerId);
          break;
        }
        for (const peerId of msg.peers ?? []) {
          if (peerId === selfId) continue;
          this.rememberRoomPeer(msg.room, peerId);
          if (msg.room.startsWith("rd2_")) {
            this.verifyDiscoveredRoomPeer(msg.room, peerId);
            continue;
          }
          if (this.connectedPeers.has(peerId)) continue;
          this.dialPeer(peerId).catch(() => {});
        }
        // Peers we were ALREADY connected to fire no connect event, so
        // without this nothing would reconcile history with them until the
        // repair tick came round - digests are gated on membership, and this
        // reply is where membership becomes known.
        this.emit("roomPeers", this.localRoom(msg.room), this.peersInRoom(msg.room));
        break;
      }
      case "PEER_JOINED": {
        const peerId = msg.peer;
        if (peerId === selfId) break;
        if (this.isDmLobby(msg.room)) {
          this.lobbyPeer(msg.room as DiscoveryId, peerId);
          break;
        }
        this.rememberRoomPeer(msg.room, peerId);
        if (msg.room.startsWith("rd2_")) {
          this.verifyDiscoveredRoomPeer(msg.room, peerId);
          break;
        }
        if (this.connectedPeers.has(peerId)) {
          if (!msg.room.startsWith("rd2_")) this.emit("roomPeers", msg.room, [peerId]);
        }
        if (this.connectedPeers.has(peerId)) break;
        this.dialPeer(peerId).catch(() => {});
        break;
      }
      case "PEER_LEFT": {
        // Stop retrying somebody who has gone.
        this.roomPeers.get(msg.room)?.delete(msg.peer);
        this.nextDialAt.delete(msg.peer);
        // And stop counting them in. A channel still open keeps them until it
        // closes; a closed one is no longer theirs to reopen, and if they come
        // back the fresh channel is news again, catch-up and all.
        this.roomMembers.get(msg.room as DiscoveryId)?.delete(msg.peer);
        this.roomProveRetry.delete(`${msg.room}\n${msg.peer}`);
        // Nor may a send over one still open count them back in: this can land
        // before the reset of the channel their leaving closed. One proven
        // after it is a member back, and counts.
        for (const entry of this.secureStreams) {
          if (entry.room === msg.room && entry.peer === msg.peer && entry.channel) entry.departed = true;
        }
        break;
      }
    }
  }

  /** Resolves true once the circuit reservation is live, false on timeout. */
  private waitForRelayReservation(): Promise<boolean> {
    return new Promise((resolve) => {
      // Captured once: a reconnect landing mid-wait replaces this.node, and
      // removing the listener from the NEW node left it attached to the OLD
      // one forever - and a late fire on the old node's closure could read
      // the new node's addresses and resolve THIS promise from them.
      const node = this.node;
      if (!node) return resolve(false);
      const ownId = node.peerId.toString();

      const deadline = setTimeout(() => {
        console.warn(
          "[Transport] relay reservation timed out, addrs:",
          node.getMultiaddrs().map((a) => a.toString())
        );
        node.removeEventListener("self:peer:update", check);

        this.emit("status", {
          type: "reservation-timeout",
          message: "Relay reservation timed out - you may not be reachable",
        });
        resolve(false);
      }, RELAY_RESERVATION_TIMEOUT_MS);

      const check = () => {
        const addrs = node.getMultiaddrs();
        const circuit = addrs.find((ma) => {
          const s = ma.toString();
          return s.includes("/p2p-circuit") && s.endsWith(`/p2p/${ownId}`);
        });
        if (circuit) {
          console.log("[Transport] relay reservation ok:", circuit.toString());
          rec(ev("relay.reservation.ok", { d: { circuit: true } }));
          clearTimeout(deadline);
          node.removeEventListener("self:peer:update", check);
          resolve(true);
        }
      };

      node.addEventListener("self:peer:update", check);
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

    const was = this.relayedPeers.has(peerId);
    if (hasDirect) this.relayedPeers.delete(peerId);
    else this.relayedPeers.add(peerId);
    if (was !== !hasDirect) this.emit("relayChanged", peerId, !hasDirect);
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
    const suppressed = shouldSuppressEvent(event as string);
    recTransportEvent(event as string, args, suppressed, this.diagBus);
    if (suppressed) return;
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
