import { MediasoupVideo } from "./mediasoup";
import { identityStore } from "../identity/identity.svelte";
import {
  getOwnProfile,
  putMessage,
  bulkPutMessages,
  getMessages,
  getAllMessages,
  getWatermarksForRoom,
  setWatermark,
  markRoomSeen,
  markOwnMessagesReadUpTo,
  PAGE_SIZE,
  nextDmLamport,
  getPeerProfile,
  putPeerProfile,
  getAllPeerProfiles,
  putAttachment,
  getAttachmentsByMessage,
  updateMessageStatus,
  getMessage,
  getRoomParticipants,
  addRoomParticipant,
  removeRoomParticipant,
  updateParticipantLastSeen,
  cleanupInactiveParticipants,
} from "../storage";
import {
  MessageType,
  wireToMessage,
  messageToWire,
  type Message,
  type ChatMessageType,
  type AnyWireMessage,
  type WireChatMessage,
  type WireProfile,
  type WireRoomName,
  type WireRoomUsersSync,
  type WireCallState,
  type FileEntry,
  type FileMeta,
  type Attachment,
} from "../types/message";
import {
  refreshUnreadCount,
  removeRoom,
  refreshDmRooms,
  renameRoom,
  noteRoomActivity,
  roomsStore,
} from "../rooms.svelte";
import { WebTorrentFileTransport } from "./file/webtorrent";
import type { FileDescriptor, FileTransferSnapshot } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
import { refreshTurnCredentials } from "./ice-server-list";
import { LibP2PVoice } from "./libp2p/voice";
import { DtlnProcessor } from "../audio/dtln-processor";
import { requireSession } from "../identity/identity";
import { deviceKeySeed } from "./device-key";
import { looksLikeDid, looksLikePeerId } from "../identity/identity-utils";
import {
  canonicalFor,
  signMessage,
  signPeerBinding,
  verifyPeerBinding,
  verifySignature,
} from "../messaging";
import { encode, decode, normalizeAvatarUrl, normalizeNicknameColor } from "../utils";
import { _sendCallPresence, _sendCallState, leaveCall } from "./call.svelte";
import { _sendWatchPresence } from "./transmission.svelte";
import {
  type DmPayload,
  encodeDmAckEnvelope,
  encodeDmReadEnvelope,
  parseDmEnvelope,
} from "./dm-codec";
import {
  ensureDmRoomForPeer,
  flushQueuedDmForPeer,
  joinPhonebookDmRooms,
  resolveDmDisplayName,
  sendDirectMessage,
} from "./dm.svelte";
import {
  _hydrateFileTransfersFromStorage,
  _resumeAttachmentSeeding,
  fileFingerprint,
  initFiles,
  isFileSignalWireMessage,
  maybePeerIdFromSenderId,
  shouldAutoDownload,
  withFileTransfer,
} from "./files.svelte";
import { initVoice } from "./voice.svelte";
import { initTransmission } from "./transmission.svelte";
import { notifyMessage } from "../notify.svelte";

const MSG_ORDER = (a: Message, b: Message) =>
  a.lamport !== b.lamport
    ? a.lamport - b.lamport
    : a.senderId.localeCompare(b.senderId);

/**
 * Messages almost always arrive in order, so appending is the common case;
 * only fall back to a full sort when the newcomer actually lands out of order.
 * Re-sorting the whole history per incoming message scaled with room size.
 */
export function appendSorted(
  list: Message[],
  msg: Message,
  cmp: (a: Message, b: Message) => number = MSG_ORDER
): Message[] {
  const next = [...list, msg];
  if (list.length > 0 && cmp(list[list.length - 1], msg) > 0) next.sort(cmp);
  return next;
}
import { playPeerJoinSound, playPeerLeaveSound } from "../sounds";
import { peerCallChime } from "./call-chime";

export type { Message };

// ── State shapes ──────────────────────────────────────────────────────────────

interface SendMessageOptions {
  replyTo?: Message["replyTo"];
  type?: ChatMessageType;
  meta?: FileMeta;
  attachments?: string[];
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

export interface ParticipantState {
  peerId: string;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
}

interface TransportState {
  relayConnected: boolean;
  connected: boolean;
  connecting: boolean;
  roomCode: string | null;
  /**
   * The conversation the USER is looking at, set by the view layer. Not the
   * same as roomCode, which is what the transport has open: on the landing
   * screen roomCode keeps its value while nothing is on screen - suppressing
   * message sounds by roomCode muted messages the user could not see.
   */
  uiRoomCode: string | null;
  roomName: string;
  peers: string[];
  roomUsers: string[];
  messages: Message[];
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
  participants: Map<string, ParticipantState>;
  localCameraStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  localMicStream: MediaStream | null;
  cameraOff: boolean;
  screenSharing: boolean;
  peerNames: Map<string, string>;
  /** Bumped on every peer->DID mapping change; see peerIdToDid(). */
  peerDidVersion: number;
  peerAvatars: Map<string, string>;
  /** User-picked nickname colors, keyed like peerNames (by DID). */
  peerColors: Map<string, string>;
  error: string | null;
  callPeerIds: Set<string>;
  callPeerRooms: Map<string, string>; // peerId -> roomCode they're calling in
  transmissionViewers: Map<string, Set<string>>; // sharer peerId -> viewer peerIds
  sfuPeerIds: Set<string>;
  pendingTransmissions: Map<string, string>;
  watchingTransmissionPeerId: string | null;
  watchingTransmissionProducerId: string | null;
  transmissionOutputVolume: number;
  fileTransfers: Map<string, FileTransferSnapshot>;
  callPeerStates: Map<string, { muted: boolean; deafened: boolean }>;
  chatMode: "room" | "dm";
  activeDmPeerId: string | null;
  dmVersion: number;
  callRoomCode: string | null;
}

export const transportState = $state<TransportState>({
  relayConnected: false,
  connected: false,
  connecting: false,
  roomCode: null,
  uiRoomCode: null,
  roomName: "",
  peers: [],
  roomUsers: [],
  messages: [],
  inCall: false,
  muted: false,
  deafened: false,
  participants: new Map(),
  localCameraStream: null,
  localScreenStream: null,
  localMicStream: null,
  cameraOff: true,
  screenSharing: false,
  peerNames: new Map(),
  peerDidVersion: 0,
  peerAvatars: new Map(),
  peerColors: new Map(),
  error: null,
  callPeerIds: new Set(),
  callPeerRooms: new Map(),
  transmissionViewers: new Map(),
  sfuPeerIds: new Set(),
  pendingTransmissions: new Map(),
  watchingTransmissionPeerId: null,
  watchingTransmissionProducerId: null,
  transmissionOutputVolume: 1,
  fileTransfers: new Map(),
  callPeerStates: new Map(),
  chatMode: "room",
  activeDmPeerId: null,
  dmVersion: 0,
  callRoomCode: null,
});

let _lamport = 0;
let _connectPromise: Promise<void> | null = null;

const BATCH_SIZE = 20;
export const MAX_PERSISTED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const _peerIdToDid = new Map<string, string>();

/** Dev-only counters. Presence bugs are invisible without them: everything
 *  looks connected while a profile is quietly rejected. */
const _stats = {
  profilesOut: 0,
  profilesIn: 0,
  profilesRejected: 0,
  digestsOut: 0,
  digestsIn: 0,
};

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle: presence and profile bugs are only reproducible with two
  // real peers, and there is no other way to see this state from a test.
  (window as unknown as Record<string, unknown>).__awful = {
    state: transportState,
    peerIdToDid: _peerIdToDid,
    stats: _stats,
    transportStats: () => _transport.debugStats,
    selfId: () => _transport.selfId(),
    node: () => _transport.p2pNode,
    sendReply,
    toggleReaction,
    sendFiles,
    sendMessage,
    _handleCallPresence,
  };
}

/**
 * DM frames that arrived before the sender's DID was known, replayed once the
 * binding lands. Bounded: an unbound peer must not be able to make us buffer
 * without limit.
 */
type PendingDm = { payload: DmPayload };
const _pendingDmByPeer = new Map<string, PendingDm[]>();
const MAX_PENDING_DM_PER_PEER = 32;

function _replayPendingDm(peerId: string, senderDid: string): void {
  const pending = _pendingDmByPeer.get(peerId);
  if (!pending?.length) return;
  _pendingDmByPeer.delete(peerId);
  for (const envelope of pending) _handleDmChat(peerId, senderDid, envelope);
}

/** Mutate the peer->DID map through here so reactive readers are notified. */
function _setPeerDid(peerId: string, did: string): void {
  if (_peerIdToDid.get(peerId) === did) return;
  _peerIdToDid.set(peerId, did);
  _profileRepair.delete(peerId);
  transportState.peerDidVersion += 1;
}
const _seededByFingerprint = new Map<string, FileDescriptor>();

export const _dtln = new DtlnProcessor();
_dtln.init().catch(console.error);
export const _transport = new LibP2PTransport();
export const _voice = new LibP2PVoice(_transport, _dtln);
export const _video = new MediasoupVideo();
export const _fileTransport = new WebTorrentFileTransport(() =>
  _transport.selfId()
);

// Initialize submodules that depend on transport instances
// Order matters: they receive instances from here
initVoice(_voice, _dtln);
initTransmission(_video);
initFiles(_fileTransport);

const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3 } as const;

/**
 * Advance a message's delivery status (never regress: a late "delivered"
 * ack must not overwrite "read"). Updates IDB and the in-memory list.
 */
export function applyMessageStatus(
  messageId: string,
  status: keyof typeof STATUS_RANK
): void {
  updateMessageStatus(messageId, status).catch(() => {});
  const idx = transportState.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const current = transportState.messages[idx].status;
  if (current && STATUS_RANK[current] >= STATUS_RANK[status]) return;
  const next = [...transportState.messages];
  next[idx] = { ...next[idx], status };
  transportState.messages = next;
}

async function _cascadeReadAcks(messageIds: string[]): Promise<void> {
  const self = selfId();
  const maxByRoom = new Map<string, number>();
  for (const id of messageIds) {
    const m = await getMessage(id);
    if (!m || !isSelfSender(m.senderId)) continue;
    maxByRoom.set(
      m.roomCode,
      Math.max(maxByRoom.get(m.roomCode) ?? 0, m.lamport)
    );
  }
  for (const [roomCode, lamport] of maxByRoom) {
    const changed = await markOwnMessagesReadUpTo(roomCode, self, lamport);
    if (!changed.length) continue;
    const changedSet = new Set(changed);
    transportState.messages = transportState.messages.map((m) =>
      changedSet.has(m.id) ? { ...m, status: "read" } : m
    );
  }
}

function lamportSend(): number {
  _lamport += 1;
  return _lamport;
}

function lamportReceive(remote: number): void {
  _lamport = Math.max(_lamport, remote) + 1;
}

if (typeof window !== "undefined") {
  const onUnload = () => {
    for (const transfer of transportState.fileTransfers.values()) {
      if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
    }
    // Say goodbye. Without it the other side keeps a connection that looks
    // alive, holds the stream it belongs to, and quietly writes into nothing
    // when we come back. Best effort: an unloading page gets no async time,
    // but the peers that do hear it recover instantly instead of waiting for
    // the reconcile to notice.
    _transport.disconnect();
  };
  window.addEventListener("pagehide", onUnload);
  window.addEventListener("beforeunload", onUnload);
}

// ── Senders ───────────────────────────────────────────────────────────────────

function _sendRoomName(peerId?: string): void {
  const roomCode = transportState.roomCode;
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name || !roomCode) return;
  // roomCode travels with it: a direct send has no topic to infer it from, so
  // the receiver used to apply the name to whatever room they had open.
  const payload = encode({ type: MessageType.RoomName, name, roomCode });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, roomCode);
}

async function _sendProfile(peerId?: string, isReply = false): Promise<void> {
  const profile = await getOwnProfile();
  const name = profile?.nickname?.trim() || "Anonymous";
  const did = identityStore.did ?? null;
  let avatarUrl: string | null = profile?.pfpURL || null;
  if (!avatarUrl && profile?.pfpData) {
    const bytes = new Uint8Array(profile.pfpData);
    const binary = Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join("");
    avatarUrl = `data:image/jpeg;base64,${btoa(binary)}`;
  }

  // Prove this DID owns our peerId; the receiver cannot derive it any more.
  let binding: { did: string; bindingSig: string } | null = null;
  try {
    binding = signPeerBinding(_transport.selfId());
  } catch {
    binding = null; // identity locked: the peer just will not bind us yet
  }

  _stats.profilesOut++;
  const payload = encode({
    type: MessageType.Profile,
    name,
    did,
    avatarUrl,
    color: profile?.color ?? null,
    peerId: _transport.selfId(),
    bindingSig: binding?.bindingSig,
    reply: isReply || undefined,
  });

  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }

  // Reach everyone who could care: every room we are in (not just the one on
  // screen) and every connected peer directly. A single broadcast to the
  // active room missed peers in other shared rooms, and was silently dropped
  // when the gossipsub mesh had not formed yet - which is why a changed
  // nickname or avatar often never showed up for anyone.
  for (const room of _transport.rooms()) {
    _transport.broadcast(payload, room);
  }
  for (const pid of _transport.peers()) {
    _transport.send(pid, payload).catch(() => {});
  }
}

async function _broadcastProfile(): Promise<void> {
  await _sendProfile().catch(() => {});
}

/**
 * Digests are cheap (one number per sender) and idempotent, so the recovery
 * story is "exchange one whenever there is reason to think we drifted" rather
 * than polling. Debounced per peer so a burst of reasons costs one digest.
 */
const SYNC_DEBOUNCE_MS = 10_000;
const _lastDigestAt = new Map<string, number>();
/** "room|senderId" -> highest lamport we have seen, for the gap hint above. */
const _lastSeenLamport = new Map<string, number>();

function _syncPeer(peerId: string, force = false): void {
  const now = Date.now();
  if (!force && now - (_lastDigestAt.get(peerId) ?? 0) < SYNC_DEBOUNCE_MS) {
    return;
  }
  _lastDigestAt.set(peerId, now);
  _sendDigest(peerId).catch(() => {});
}

/** Reconcile with everyone we are connected to. */
function _syncAllPeers(force = false): void {
  for (const pid of _transport.peers()) _syncPeer(pid, force);
}

/**
 * Per-peer repair tick. Event-driven sync covers everything EXCEPT the case
 * where the last event is the one that got lost: a message that misses its
 * delivery window has no later event to recover it, and a profile reply that
 * vanishes leaves the peer unbound forever. Measured directly in the churn
 * scenario - after three reloads everything settles and the final message
 * just sits on one side.
 *
 * This is not global polling: it only speaks up for a peer in an abnormal
 * state - connected but never identified, or silent at the app level for a
 * while. A healthy, active mesh sends nothing.
 */
const REPAIR_TICK_MS = 15_000;
const APP_SILENCE_MS = 15_000;
const PROFILE_REPAIR_MAX_MS = 5 * 60_000;
const _lastAppInbound = new Map<string, number>();
const _profileRepair = new Map<string, { next: number; delay: number }>();

if (typeof window !== "undefined") {
  setInterval(() => {
    // Same rule as the liveness probe: a hidden tab has no UI to keep honest
    // and a phone radio to leave alone - returning to the page runs a full
    // resync anyway.
    if (typeof document !== "undefined" && document.hidden) return;
    for (const pid of _transport.peers()) {
      if (!_peerIdToDid.has(pid)) {
        // Connected but unbound: our profile (or their reply) was lost.
        // Backed off per peer: a peer that can NEVER bind (locked identity,
        // old build) would otherwise receive the full profile - avatar
        // payload included - every 15s for the whole session.
        const repair = _profileRepair.get(pid) ?? { next: 0, delay: 0 };
        if (Date.now() >= repair.next) {
          repair.delay = Math.min(
            Math.max(repair.delay * 2, REPAIR_TICK_MS),
            PROFILE_REPAIR_MAX_MS
          );
          repair.next = Date.now() + repair.delay;
          _profileRepair.set(pid, repair);
          // Catch: getOwnProfile can reject (blocked IDB upgrade,
          // private-mode quota).
          _sendProfile(pid).catch(() => {});
        }
        continue;
      }
      const quietFor = Date.now() - (_lastAppInbound.get(pid) ?? 0);
      if (quietFor > APP_SILENCE_MS) {
        // Alive (liveness pings hold the connection) but silent: verify we
        // did not miss anything. One digest, a number per sender.
        _syncPeer(pid, true);
      }
    }

    // Call-roster ghosts: an entry neither refreshed by presence heartbeats
    // nor backed by a live voice link within the TTL is gone - remove it so
    // the sidebar group and the call status stop counting a phantom.
    if (transportState.callPeerRooms.size > 0) {
      const live = new Set(_voice?.activePeers() ?? []);
      const now = Date.now();
      let purged = false;
      const roomNext = new Map(transportState.callPeerRooms);
      const idsNext = new Set(transportState.callPeerIds);
      const statesNext = new Map(transportState.callPeerStates);
      for (const [pid] of transportState.callPeerRooms) {
        if (live.has(pid)) {
          _callPeerSeen.set(pid, now);
          continue;
        }
        const seen = _callPeerSeen.get(pid) ?? 0;
        if (seen === 0) {
          // Pre-TTL entry (or restored state): start its clock now.
          _callPeerSeen.set(pid, now);
          continue;
        }
        if (now - seen > CALL_PRESENCE_TTL_MS) {
          // For everyone still in the call this IS a disconnect - same
          // chime as a drop, not a silent vanishing.
          _peerCallSound(roomNext.get(pid), false, idsNext.has(pid));
          roomNext.delete(pid);
          idsNext.delete(pid);
          statesNext.delete(pid);
          _callPeerSeen.delete(pid);
          purged = true;
        }
      }
      if (purged) {
        transportState.callPeerRooms = roomNext;
        transportState.callPeerIds = idsNext;
        transportState.callPeerStates = statesNext;
      }
    }

    // Digests only ever covered the open room, so a room in the background
    // stayed incomplete until the user happened to click into it. Rotate
    // through the other subscribed rooms, one per tick - bounded traffic,
    // and every room heals within a few minutes.
    const backgroundRooms = _transport
      .rooms()
      .filter((r) => r !== transportState.roomCode);
    if (backgroundRooms.length > 0) {
      const room =
        backgroundRooms[_backgroundSyncIndex % backgroundRooms.length];
      _backgroundSyncIndex++;
      for (const pid of _transport.peers()) {
        if (!_peerIdToDid.has(pid)) continue;
        _sendDigestForRoom(pid, room).catch(() => {});
      }
    }
  }, REPAIR_TICK_MS);
}

let _backgroundSyncIndex = 0;

/** Away longer than this and the connections are suspect, not just history. */
const AWAY_FULL_RESYNC_MS = 60_000;
let _hiddenSince = 0;

/**
 * Everything a peer needs to know about us, plus a request for everything we
 * need from them. Cheap enough to fire on returning to the app.
 */
function _resyncEverything(): void {
  _transport.reconcileNow();
  _broadcastProfile().catch(() => {});
  if (transportState.roomCode) _broadcastJoinRoom();
  if (transportState.inCall) {
    _sendCallPresence();
    _sendCallState();
  }
  _syncAllPeers(true);
}

if (typeof document !== "undefined") {
  // Coming back from the background is the big one: a phone that slept has
  // missed whatever happened meanwhile, and nothing inside the app will ever
  // tell it so.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      _hiddenSince = Date.now();
      return;
    }
    const away = _hiddenSince ? Date.now() - _hiddenSince : 0;
    _hiddenSince = 0;
    // A glance away only needs history reconciled. A long absence means the
    // connections themselves may be stale, so re-announce and re-dial too.
    if (away > AWAY_FULL_RESYNC_MS) _resyncEverything();
    else _syncAllPeers();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => _resyncEverything());
}

async function _sendDigest(peerId: string): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  await _sendDigestForRoom(peerId, roomCode);
}

async function _sendDigestForRoom(
  peerId: string,
  roomCode: string
): Promise<void> {
  const watermarks = await getWatermarksForRoom(roomCode);
  _stats.digestsOut++;
  await _transport.send(
    peerId,
    encode({ type: MessageType.SyncDigest, roomCode, watermarks })
  );
}

// ── History ───────────────────────────────────────────────────────────────────

export async function _loadHistory(
  roomCode: string,
  stillCurrent: () => boolean = () => true
): Promise<void> {
  const [msgs, profiles] = await Promise.all([
    getMessages(roomCode),
    getAllPeerProfiles(),
  ]);
  if (!stillCurrent()) return;
  transportState.messages = msgs;
  // DM rooms use wall-clock ms as their lamport - absorbing those here would
  // catapult the shared room clock to ~1.7e12 and skew every room after.
  if (msgs.length > 0 && !roomCode.startsWith("dm-")) {
    _lamport = Math.max(_lamport, ...msgs.map((m) => m.lamport));
  }
  if (profiles.length > 0) {
    const names = new Map(transportState.peerNames);
    const avatars = new Map(transportState.peerAvatars);
    const colors = new Map(transportState.peerColors);
    for (const p of profiles) {
      names.set(p.did, p.nickname);
      if (p.pfpURL) avatars.set(p.did, p.pfpURL);
      if (p.color) colors.set(p.did, p.color);
    }
    transportState.peerNames = names;
    transportState.peerAvatars = avatars;
    transportState.peerColors = colors;
  }

  for (const msg of msgs) {
    if (msg.type !== MessageType.File || !msg.meta?.files?.length) continue;
    for (const file of msg.meta.files) {
      if (transportState.fileTransfers.has(file.infoHash)) continue;
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 0,
      });
    }
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function _handleDigest(
  peerId: string,
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  // Only reconcile a room we have actually joined - never a room the sender
  // merely named, and never fall back to whatever room the UI has open.
  _stats.digestsIn++;
  if (!roomCode || !_transport.rooms().includes(roomCode)) return;
  let mine = await getWatermarksForRoom(roomCode);
  // History written before watermarks existed for this room (all DMs until
  // now) leaves `mine` empty, which reads as "nothing to compare" and makes
  // reconciliation a no-op. Rebuild once from what is actually stored.
  if (Object.keys(mine).length === 0) {
    const stored = await getAllMessages(roomCode);
    for (const m of stored) {
      await setWatermark(m.roomCode, m.senderId, m.lamport);
    }
    if (stored.length) mine = await getWatermarksForRoom(roomCode);
  }

  const theyAreMissing = Object.keys(mine).filter(
    (sid) => (theirWatermarks[sid] ?? -1) < mine[sid]
  );

  if (theyAreMissing.length > 0) {
    await _pushMissingTo(peerId, roomCode, theirWatermarks);
  }

  // A digest only tells the SENDER what they lack, so one exchange heals one
  // direction. If their watermarks show they hold something we do not, send
  // ours back so they push it to us. Without this, whichever side happened to
  // have a reason to sync was the only side that ever caught up. It cannot
  // loop: the reply only goes out when we are genuinely behind.
  const weAreBehind = Object.keys(theirWatermarks).some(
    (sid) => (theirWatermarks[sid] ?? -1) > (mine[sid] ?? -1)
  );
  // Reply for the SAME room: routing through _syncPeer digested whatever
  // room the UI had open, so a background room only ever healed one way.
  if (weAreBehind) _sendDigestForRoom(peerId, roomCode).catch(() => {});
}

async function _pushMissingTo(
  peerId: string,
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!roomCode) return;
  const all = await getAllMessages(roomCode);
  const missing = all.filter(
    (m) => m.lamport > (theirWatermarks[m.senderId] ?? -1)
  );

  if (!missing.length) return;

  const batches: WireChatMessage[][] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    _transport.send(
      peerId,
      encode({
        type: MessageType.SyncBatch,
        roomCode,
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(peerId, encode({ type: MessageType.SyncComplete, roomCode }));
}

async function _handleSyncBatch(
  roomCode: string,
  messages: WireChatMessage[]
): Promise<void> {
  // Bind incoming history to the room named in the (signed-message-bearing)
  // batch, and only if we actually joined it - a peer cannot inject history
  // into whatever room the receiver currently has open.
  if (!messages.length || !roomCode || !_transport.rooms().includes(roomCode))
    return;
  const verdicts = await Promise.all(messages.map(_verifyIncoming));
  const verified = messages.filter((_, i) => verdicts[i]);
  if (verified.length < messages.length) {
    console.warn(
      `[sync] dropped ${messages.length - verified.length} message(s) with invalid signatures`
    );
  }
  if (!verified.length) return;
  const fullMessages = verified.map((w) => wireToMessage(w, roomCode));

  await bulkPutMessages(fullMessages);

  for (const m of fullMessages) {
    // DM lamports are wall-clock ms; absorbing one would catapult the shared
    // room counter to ~1.7e12 and poison every room message sent after.
    if (!roomCode.startsWith("dm-")) lamportReceive(m.lamport);
    await setWatermark(m.roomCode, m.senderId, m.lamport);
  }

  refreshUnreadCount(roomCode).catch(() => {});
  for (const m of fullMessages) noteRoomActivity(m.roomCode, m.timestamp);

  // Storage got everything; the view only takes messages for the room that is
  // actually open (the user may have switched while the batch was in flight),
  // and only inside the loaded window - a backfilled message below it would
  // become messages[0] and break the load-older cursor.
  if (transportState.roomCode !== roomCode) return;
  const windowFloor = transportState.messages[0]?.lamport ?? 0;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newMsgs = fullMessages.filter(
    (m) => !existingIds.has(m.id) && m.lamport >= windowFloor
  );
  if (newMsgs.length > 0) {
    transportState.messages = [...transportState.messages, ...newMsgs].sort(
      MSG_ORDER
    );
  }
}

function _handleSyncComplete(peerId: string): void {
  transportState.messages = [...transportState.messages].sort(MSG_ORDER);
  for (const pid of _transport.peers()) {
    if (pid !== peerId) _sendDigest(pid).catch(() => {});
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

async function _handleProfile(peerId: string, msg: WireProfile): Promise<void> {
  // Bind the DID to the peerId only on a signature over THIS connection's
  // peerId. The `did` field on its own is spoofable, and any peer could
  // otherwise claim someone else's identity and hijack their DM conversation
  // or poison their cached profile.
  _stats.profilesIn++;
  const claimed = msg.did;
  const proven =
    claimed &&
    msg.peerId === peerId &&
    msg.bindingSig &&
    (await verifyPeerBinding(claimed, peerId, msg.bindingSig));
  if (!proven) {
    _stats.profilesRejected++;
    return;
  }
  const did = claimed as string;
  const isNewMapping = _peerIdToDid.get(peerId) !== did;
  _setPeerDid(peerId, did);

  // Queued DMs are keyed by DID, and the "connect" event fires before we
  // know the peer's DID - so the real flush happens here, once the profile
  // (and with it the DID) has arrived.
  if (isNewMapping) {
    flushQueuedDmForPeer(peerId).catch(() => {});
    _replayPendingDm(peerId, did);
  }

  // Answer with everything about our current state, on EVERY profile we did
  // not ourselves provoke - not only when the mapping is new.
  //
  // Device keys are stable, so a peer that reloads comes back with the same
  // peerId and the mapping looks unchanged to us. Keying the reply on novelty
  // meant the reloaded side never heard back: connected, but with no idea who
  // anyone is, no names, no presence and no history.
  if (!msg.reply) {
    _sendProfile(peerId, true);
    if (transportState.inCall) {
      _sendCallPresence(peerId);
      _sendCallState(peerId);
      _sendWatchPresence(peerId);
    }
  }
  // Reconcile history with them either way; debounced, so a burst is one.
  _syncPeer(peerId);

  const avatarUrl = normalizeAvatarUrl(msg.avatarUrl);
  // `color` absent = older build, which has no such field - keep any cached
  // color. Explicit null (or junk that fails sanitizing) = "no color".
  const hasColorField = msg.color !== undefined;
  const color = hasColorField ? normalizeNicknameColor(msg.color) : undefined;

  const names = new Map(transportState.peerNames);
  names.set(did, msg.name);
  transportState.peerNames = names;

  const avatars = new Map(transportState.peerAvatars);
  if (avatarUrl) avatars.set(did, avatarUrl);
  else avatars.delete(did);
  transportState.peerAvatars = avatars;

  if (hasColorField) {
    const colors = new Map(transportState.peerColors);
    if (color) colors.set(did, color);
    else colors.delete(did);
    transportState.peerColors = colors;
  }

  getPeerProfile(did)
    .then((existing) =>
      putPeerProfile({
        did,
        isMe: false,
        nickname: msg.name,
        pfpURL: avatarUrl,
        updatedAt: Date.now(),
        color: hasColorField ? (color ?? undefined) : existing?.color,
        ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
      }).catch(() => {})
    )
    .catch(() => {});
}

/** Chime when somebody else joins or leaves the call we are sitting in. */
function _peerCallSound(
  room: string | undefined,
  nowInCall: boolean,
  wasInCall: boolean
): void {
  const chime = peerCallChime({
    imInCall: transportState.inCall,
    myCallRoom: transportState.callRoomCode,
    room,
    wasInCall,
    nowInCall,
  });
  if (chime === "join") playPeerJoinSound();
  else if (chime === "leave") playPeerLeaveSound();
}

/** One viewer watches at most one share; a new announcement replaces it. */
export function _handleWatchPresence(
  viewerPeerId: string,
  watching: string | null
): void {
  const next = new Map<string, Set<string>>();
  for (const [sharer, viewers] of transportState.transmissionViewers) {
    const copy = new Set(viewers);
    copy.delete(viewerPeerId);
    if (copy.size > 0) next.set(sharer, copy);
  }
  if (watching) {
    const set = new Set(next.get(watching) ?? []);
    set.add(viewerPeerId);
    next.set(watching, set);
  }
  transportState.transmissionViewers = next;
}

/**
 * When a call-roster entry was last confirmed alive: presence or call-state
 * heard, or the peer's voice link actually up. Entries older than the TTL
 * are ghosts (wedged app, backgrounded PWA whose leave never arrived) and
 * get swept by the repair tick.
 */
const _callPeerSeen = new Map<string, number>();
const CALL_PRESENCE_TTL_MS = 60_000;

function _handleCallPresence(
  peerId: string,
  inCall: boolean,
  roomCode?: string
): void {
  const next = new Set(transportState.callPeerIds);
  const roomNext = new Map(transportState.callPeerRooms);
  const wasInCall = next.has(peerId);
  const theirRoom = roomNext.get(peerId);

  if (inCall && roomCode) {
    next.add(peerId);
    roomNext.set(peerId, roomCode);
    _callPeerSeen.set(peerId, Date.now());
    _peerCallSound(roomCode, true, wasInCall);
  } else {
    _callPeerSeen.delete(peerId);
    next.delete(peerId);
    roomNext.delete(peerId);
    _peerCallSound(theirRoom, false, wasInCall);

    const parts = new Map(transportState.participants);
    parts.delete(peerId);
    transportState.participants = parts;

    const sfuNext = new Set(transportState.sfuPeerIds);
    sfuNext.delete(peerId);
    transportState.sfuPeerIds = sfuNext;

    const txNext = new Map(transportState.pendingTransmissions);
    txNext.delete(peerId);
    transportState.pendingTransmissions = txNext;

    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
    }

    const callStateNext = new Map(transportState.callPeerStates);
    callStateNext.delete(peerId);
    transportState.callPeerStates = callStateNext;
  }

  transportState.callPeerIds = next;
  transportState.callPeerRooms = roomNext;
}

function _handleCallState(peerId: string, msg: WireCallState): void {
  if (transportState.callPeerRooms.has(peerId)) {
    _callPeerSeen.set(peerId, Date.now());
  }
  const next = new Map(transportState.callPeerStates);
  next.set(peerId, {
    muted: !!msg.muted,
    deafened: !!msg.deafened,
  });
  transportState.callPeerStates = next;
}

function _handleRoomName(msg: WireRoomName, room: string | null): void {
  // The room this name is for, NOT the one on screen: we stay subscribed to
  // every room we have joined, so applying it to the current room renamed
  // whichever room you happened to be looking at.
  const target = msg.roomCode ?? room;
  if (!target) return;
  const trimmed = msg.name.trim().slice(0, 64);
  if (!trimmed) return;
  // A peer that joined from a bare invite link has no name yet and sends the
  // room code as a placeholder. Accepting it would overwrite the real name for
  // everyone in the room.
  if (trimmed === target) return;
  renameRoom(target, trimmed).catch(() => {});
  if (target === transportState.roomCode) transportState.roomName = trimmed;
}

/**
 * A peer may only announce ITSELF. `claimedDid` arrives in the message body,
 * which anybody in the room can write, so it is checked against the DID bound
 * to the authenticated connection it came in on. Without that check a peer
 * could evict anyone from everyone else's member list (see _handleLeaveRoom)
 * or stuff the list with identities that were never here.
 */
function _isSelfAnnouncement(fromPeerId: string, claimedDid: string): boolean {
  if (!claimedDid) return false;
  const senderDid = _peerIdToDid.get(fromPeerId);
  return !!senderDid && senderDid === claimedDid;
}

function _handleJoinRoom(
  _fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!claimedDid) return;
  // Deliberately NOT restricted to self-announcements: this only ever adds,
  // RoomUsersSync already accepts additions from anyone, and a join often
  // arrives before the sender's profile has bound their DID - rejecting it
  // then would leave them missing from the list entirely.
  if (room !== transportState.roomCode) {
    // Another room we are subscribed to: record it, but do not touch the
    // member list on screen.
    addRoomParticipant(room, claimedDid).catch(() => {});
    return;
  }
  const uniqueUsers = [...new Set(transportState.roomUsers)];
  if (!uniqueUsers.includes(claimedDid)) {
    uniqueUsers.push(claimedDid);
    transportState.roomUsers = uniqueUsers;
    addRoomParticipant(room, claimedDid).catch(() => {});
  }
}

/**
 * Explicit leave: drop the user from the member list and from storage. This is
 * the only thing that removes somebody - going offline must not, or a peer that
 * closed their laptop would vanish instead of showing as offline.
 */
function _handleLeaveRoom(
  fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!_isSelfAnnouncement(fromPeerId, claimedDid)) return;
  removeRoomParticipant(room, claimedDid).catch(() => {});
  if (room === transportState.roomCode) {
    const currentUsers = new Set(transportState.roomUsers);
    if (currentUsers.has(claimedDid)) {
      currentUsers.delete(claimedDid);
      transportState.roomUsers = [...currentUsers];
    }
  }
  // Keyed by the libp2p peerId, not the DID: deleting claimedDid here was a
  // no-op and left the mapping behind.
  _peerIdToDid.delete(fromPeerId);
  transportState.peerDidVersion += 1;
}

// A room's participant list is presence metadata, not a security boundary,
// but a peer must not be able to grow it without bound or stuff it with junk.
const MAX_ROOM_USERS = 512;

function _handleRoomUsersSync(
  msg: WireRoomUsersSync,
  room: string | null
): void {
  const roomCode = msg.roomCode ?? room;
  if (!roomCode) return;
  const participants = msg.participants;
  if (!Array.isArray(participants)) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const valid = participants.filter(
    (p) => typeof p === "string" && (looksLikeDid(p) || looksLikePeerId(p))
  );
  if (roomCode !== transportState.roomCode) {
    // A list for a room we are subscribed to but not looking at. Persist it,
    // but leave the on-screen member list alone - merging it in was how one
    // room's members ended up listed in another.
    for (const did of valid.slice(0, MAX_ROOM_USERS)) {
      addRoomParticipant(roomCode, did).catch(() => {});
    }
    return;
  }
  const known = new Set(transportState.roomUsers);
  const merged = new Set([...known, ...valid]);
  if (selfDid) merged.add(selfDid);
  const next = [...merged].slice(0, MAX_ROOM_USERS);
  transportState.roomUsers = next;

  // Persist whoever is new to us. Only a JoinRoom announcement used to be
  // written down, and you only receive that if you were already in the room
  // when they joined - so everybody who was there before you lived in memory
  // alone and disappeared from the member list on your next reload. Existing
  // entries are left untouched so this does not keep resetting their
  // inactivity window.
  for (const did of next) {
    if (!known.has(did)) addRoomParticipant(roomCode, did).catch(() => {});
  }
}

function _broadcastJoinRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.JoinRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

function _broadcastLeaveRoom(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return Promise.resolve();
  return _transport.broadcast(
    encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

/**
 * Authenticate an incoming chat message.
 * A signed message must verify (and senderDid must match the claimed
 * did:key senderId) or it is dropped. Unsigned messages are accepted:
 * history predating signing and DM messages mirrored by the receiver are
 * stored without a sig, and rejecting them silently destroys sync.
 * ponytail: unsigned did:key claims are still spoofable - tighten to
 * mandatory signatures once legacy history has aged out.
 */
async function _verifyIncoming(wire: WireChatMessage): Promise<boolean> {
  if (!wire.sig) return true;
  // A signature MUST use the v2 canonical form (which covers reaction/reply/
  // file fields). The weak v1 form left those unsigned, so accepting a v1 sig
  // would let a relay swap an infoHash/emoji on a signed message undetected.
  if (wire.sigV !== 2) return false;
  if (wire.senderId.startsWith("did:key:") && wire.senderDid !== wire.senderId)
    return false;
  if (!wire.senderDid) return false;
  return verifySignature(wire.senderDid, wire.sig, canonicalFor(wire));
}

async function _handleChatMessage(
  wire: WireChatMessage,
  roomCodeOverride?: string,
  receivedFromPeerId?: string
): Promise<void> {
  // Never guess the room from what is on screen: an echoed or replayed
  // frame arriving without attribution would be filed - and PERSISTED -
  // into whichever room the user happens to be viewing.
  const roomCode = roomCodeOverride;
  if (!roomCode) return;
  if (!roomCode) return;

  // DM rooms now start with "dm-" (hash-based)
  // We don't need to ensure room here - it should already exist from sender context

  lamportReceive(wire.lamport);

  const msg = wireToMessage(wire, roomCode);

  // A sender's lamport only ever moves forward, so a jump past what we have
  // from them means we probably missed something. It is a hint, not proof -
  // the clock also advances on receives - but a digest is small and answering
  // one costs nothing, so erring towards syncing is the cheap side.
  if (receivedFromPeerId) {
    const seen = _lastSeenLamport.get(`${roomCode}|${msg.senderId}`) ?? -1;
    // Force past the debounce: a detected gap is the strongest signal we get,
    // and a routine profile exchange must not be allowed to consume the window
    // and swallow it.
    if (seen >= 0 && msg.lamport > seen + 1)
      _syncPeer(receivedFromPeerId, true);
    if (msg.lamport > seen) {
      _lastSeenLamport.set(`${roomCode}|${msg.senderId}`, msg.lamport);
    }
  }

  // The in-memory list holds only the open room's newest page; a replayed
  // message from a background room would always look "new" and re-notify.
  // Decided BEFORE the put below, which would otherwise satisfy the lookup.
  const isNewMessage =
    !transportState.messages.some((m) => m.id === msg.id) &&
    !(await getMessage(msg.id));

  // Only a genuinely new message is written: re-putting a replayed one
  // would overwrite the stored row with this handler's view of it.
  if (isNewMessage) putMessage(msg).catch(() => {});
  setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  refreshUnreadCount(msg.roomCode).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);

  // DM rooms now start with "dm-" (hash-based format)
  if (isNewMessage && msg.roomCode.startsWith("dm-")) {
    transportState.dmVersion += 1;
  }

  // Reactions are noise as notifications, and a message replayed by sync is
  // not news - only announce genuinely new chat arriving from someone else.
  if (
    isNewMessage &&
    msg.type !== MessageType.Reaction &&
    !isSelfSender(msg.senderId)
  ) {
    notifyMessage({
      title: transportState.roomName || msg.roomCode,
      body: `${msg.senderName}: ${msg.content || "[file]"}`,
      tag: `room:${msg.roomCode}`,
      viewingConversation: transportState.uiRoomCode === msg.roomCode,
    });
  }

  // Match on the open room, not the mode: DM file messages arrive through
  // this path too, and the mode check kept them invisible until reopen.
  if (isNewMessage && transportState.roomCode === msg.roomCode) {
    transportState.messages = appendSorted(transportState.messages, msg);
  }

  if (msg.type !== MessageType.File || !msg.meta?.files?.length) return;

  const seederPeerId =
    receivedFromPeerId ?? maybePeerIdFromSenderId(msg.senderId) ?? null;

  if (isNewMessage) {
    getAttachmentsByMessage(msg.id)
      .then((existing) => {
        if (existing.length > 0) return;
        const now = Date.now();
        return Promise.all(
          msg.meta!.files.map((file) =>
            putAttachment({
              id: crypto.randomUUID(),
              roomCode: msg.roomCode,
              messageId: msg.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
              infoHash: file.infoHash,
              status: "pending",
              createdAt: now,
            })
          )
        );
      })
      .catch(() => {});
  }

  for (const file of msg.meta.files) {
    if (seederPeerId) {
      _fileTransport.registerSeeder(file, seederPeerId);
    }
    if (shouldAutoDownload(file.mimeType)) {
      _fileTransport.ensureDownload(file);
    } else {
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 1,
      });
    }
  }
}

// ── Transport events ──────────────────────────────────────────────────────────

_transport.on("status", (status) => {
  switch (status.type) {
    case "relay-connected":
      transportState.relayConnected = true;
      break;
    case "relay-disconnected":
    case "relay-dial-failed":
    case "relay-reconnecting":
    case "relay-reconnect-failed":
      transportState.relayConnected = false;
      break;
  }
});

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  // The DID cannot be derived from the peerId any more (devices carry their
  // own libp2p keys); it arrives with the signed binding in the Profile.
  flushQueuedDmForPeer(peerId).catch(() => {});
  _fileTransport.onPeerConnect(peerId);
  _sendProfile(peerId);
  _sendRoomName(peerId);
  if (transportState.inCall) _sendCallPresence(peerId);
  if (transportState.inCall) _sendCallState(peerId);
  if (transportState.inCall) _sendWatchPresence(peerId);
  _sendDigest(peerId);
  const selfDid = identityStore.did ?? _transport.selfId();
  const participants = [...new Set([...transportState.roomUsers, selfDid])];
  _transport.send(
    peerId,
    encode({
      type: MessageType.RoomUsersSync,
      participants,
      roomCode: transportState.roomCode ?? undefined,
    })
  );
});

_transport.on("disconnect", (peerId) => {
  _lastAppInbound.delete(peerId);
  _profileRepair.delete(peerId);
  transportState.peers = _transport.peers();
  _fileTransport.onPeerDisconnect(peerId);

  // Note: We intentionally do NOT delete the peerId->DID mapping here.
  // The mapping is kept so we can still identify which DID a peerId
  // belonged to for offline user tracking. The mapping is only removed
  // when we receive an explicit LeaveRoom message.

  const parts = new Map(transportState.participants);
  parts.delete(peerId);
  transportState.participants = parts;

  // Gone peers neither watch nor share.
  _handleWatchPresence(peerId, null);
  if (transportState.transmissionViewers.has(peerId)) {
    const viewers = new Map(transportState.transmissionViewers);
    viewers.delete(peerId);
    transportState.transmissionViewers = viewers;
  }

  // A peer that drops out never sends a leave, so the chime belongs here too.
  const calls = new Set(transportState.callPeerIds);
  _peerCallSound(
    transportState.callPeerRooms.get(peerId),
    false,
    calls.has(peerId)
  );
  calls.delete(peerId);
  transportState.callPeerIds = calls;

  // The roster too: every other call map is cleaned here, and a stale entry
  // kept the status stuck at "Connecting x/y" after someone dropped out.
  const callRoomsNext = new Map(transportState.callPeerRooms);
  callRoomsNext.delete(peerId);
  transportState.callPeerRooms = callRoomsNext;

  const callStates = new Map(transportState.callPeerStates);
  callStates.delete(peerId);
  transportState.callPeerStates = callStates;

  const sfuNext = new Set(transportState.sfuPeerIds);
  sfuNext.delete(peerId);
  transportState.sfuPeerIds = sfuNext;

  const txNext = new Map(transportState.pendingTransmissions);
  txNext.delete(peerId);
  transportState.pendingTransmissions = txNext;

  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
  }
});

/**
 * An incoming DM, once we know who sent it.
 *
 * Split out of the message handler so a frame that arrived before the sender's
 * DID was bound can be replayed through exactly the same path.
 */
function _handleDmChat(
  peerId: string,
  senderDid: string,
  envelope: { payload: DmPayload }
): void {
  void (async () => {
    const roomCode = await ensureDmRoomForPeer(peerId);
    if (!roomCode) return;
    _transport.joinRoom(roomCode);

    const reaction = envelope.payload.reaction;
    const msg: Message = {
      id: envelope.payload.id,
      roomCode,
      senderId: senderDid,
      senderName: resolveDmDisplayName(peerId),
      timestamp: envelope.payload.ts,
      // The sender's assigned lamport keeps both sides' copies (and their
      // sync watermarks) identical; older clients omit it.
      lamport: envelope.payload.lamport ?? envelope.payload.ts,
      type: reaction
        ? MessageType.Reaction
        : envelope.payload.replyTo
          ? MessageType.Reply
          : MessageType.Text,
      // A reaction's text is only the compatibility shim for old clients.
      content: reaction ? "" : envelope.payload.text,
      replyTo: envelope.payload.replyTo,
      reactionTo: reaction?.to,
      reactionEmoji: reaction?.emoji,
      reactionOp: reaction?.op,
      attachments: [],
      status: "delivered",
    };

    // Against storage, not the on-screen list: that list holds whichever
    // conversation is open, so a redelivered message was only recognised
    // as a duplicate when you happened to be looking at that DM.
    if (!(await getMessage(msg.id))) {
      await putMessage(msg);
      // Without a watermark row a DM digest carries an empty map on both
      // sides and _handleDigest concludes nothing is missing - DM history
      // had no sync-repair at all.
      await setWatermark(msg.roomCode, msg.senderId, msg.lamport);
      await refreshDmRooms();
      transportState.dmVersion += 1;
      const activeDid = peerIdToDid(transportState.activeDmPeerId ?? "");
      const isViewingThisDm =
        transportState.chatMode === "dm" &&
        (activeDid === senderDid || activeDid === peerId);
      // Reactions are noise as notifications, same rule as rooms.
      if (!reaction) {
        notifyMessage({
          title: msg.senderName,
          body: msg.content,
          tag: `dm:${roomCode}`,
          viewingConversation: transportState.uiRoomCode === roomCode,
        });
      }
      if (isViewingThisDm) {
        transportState.messages = appendSorted(transportState.messages, msg);
        await markRoomSeen(roomCode, msg.lamport);
        const roomIndex = roomsStore.dmRooms.findIndex(
          (r) => r.roomCode === roomCode
        );
        if (roomIndex !== -1) {
          roomsStore.dmRooms[roomIndex] = {
            ...roomsStore.dmRooms[roomIndex],
            lastSeenLamport: Math.max(
              roomsStore.dmRooms[roomIndex].lastSeenLamport ?? 0,
              msg.lamport
            ),
          };
        }
        await refreshDmRooms();
        transportState.dmVersion += 1;
        // Conversation is on screen - this message is read, not just delivered
        _transport
          .send(peerId, encodeDmReadEnvelope([envelope.payload.id]))
          .catch(() => {});
      }
    }

    _transport
      .send(peerId, encodeDmAckEnvelope(envelope.payload.id))
      .catch(() => {});
  })().catch(console.error);
  return;
}

_transport.on("message", (peerId, data, room) => {
  // Before ANY branch: the DM and file-signal paths return early, and a peer
  // we only ever DM with would otherwise read as permanently app-silent -
  // making the repair tick send it a digest every 15s for the lifetime of the
  // connection, the exact busywork the tick promises not to do.
  _lastAppInbound.set(peerId, Date.now());
  if (room === null) {
    const envelope = parseDmEnvelope(data);
    if (envelope) {
      if (envelope.type === "ack") {
        applyMessageStatus(envelope.messageId, "delivered");
        return;
      }

      if (envelope.type === "read") {
        for (const id of envelope.messageIds) {
          applyMessageStatus(id, "read");
        }
        // The reader only acks the page they had loaded; a read at lamport L
        // implies everything we sent before L in that room was read too.
        _cascadeReadAcks(envelope.messageIds).catch(() => {});
        return;
      }

      // Handle incoming DM chat message.
      // Until the sender's profile has bound their peerId to a DID we cannot
      // tell which conversation this belongs to: the room code is a hash of
      // the two DIDs. Hold it and replay once the binding lands, rather than
      // filing it in a peerId-derived thread the sender never reads.
      const senderDid = _peerIdToDid.get(peerId);
      if (!senderDid) {
        const pending = _pendingDmByPeer.get(peerId) ?? [];
        if (pending.length < MAX_PENDING_DM_PER_PEER) {
          pending.push(envelope);
          _pendingDmByPeer.set(peerId, pending);
        }
        return;
      }
      _handleDmChat(peerId, senderDid, envelope);
      return;
    }
  }

  try {
    const decoded = decode(data);
    if (isFileSignalWireMessage(decoded)) {
      if (decoded.payload.kind === "file-seeder") {
        _fileTransport.registerSeeder(decoded.payload.file, peerId);
        if (shouldAutoDownload(decoded.payload.file.mimeType)) {
          _fileTransport.ensureDownload(decoded.payload.file);
        }
      } else {
        _fileTransport.handleSignal(peerId, decoded.payload);
      }
      return;
    }

    // Update last seen for this peer
    const did = _peerIdToDid.get(peerId);
    if (did && room) {
      updateParticipantLastSeen(room, did).catch(() => {});
    }

    const msg = decoded as AnyWireMessage;

    switch (msg.type) {
      case MessageType.Profile:
        _handleProfile(peerId, msg);
        break;
      case MessageType.CallPresence:
        _handleCallPresence(peerId, msg.inCall, msg.roomCode);
        break;
      case MessageType.CallState:
        _handleCallState(peerId, msg);
        break;
      case MessageType.WatchPresence:
        _handleWatchPresence(peerId, msg.watching);
        break;
      case MessageType.RoomName:
        _handleRoomName(msg, room);
        break;
      case MessageType.JoinRoom:
        _handleJoinRoom(peerId, msg.peerId, room);
        break;
      case MessageType.LeaveRoom:
        _handleLeaveRoom(peerId, msg.peerId, room);
        break;
      case MessageType.RoomUsersSync:
        _handleRoomUsersSync(msg, room);
        break;
      case MessageType.SyncDigest:
        _handleDigest(peerId, msg.roomCode, msg.watermarks).catch(() => {});
        break;
      case MessageType.SyncBatch:
        _handleSyncBatch(msg.roomCode, msg.messages).catch(() => {});
        break;
      case MessageType.SyncComplete:
        _handleSyncComplete(peerId);
        break;
      case MessageType.Text:
      case MessageType.Reply:
      case MessageType.Reaction:
      case MessageType.File:
        // A bare chat message is only legitimate over a room's pubsub topic
        // (room !== null). The same message type arriving over a direct
        // stream (room === null) would otherwise be stamped with whatever
        // room the receiver has open - letting any connected peer inject
        // forged history into a room they never joined. Drop it.
        if (room === null) {
          console.warn(
            "[app] dropped direct-stream chat message from",
            msg.senderId
          );
          break;
        }
        _verifyIncoming(msg)
          .then((ok) => {
            if (ok) _handleChatMessage(msg, room, peerId).catch(() => {});
            else
              console.warn(
                "[app] dropped message with invalid signature from",
                msg.senderId
              );
          })
          .catch(() => {});
        break;
    }
  } catch (e) {
    console.warn("[app] message decode failed", e, data);
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

const CONNECT_RETRY_BASE_MS = 3_000;
const CONNECT_RETRY_MAX_MS = 30_000;
let _connectRetryDelay = CONNECT_RETRY_BASE_MS;
let _connectRetryTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleConnectRetry(): void {
  if (_connectRetryTimer) return;
  _connectRetryTimer = setTimeout(() => {
    _connectRetryTimer = null;
    // Stop retrying if the identity got locked in the meantime
    try {
      requireSession();
    } catch {
      return;
    }
    connect().catch(() => {});
  }, _connectRetryDelay);
  _connectRetryDelay = Math.min(_connectRetryDelay * 2, CONNECT_RETRY_MAX_MS);
}

export async function connect() {
  if (transportState.relayConnected) return;
  // Fetch fresh short-lived TURN credentials for this session (best-effort;
  // falls back to bundled ICE servers if the relay doesn't issue them).
  refreshTurnCredentials().catch(() => {});
  if (_connectPromise) {
    await _connectPromise;
    return;
  }

  _connectPromise = (async () => {
    try {
      // This device's own libp2p key, NOT the identity key: two devices on the
      // same account would otherwise share a peerId and never connect.
      await _transport.connect(deviceKeySeed());
      transportState.relayConnected = true;
      transportState.error = null;
      _connectRetryDelay = CONNECT_RETRY_BASE_MS;
      joinPhonebookDmRooms().catch(() => {});
    } catch (err) {
      transportState.error = err instanceof Error ? err.message : String(err);
      transportState.relayConnected = false;
      _scheduleConnectRetry();
    } finally {
      _connectPromise = null;
    }
  })();

  await _connectPromise;
}

/**
 * Two rapid conversation switches race their awaits; only the LAST requested
 * open may touch view state. Each open claims a token and checks it after
 * every await - the loser bails without writing (and without acking).
 */
let _openRun = 0;
export function beginConversationOpen(): () => boolean {
  const run = ++_openRun;
  return () => run === _openRun;
}

export async function joinRoom(roomCode: string): Promise<boolean> {
  const stillCurrent = beginConversationOpen();
  if (!transportState.relayConnected) {
    await connect();
  }

  if (!transportState.relayConnected) {
    transportState.error = "Transport not connected to relay";
    transportState.connecting = false;
    return false;
  }

  transportState.error = null;
  transportState.connecting = true;
  try {
    await _loadHistory(roomCode, stillCurrent);
    await _hydrateFileTransfersFromStorage(roomCode);
    if (!stillCurrent()) return false;
    _transport.joinRoom(roomCode);
    transportState.connected = true;
    transportState.chatMode = "room";
    transportState.activeDmPeerId = null;
    transportState.connecting = false;
    transportState.roomCode = roomCode;
    transportState.roomName = "";
    transportState.peers = _transport.peers();
    const selfDid = identityStore.did ?? _transport.selfId();
    const savedParticipants = await getRoomParticipants(roomCode);
    // Clean up inactive participants (not seen in 7 days)
    const removedInactive = await cleanupInactiveParticipants(roomCode);
    if (removedInactive.length > 0) {
      console.log("[room] removed inactive participants:", removedInactive);
    }
    const participants = new Set(
      savedParticipants.filter((p) => !removedInactive.includes(p))
    );
    participants.add(selfDid);
    if (!stillCurrent()) return false;
    transportState.roomUsers = [
      ...new Set([...transportState.roomUsers, ...participants]),
    ];
    await addRoomParticipant(roomCode, selfDid);
    // Best-effort: one corrupt stored attachment must not block joining
    await _resumeAttachmentSeeding(roomCode).catch((err) =>
      console.warn("[room] attachment re-seed failed:", err)
    );
    await _broadcastProfile();
    _broadcastJoinRoom();
    // Ask the peers we are ALREADY connected to for this room's history. The
    // digest only went out when a NEW peer connected, so joining a room while
    // the connections were already up pulled nothing and the room looked empty
    // until a reload rebuilt every connection.
    for (const pid of _transport.peers()) {
      _sendDigest(pid).catch(() => {});
    }
    return true;
  } catch (err) {
    // Roll back the partial join: _transport.joinRoom() already subscribed the
    // gossipsub topic and we flipped transportState to "in this room" before
    // the awaits that threw. Leaving that half-state makes the room look
    // joined-but-errored. Undo it.
    _transport.leaveRoom(roomCode);
    transportState.connected = false;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.error = err instanceof Error ? err.message : String(err);
    transportState.connecting = false;
    throw err;
  }
}

export function getRoomUsers(): string[] {
  return transportState.roomUsers;
}

/**
 * Remove a room COMPLETELY: say goodbye, stop listening, hang up if the call
 * lives there, and delete the history. Works whether or not the room is on
 * screen - removing a background room used to leave the transport subscribed,
 * so incoming traffic quietly re-stored messages for a room that no longer
 * existed, and a call held in it just kept going.
 */
export async function removeRoomCompletely(roomCode: string): Promise<void> {
  if (!roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (selfDid && _transport.rooms().includes(roomCode)) {
    // Before unsubscribing, or the broadcast no-ops and nobody sees us leave.
    await _transport
      .broadcast(
        encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
        roomCode
      )
      .catch(() => {});
  }
  _transport.leaveRoom(roomCode);
  if (transportState.callRoomCode === roomCode) leaveCall();
  if (transportState.roomCode === roomCode) {
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.roomUsers = [];
    transportState.messages = [];
    transportState.connected = false;
  }
  await removeRoom(roomCode);
}

export function leaveRoom(): void {
  void _leaveCurrentRoom();
}

/**
 * Leave the room on screen and nothing else.
 *
 * This used to stop the libp2p node outright and wipe every peer, name, avatar
 * and file transfer: leaving one room of several took down the rooms you were
 * staying in, the call you were on and any transfer in flight, and the app
 * only looked right again after a reload.
 */
async function _leaveCurrentRoom(): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (selfDid) {
    // Await the publish: unsubscribing right after would drop the message and
    // nobody would ever see you leave.
    await _broadcastLeaveRoom().catch(() => {});
    removeRoomParticipant(roomCode, selfDid).catch(() => {});
  }
  _transport.leaveRoom(roomCode);
  // Only hang up if the call is in the room being left.
  if (transportState.callRoomCode === roomCode) leaveCall();

  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.roomUsers = [];
  transportState.messages = [];
  transportState.connected = false;
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
}

/** Full teardown: everything goes, including the libp2p node. */
export function disconnectTransport(): void {
  _disconnectWithoutBroadcasting();
}

function _disconnectWithoutBroadcasting(): void {
  for (const transfer of transportState.fileTransfers.values()) {
    if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
  }
  // Clear the file transport's internal maps too - it's a session-long
  // singleton, so without this its stale (revoked) blobURLs get replayed on
  // rejoin and revoke freshly-hydrated ones. Keeps the client alive for reuse.
  _fileTransport.resetTransfers();
  leaveCall();
  _transport.disconnect();
  _peerIdToDid.clear();
  transportState.peerDidVersion += 1;
  // disconnect() fully stops and nulls the libp2p node, so the relay
  // connection is gone too. Without clearing this flag, connect()/joinRoom()
  // short-circuit on the stale `relayConnected === true` and never rebuild
  // the node - reconnect stays broken until a full page reload.
  transportState.relayConnected = false;
  transportState.connected = false;
  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.peers = [];
  transportState.messages = [];
  transportState.participants = new Map();
  transportState.peerNames = new Map();
  transportState.peerAvatars = new Map();
  transportState.peerColors = new Map();
  transportState.error = null;
  transportState.callPeerIds = new Set();
  transportState.sfuPeerIds = new Set();
  transportState.pendingTransmissions = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
  transportState.fileTransfers = new Map();
  transportState.callPeerStates = new Map();
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
}

export async function sendMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
  if (transportState.chatMode === "dm") {
    await sendDirectMessage(text, { replyTo: options.replyTo });
    return;
  }
  if (!transportState.roomCode) return;

  const profile = await getOwnProfile();
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const lamport = lamportSend();

  let msg: Message = {
    id: crypto.randomUUID(),
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: Date.now(),
    lamport,
    type: options.type ?? MessageType.Text,
    content: text,
    meta: options.meta,
    attachments: options.attachments ?? [],
    replyTo: options.replyTo,
    reactionTo: options.reactionTo,
    reactionEmoji: options.reactionEmoji,
    reactionOp: options.reactionOp,
  };

  // Sign the message before sending
  msg = signMessage(msg);

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = appendSorted(transportState.messages, msg);

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);
}

export async function sendReply(text: string, target: Message): Promise<void> {
  const snapshot =
    target.content.length > 160
      ? `${target.content.slice(0, 157)}...`
      : target.content;
  await sendMessage(text, {
    type: MessageType.Reply,
    replyTo: {
      id: target.id,
      senderName: target.senderName,
      content: snapshot,
    },
  });
}

export async function sendFiles(
  files: File[],
  text = "",
  options: Pick<SendMessageOptions, "replyTo"> = {}
): Promise<void> {
  if (!transportState.roomCode || !files.length) return;

  const seeded: FileDescriptor[] = [];
  const sourceByInfoHash = new Map<string, File>();

  for (const file of files) {
    const fingerprint = await fileFingerprint(file);
    const existing = _seededByFingerprint.get(fingerprint);
    if (existing) {
      seeded.push(existing);
      sourceByInfoHash.set(existing.infoHash, file);
      continue;
    }

    const [newSeed] = await _fileTransport.seedFiles([file]);
    _seededByFingerprint.set(fingerprint, newSeed);
    seeded.push(newSeed);
    sourceByInfoHash.set(newSeed.infoHash, file);
  }

  const messageId = crypto.randomUUID();
  const attachmentIds: string[] = [];
  const createdAt = Date.now();

  for (let i = 0; i < seeded.length; i += 1) {
    const seededFile = seeded[i];
    const source = sourceByInfoHash.get(seededFile.infoHash);
    if (!source) continue;
    const canPersistData = source.size <= MAX_PERSISTED_ATTACHMENT_BYTES;
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      roomCode: transportState.roomCode,
      messageId,
      filename: seededFile.filename,
      mimeType: seededFile.mimeType,
      size: seededFile.size,
      infoHash: seededFile.infoHash,
      status: "seeding",
      createdAt,
      data: canPersistData ? await source.arrayBuffer() : undefined,
    };
    attachmentIds.push(attachment.id);
    await putAttachment(attachment);

    withFileTransfer({
      ...seededFile,
      status: "seeding",
      progress: 1,
      done: true,
      seeding: true,
      peers: 0,
      seeders: 1,
      blobURL: URL.createObjectURL(source),
    });
  }

  const profile = await getOwnProfile();
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  // DM rooms order by wall-clock ms; a room-counter lamport (~small int)
  // filed the file before the entire conversation and it vanished on reload.
  const lamport = transportState.roomCode.startsWith("dm-")
    ? await nextDmLamport(transportState.roomCode, createdAt)
    : lamportSend();

  let msg: Message = {
    id: messageId,
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: createdAt,
    lamport,
    type: MessageType.File,
    content: text.trim(),
    meta: { files: seeded },
    attachments: attachmentIds,
    replyTo: options.replyTo,
  };

  msg = signMessage(msg);

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);
  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = appendSorted(transportState.messages, msg);

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);
}

export function requestFileDownload(
  file: FileEntry,
  senderId?: string | null
): void {
  const peerId = senderId ? maybePeerIdFromSenderId(senderId) : null;
  if (peerId) {
    _fileTransport.registerSeeder(file, peerId);
  }
  _fileTransport.ensureDownload(file);
}

export async function toggleReaction(
  messageId: string,
  emoji: string
): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  // The loaded page cannot see reactions on older messages, which made
  // un-reacting there impossible: the prior comes from storage.
  const all = await getAllMessages(roomCode);
  const existing = all
    .filter(
      (m) =>
        m.type === MessageType.Reaction &&
        m.reactionTo === messageId &&
        m.reactionEmoji === emoji &&
        isSelfSender(m.senderId)
    )
    .sort((a, b) => b.lamport - a.lamport)[0];
  const reactionOp: "add" | "remove" =
    existing?.reactionOp === "add" ? "remove" : "add";

  if (transportState.chatMode === "dm") {
    await sendDirectMessage("", {
      reaction: { to: messageId, emoji, op: reactionOp },
    });
    return;
  }

  await sendMessage("", {
    type: MessageType.Reaction,
    reactionTo: messageId,
    reactionEmoji: emoji,
    reactionOp,
  });
}

export async function loadMoreMessages(
  beforeLamport: number
): Promise<boolean> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return false;
  const older = await getMessages(roomCode, beforeLamport);
  // The user can switch rooms while the page loads; prepending the old
  // room's backlog into the new room's view crosses histories.
  if (transportState.roomCode !== roomCode) return false;
  if (!older.length) return false;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newOnes = older.filter((m) => !existingIds.has(m.id));
  transportState.messages = [...newOnes, ...transportState.messages].sort(
    MSG_ORDER
  );
  // "more exists" comes from the raw page size: dedup can shrink newOnes on
  // a full page, which used to hide the load-older button early.
  return older.length === PAGE_SIZE;
}

export async function markSeen(): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  // Only this room's messages: a sync batch for another room can share the
  // array briefly, and its lamports must not become this room's watermark.
  let maxLamport = 0;
  for (const m of transportState.messages) {
    if (m.roomCode === roomCode && m.lamport > maxLamport)
      maxLamport = m.lamport;
  }
  if (maxLamport === 0) return;
  await markRoomSeen(roomCode, maxLamport);
  if (roomCode.startsWith("dm-")) {
    // DM rooms live in their own mirror, and the DM badge recomputes on
    // dmVersion - the rooms maps below never carried them.
    const idx = roomsStore.dmRooms.findIndex((r) => r.roomCode === roomCode);
    if (idx !== -1) {
      roomsStore.dmRooms[idx] = {
        ...roomsStore.dmRooms[idx],
        lastSeenLamport: Math.max(
          roomsStore.dmRooms[idx].lastSeenLamport ?? 0,
          maxLamport
        ),
      };
    }
    transportState.dmVersion += 1;
    return;
  }
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) {
    roomsStore.rooms[idx] = {
      ...roomsStore.rooms[idx],
      lastSeenLamport: Math.max(
        roomsStore.rooms[idx].lastSeenLamport ?? 0,
        maxLamport
      ),
    };
  }
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, 0);
  roomsStore.unreadCounts = next;
}

export function broadcastProfile(): void {
  _broadcastProfile().catch(() => {});
}

export function setRoomName(name: string): void {
  transportState.roomName = name.trim().slice(0, 64);
  _sendRoomName();
}

export function selfId(): string {
  return identityStore.did ?? _transport.selfId();
}

/**
 * Whether a stored senderId refers to this user. Messages written while the
 * identity was locked carry the raw peerId instead of the DID, so a single-
 * form comparison misclassifies our own history as someone else's.
 */
export function isSelfSender(senderId: string): boolean {
  return senderId === selfId() || senderId === _transport.selfId();
}

export function peerId(): string {
  return _transport.selfId();
}

export function peerIdToDid(peerId: string): string {
  // Reading the version makes callers inside $derived recompute when the map
  // changes: the map itself is a plain Map, so a mapping learned after the
  // "connect" event used to leave presence and profile lookups stale forever.
  void transportState.peerDidVersion;
  return _peerIdToDid.get(peerId) ?? peerId;
}

export function didToPeerId(did: string): string | null {
  void transportState.peerDidVersion;
  for (const [peerId, mappedDid] of _peerIdToDid) {
    if (mappedDid === did) return peerId;
  }
  return null;
}

export function isRelayed(peerId: string): boolean {
  return _transport.isRelayed(peerId);
}
