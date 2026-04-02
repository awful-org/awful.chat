import { MediasoupVideo } from "./transport/mediasoup";
import type { VideoSource } from "./transport/types";
import { identityStore } from "./identity.svelte";
import {
  playJoinSound,
  playLeaveSound,
  playMuteSound,
  playUnmuteSound,
  playDeafenSound,
  playUndeafenSound,
  playCameraOnSound,
  playCameraOffSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
  playTransmissionJoinSound,
  playTransmissionLeaveSound,
  playTransmissionEndedSound,
} from "./sounds";
import {
  getOwnProfile,
  putMessage,
  bulkPutMessages,
  getMessages,
  getAllMessages,
  getWatermarksForRoom,
  setWatermark,
  markRoomSeen,
  getPeerProfile,
  putPeerProfile,
  getAllPeerProfiles,
  getAttachmentsWithData,
  putAttachment,
  getAttachmentsByInfoHash,
  getAttachmentsByMessage,
  updateAttachmentStatus,
  updateMessageStatus,
  getRoomParticipants,
  addRoomParticipant,
  removeRoomParticipant,
  updateParticipantLastSeen,
  cleanupInactiveParticipants,
  getPhonebookEntries,
  getDMRooms,
  putPhonebookEntry,
  deletePhonebookEntry,
  putRoom,
  getRoom,
  deleteRoom,
  type DMRoom,
} from "./storage";
import {
  MessageType,
  wireToMessage,
  messageToWire,
  type Message,
  type ChatMessageType,
  type AnyWireMessage,
  type WireChatMessage,
  type WireProfile,
  type WireCallState,
  type FileEntry,
  type FileMeta,
  type Attachment,
} from "./types/message";
import { refreshUnreadCount, refreshDmRooms, roomsStore } from "./rooms.svelte";
import { WebTorrentFileTransport } from "./transport/file/webtorrent";
import type {
  FileSignalEnvelope,
  FileDescriptor,
  FileTransferSnapshot,
} from "./transport/types";
import { LibP2PTransport } from "./transport/libp2p/transport";
import { LibP2PVoice } from "./transport/libp2p/voice";
import { DtlnProcessor } from "./audio/dtln-processor";
import { requireSession } from "./identity";

export type { Message };

// ── State shapes ──────────────────────────────────────────────────────────────

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
  peerAvatars: Map<string, string>;
  error: string | null;
  callPeerIds: Set<string>;
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
}

export const transportState = $state<TransportState>({
  relayConnected: false,
  connected: false,
  connecting: false,
  roomCode: null,
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
  peerAvatars: new Map(),
  error: null,
  callPeerIds: new Set(),
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
});

let _lamport = 0;
let _voiceOutputBeforeDeafen = 1;
let _videoOutputBeforeDeafen = 1;
let _mutedBeforeDeafen = false;
let _connectPromise: Promise<void> | null = null;

const BATCH_SIZE = 20;
const MAX_PERSISTED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DM_CHAT_TAG = 0x01;
const DM_ACK_TAG = 0x02;
const DM_QUEUE_KEY = "awful:dm-queue:v1";
const _peerIdToDid = new Map<string, string>();
const _seededByFingerprint = new Map<string, FileDescriptor>();
const _dmRoomCodeCache = new Map<string, string>();

interface DmPayload {
  id: string;
  text: string;
  ts: number;
}

interface QueuedMessage {
  to: string;
  data: number[];
  queuedAt: number;
}

/**
 * Generate a stable, deterministic DM room code from two DIDs.
 * - Sort the two DIDs alphabetically
 * - Hash them to create a short (48 char max) stable identifier
 * - Prefix with "dm-" for easy identification
 */
async function hashDmRoomCode(did1: string, did2: string): Promise<string> {
  const sorted = [did1, did2].sort();
  const input = sorted.join("|");
  const cacheKey = input;
  const cached = _dmRoomCodeCache.get(cacheKey);
  if (cached) return cached;

  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  // Take first 20 bytes (40 hex chars) + "dm-" prefix = 43 chars total
  const hashHex = Array.from(hashArray.slice(0, 20))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const roomCode = `dm-${hashHex}`;
  _dmRoomCodeCache.set(cacheKey, roomCode);
  return roomCode;
}

// Synchronous version for cases where we can't await
// Uses cached value or falls back to simple join (which will be fixed on next async call)
function dmRoomCodeSync(did1: string, did2: string): string {
  const sorted = [did1, did2].sort();
  const input = sorted.join("|");
  const cached = _dmRoomCodeCache.get(input);
  if (cached) return cached;
  // Fallback: trigger async hash and return temporary code
  // This should rarely happen after initial setup
  hashDmRoomCode(did1, did2).catch(() => {});
  return `dm-${sorted.join("-").slice(0, 44)}`;
}

/**
 * Get the stable DM room code for a conversation with a peer.
 * Uses DIDs (stable identity) not peer IDs (ephemeral).
 */
async function dmConversationCodeAsync(peerIdOrDid: string): Promise<string> {
  const selfDid = identityStore.did ?? _transport.selfId();
  // Resolve to DID if we have a mapping, otherwise use as-is
  const peerDid = _peerIdToDid.get(peerIdOrDid) ?? peerIdOrDid;
  return hashDmRoomCode(selfDid, peerDid);
}

/**
 * Synchronous version - uses cache or fallback.
 * Prefer dmConversationCodeAsync when possible.
 */
function dmConversationCodeSync(peerIdOrDid: string): string {
  const selfDid = identityStore.did ?? _transport.selfId();
  const peerDid = _peerIdToDid.get(peerIdOrDid) ?? peerIdOrDid;
  return dmRoomCodeSync(selfDid, peerDid);
}

function looksLikePeerId(value: string): boolean {
  return value.startsWith("12D3") || value.startsWith("Qm");
}

function looksLikeDid(value: string): boolean {
  return value.startsWith("did:");
}

function resolveDmPeerId(candidate: string): string | null {
  if (!candidate) return null;
  // If it's a current peer, use it
  if (_transport.peers().includes(candidate)) return candidate;
  // If it looks like a peer ID, use it
  if (looksLikePeerId(candidate)) return candidate;
  // If it's a DID, try to find the peer ID, but if not found, use the DID itself
  // This is important because DIDs are stable identities
  if (looksLikeDid(candidate)) {
    for (const [peerId, did] of _peerIdToDid) {
      if (did === candidate) return peerId;
    }
    // No mapping found, but it's a valid DID - return it as-is
    // The room code will be computed from the DID which is stable
    return candidate;
  }
  // Try reverse lookup for DID→peerId
  for (const [peerId, did] of _peerIdToDid) {
    if (did === candidate) return peerId;
  }
  return null;
}

/**
 * Resolve a peer identifier (peerId or DID) to its DID.
 * Returns the DID if found, otherwise returns the input as-is.
 */
function resolveToDid(peerIdOrDid: string): string {
  if (looksLikeDid(peerIdOrDid)) return peerIdOrDid;
  return _peerIdToDid.get(peerIdOrDid) ?? peerIdOrDid;
}

function encodeDmChatEnvelope(payload: DmPayload): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = DM_CHAT_TAG;
  out.set(body, 1);
  return out;
}

function encodeDmAckEnvelope(messageId: string): Uint8Array {
  const body = new TextEncoder().encode(messageId);
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = DM_ACK_TAG;
  out.set(body, 1);
  return out;
}

function parseDmEnvelope(
  data: Uint8Array
):
  | { type: "chat"; payload: DmPayload }
  | { type: "ack"; messageId: string }
  | null {
  if (data.byteLength < 1) return null;
  const tag = data[0];
  const payload = data.subarray(1);
  try {
    if (tag === DM_CHAT_TAG) {
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as DmPayload;
      if (
        typeof parsed?.id !== "string" ||
        typeof parsed?.text !== "string" ||
        typeof parsed?.ts !== "number"
      ) {
        return null;
      }
      return { type: "chat", payload: parsed };
    }
    if (tag === DM_ACK_TAG) {
      return { type: "ack", messageId: new TextDecoder().decode(payload) };
    }
  } catch {
    return null;
  }
  return null;
}

function loadQueuedDmMessages(): QueuedMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(DM_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.to === "string" &&
        Array.isArray(item.data) &&
        typeof item.queuedAt === "number"
    ) as QueuedMessage[];
  } catch {
    return [];
  }
}

function saveQueuedDmMessages(queue: QueuedMessage[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(DM_QUEUE_KEY, JSON.stringify(queue));
}

function queueDmMessage(toDid: string, data: Uint8Array): void {
  const queue = loadQueuedDmMessages();
  queue.push({ to: toDid, data: Array.from(data), queuedAt: Date.now() });
  saveQueuedDmMessages(queue);
}

async function flushQueuedDmForPeer(peerId: string): Promise<void> {
  const peerDid = _peerIdToDid.get(peerId);
  if (!peerDid) return; // Can't flush if we don't know their DID yet

  const queue = loadQueuedDmMessages();
  const remaining: QueuedMessage[] = [];
  for (const entry of queue) {
    // Check if message is for this peer (by DID, not peerId)
    if (entry.to !== peerDid) {
      remaining.push(entry);
      continue;
    }
    try {
      await _transport.send(peerId, new Uint8Array(entry.data));
    } catch {
      remaining.push(entry);
    }
  }
  saveQueuedDmMessages(remaining);
}

function resolveDmDisplayName(peerId: string): string {
  const did = _peerIdToDid.get(peerId);
  if (did)
    return (
      transportState.peerNames.get(did) ??
      transportState.peerNames.get(peerId) ??
      peerId.slice(0, 12)
    );
  return transportState.peerNames.get(peerId) ?? peerId.slice(0, 12);
}

async function joinPhonebookDmRooms(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid) return;
  const entries = await getPhonebookEntries();
  for (const entry of entries) {
    const peerDid = resolveToDid(entry.peerId);
    const roomCode = await hashDmRoomCode(selfDid, peerDid);
    _transport.joinRoom(roomCode);
  }
}

async function ensureDmRoomForPeer(peerIdOrDid: string): Promise<string> {
  const peerDid = resolveToDid(peerIdOrDid);
  const roomCode = await dmConversationCodeAsync(peerIdOrDid);
  const existing = await getRoom(roomCode);
  if (existing) return roomCode;
  const room: DMRoom = {
    roomCode,
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: [peerDid],
    participantLastSeen: {},
    participantDid: peerDid,
  };
  await putRoom(room);
  return roomCode;
}

export const _dtln = new DtlnProcessor();
_dtln.init().catch(console.error);
export const _transport = new LibP2PTransport();
export const _voice = new LibP2PVoice(_transport, _dtln);
export const _video = new MediasoupVideo();
export const _fileTransport = new WebTorrentFileTransport(() =>
  _transport.selfId()
);

function lamportSend(): number {
  _lamport += 1;
  return _lamport;
}

function lamportReceive(remote: number): void {
  _lamport = Math.max(_lamport, remote) + 1;
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function decode(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

function normalizeAvatarUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

interface FileSignalWireMessage {
  type: "__file_signal";
  payload: FileSignalEnvelope;
}

function isFileSignalWireMessage(
  value: unknown
): value is FileSignalWireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "__file_signal" &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    (value as { payload?: unknown }).payload !== null
  );
}

function maybePeerIdFromSenderId(senderId: string): string | null {
  if (_transport.peers().includes(senderId)) return senderId;
  for (const [peerId, did] of _peerIdToDid) {
    if (did === senderId) return peerId;
  }
  return null;
}

function shouldAutoDownload(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}

async function fileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function withFileTransfer(snapshot: FileTransferSnapshot): void {
  const prev = transportState.fileTransfers.get(snapshot.infoHash);
  const nextSnapshot: FileTransferSnapshot = {
    ...(prev ?? {}),
    ...snapshot,
    blobURL: snapshot.blobURL ?? prev?.blobURL,
  } as FileTransferSnapshot;
  const next = new Map(transportState.fileTransfers);
  next.set(snapshot.infoHash, nextSnapshot);
  transportState.fileTransfers = next;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const transfer of transportState.fileTransfers.values()) {
      if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
    }
  });
}

// ── Senders ───────────────────────────────────────────────────────────────────

function _sendCallPresence(peerId?: string): void {
  const payload = encode({
    type: MessageType.CallPresence,
    inCall: transportState.inCall,
  });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

function _sendCallState(peerId?: string): void {
  const payload = encode({
    type: MessageType.CallState,
    muted: transportState.muted,
    deafened: transportState.deafened,
  });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

function _sendRoomName(peerId?: string): void {
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name) return;
  const payload = encode({ type: MessageType.RoomName, name });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

async function _sendProfile(peerId?: string): Promise<void> {
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

  if (peerId) {
    _transport.send(
      peerId,
      encode({ type: MessageType.Profile, name, did, avatarUrl })
    );
    return;
  }
  _transport.broadcast(
    encode({ type: MessageType.Profile, name, did, avatarUrl }),
    transportState.roomCode!
  );
}

async function _broadcastProfile(): Promise<void> {
  try {
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
    _transport.broadcast(
      encode({ type: MessageType.Profile, name, did, avatarUrl }),
      transportState.roomCode!
    );
  } catch {}
}

async function _sendDigest(peerId: string): Promise<void> {
  if (!transportState.roomCode) return;
  const watermarks = await getWatermarksForRoom(transportState.roomCode);
  await _transport.send(
    peerId,
    encode({ type: MessageType.SyncDigest, watermarks })
  );
}

// ── History ───────────────────────────────────────────────────────────────────

async function _loadHistory(roomCode: string): Promise<void> {
  const [msgs, profiles] = await Promise.all([
    getMessages(roomCode),
    getAllPeerProfiles(),
  ]);
  transportState.messages = msgs;
  if (msgs.length > 0) {
    _lamport = Math.max(_lamport, ...msgs.map((m) => m.lamport));
  }
  if (profiles.length > 0) {
    const names = new Map(transportState.peerNames);
    const avatars = new Map(transportState.peerAvatars);
    for (const p of profiles) {
      names.set(p.did, p.nickname);
      if (p.pfpURL) avatars.set(p.did, p.pfpURL);
    }
    transportState.peerNames = names;
    transportState.peerAvatars = avatars;
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
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const mine = await getWatermarksForRoom(transportState.roomCode);

  const theyAreMissing = Object.keys(mine).filter(
    (sid) => (theirWatermarks[sid] ?? -1) < mine[sid]
  );

  if (theyAreMissing.length > 0) {
    await _pushMissingTo(peerId, theirWatermarks);
  }
}

async function _pushMissingTo(
  peerId: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const all = await getAllMessages(transportState.roomCode);
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
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(peerId, encode({ type: MessageType.SyncComplete }));
}

async function _handleSyncBatch(messages: WireChatMessage[]): Promise<void> {
  if (!messages.length || !transportState.roomCode) return;

  const roomCode = transportState.roomCode;
  const fullMessages = messages.map((w) => wireToMessage(w, roomCode));

  await bulkPutMessages(fullMessages);

  for (const m of fullMessages) {
    lamportReceive(m.lamport);
    await setWatermark(m.roomCode, m.senderId, m.lamport);
  }

  refreshUnreadCount(roomCode).catch(() => {});

  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newMsgs = fullMessages.filter((m) => !existingIds.has(m.id));
  if (newMsgs.length > 0) {
    transportState.messages = [...transportState.messages, ...newMsgs].sort(
      (a, b) =>
        a.lamport !== b.lamport
          ? a.lamport - b.lamport
          : a.senderId.localeCompare(b.senderId)
    );
  }
}

function _handleSyncComplete(peerId: string): void {
  transportState.messages = [...transportState.messages].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );
  for (const pid of _transport.peers()) {
    if (pid !== peerId) _sendDigest(pid).catch(() => {});
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

function _handleProfile(peerId: string, msg: WireProfile): void {
  const did = msg.did ?? peerId;
  _peerIdToDid.set(peerId, did);

  const avatarUrl = normalizeAvatarUrl(msg.avatarUrl);

  const names = new Map(transportState.peerNames);
  names.set(did, msg.name);
  transportState.peerNames = names;

  const avatars = new Map(transportState.peerAvatars);
  if (avatarUrl) avatars.set(did, avatarUrl);
  else avatars.delete(did);
  transportState.peerAvatars = avatars;

  getPeerProfile(did)
    .then((existing) =>
      putPeerProfile({
        did,
        isMe: false,
        nickname: msg.name,
        pfpURL: avatarUrl,
        updatedAt: Date.now(),
        ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
      }).catch(() => {})
    )
    .catch(() => {});
}

function _handleCallPresence(peerId: string, inCall: boolean): void {
  const next = new Set(transportState.callPeerIds);

  if (inCall) {
    next.add(peerId);
  } else {
    next.delete(peerId);

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
}

function _handleCallState(peerId: string, msg: WireCallState): void {
  const next = new Map(transportState.callPeerStates);
  next.set(peerId, {
    muted: !!msg.muted,
    deafened: !!msg.deafened,
  });
  transportState.callPeerStates = next;
}

function _handleRoomName(name: string): void {
  const trimmed = name.trim().slice(0, 64);
  if (trimmed.length > 0) transportState.roomName = trimmed;
}

function _handleJoinRoom(peerId: string): void {
  if (!transportState.roomCode) return;
  if (!peerId) return;
  const uniqueUsers = [...new Set(transportState.roomUsers)];
  if (!uniqueUsers.includes(peerId)) {
    uniqueUsers.push(peerId);
    transportState.roomUsers = uniqueUsers;
    addRoomParticipant(transportState.roomCode, peerId).catch(() => {});
  }
}

function _handleLeaveRoom(peerId: string): void {
  // Explicit leave - remove user from room list AND from peerId->DID mapping
  if (!transportState.roomCode) return;
  const currentUsers = new Set(transportState.roomUsers);
  if (currentUsers.has(peerId)) {
    currentUsers.delete(peerId);
    transportState.roomUsers = [...currentUsers];
    removeRoomParticipant(transportState.roomCode, peerId).catch(() => {});
  }
  // Clean up the peerId->DID mapping when user explicitly leaves
  _peerIdToDid.delete(peerId);
}

function _handleRoomUsersSync(participants: string[]): void {
  if (!transportState.roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const merged = new Set([...transportState.roomUsers, ...participants]);
  if (selfDid) merged.add(selfDid);
  transportState.roomUsers = [...merged];
}

function _broadcastJoinRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.JoinRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

function _broadcastLeaveRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

function _handleChatMessage(
  wire: WireChatMessage,
  roomCodeOverride?: string,
  receivedFromPeerId?: string
): void {
  const roomCode = roomCodeOverride ?? transportState.roomCode;
  if (!roomCode) return;

  // DM rooms now start with "dm-" (hash-based)
  // We don't need to ensure room here - it should already exist from sender context

  lamportReceive(wire.lamport);

  const msg = wireToMessage(wire, roomCode);

  putMessage(msg).catch(() => {});
  setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  refreshUnreadCount(msg.roomCode).catch(() => {});

  const isNewMessage = !transportState.messages.some((m) => m.id === msg.id);

  // DM rooms now start with "dm-" (hash-based format)
  if (isNewMessage && msg.roomCode.startsWith("dm-")) {
    transportState.dmVersion += 1;
  }

  if (
    isNewMessage &&
    transportState.chatMode === "room" &&
    transportState.roomCode === msg.roomCode
  ) {
    transportState.messages = [...transportState.messages, msg].sort((a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
    );
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

async function _persistAttachmentStatusForInfoHash(
  infoHash: string,
  status: Attachment["status"]
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  await Promise.all(
    attachments.map((attachment) =>
      updateAttachmentStatus(attachment.id, status)
    )
  );
}

async function _persistDownloadedBlob(
  infoHash: string,
  blob: Blob
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  if (!attachments.length) return;

  const shouldPersistData = attachments.some(
    (attachment) => attachment.size <= MAX_PERSISTED_ATTACHMENT_BYTES
  );
  const data = shouldPersistData ? await blob.arrayBuffer() : undefined;

  await Promise.all(
    attachments.map((attachment) =>
      putAttachment({
        ...attachment,
        data:
          attachment.size <= MAX_PERSISTED_ATTACHMENT_BYTES
            ? data
            : attachment.data,
        status: "complete",
      })
    )
  );
}

async function _hydrateFileTransfersFromStorage(
  roomCode: string
): Promise<void> {
  const seedable = await getAttachmentsWithData(roomCode);
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    const file: FileEntry = {
      infoHash: attachment.infoHash,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    const blobURL = URL.createObjectURL(
      new Blob([attachment.data], { type: attachment.mimeType })
    );
    withFileTransfer({
      ...file,
      status: attachment.status,
      progress: 1,
      done: true,
      seeding: attachment.status === "seeding",
      peers: 0,
      seeders: attachment.status === "seeding" ? 1 : 0,
      blobURL,
    });
  }
}

async function _resumeAttachmentSeeding(roomCode: string): Promise<void> {
  const seedable = await getAttachmentsWithData(roomCode);
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
  }

  const files = [...dedup.values()].map(
    (attachment) =>
      new File([attachment.data!], attachment.filename, {
        type: attachment.mimeType,
        lastModified: attachment.createdAt,
      })
  );
  if (!files.length) return;

  const seeded = await _fileTransport.seedFiles(files);
  await Promise.all(
    seeded.map((entry) =>
      _persistAttachmentStatusForInfoHash(entry.infoHash, "seeding")
    )
  );
}

_fileTransport.on("signal", (peerId, envelope) => {
  _transport.send(
    peerId,
    encode({
      type: "__file_signal",
      payload: envelope,
    } satisfies FileSignalWireMessage)
  );
});

_fileTransport.on("transfer", (snapshot) => {
  withFileTransfer(snapshot);

  if (
    snapshot.status === "seeding" ||
    snapshot.status === "complete" ||
    snapshot.status === "failed"
  ) {
    _persistAttachmentStatusForInfoHash(
      snapshot.infoHash,
      snapshot.status
    ).catch(() => {});
  }
});

_fileTransport.on("downloaded", (infoHash, blob) => {
  _persistDownloadedBlob(infoHash, blob).catch(() => {});

  getAttachmentsByInfoHash(infoHash)
    .then(async (attachments) => {
      const existingTransfer = transportState.fileTransfers.get(infoHash);
      if (existingTransfer?.seeding) return;
      const attachment = attachments[0];
      if (!attachment) return;
      const file = new File([blob], attachment.filename, {
        type: attachment.mimeType,
        lastModified: Date.now(),
      });
      await _fileTransport.seedFiles([file]);
      await _persistAttachmentStatusForInfoHash(infoHash, "seeding");
    })
    .catch(() => {});
});

// ── Transport events ──────────────────────────────────────────────────────────

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  flushQueuedDmForPeer(peerId).catch(() => {});
  _fileTransport.onPeerConnect(peerId);
  _sendProfile(peerId);
  _sendRoomName(peerId);
  if (transportState.inCall) _sendCallPresence(peerId);
  if (transportState.inCall) _sendCallState(peerId);
  _sendDigest(peerId);
  const selfDid = identityStore.did ?? _transport.selfId();
  const participants = [...new Set([...transportState.roomUsers, selfDid])];
  _transport.send(
    peerId,
    encode({ type: MessageType.RoomUsersSync, participants })
  );
});

_transport.on("disconnect", (peerId) => {
  transportState.peers = _transport.peers();
  _fileTransport.onPeerDisconnect(peerId);

  // Note: We intentionally do NOT delete the peerId->DID mapping here.
  // The mapping is kept so we can still identify which DID a peerId
  // belonged to for offline user tracking. The mapping is only removed
  // when we receive an explicit LeaveRoom message.

  const parts = new Map(transportState.participants);
  parts.delete(peerId);
  transportState.participants = parts;

  const calls = new Set(transportState.callPeerIds);
  calls.delete(peerId);
  transportState.callPeerIds = calls;

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

_transport.on("message", (peerId, data, room) => {
  if (room === null) {
    const envelope = parseDmEnvelope(data);
    if (envelope) {
      if (envelope.type === "ack") {
        updateMessageStatus(envelope.messageId, "delivered").catch(() => {});
        const idx = transportState.messages.findIndex(
          (m) => m.id === envelope.messageId
        );
        if (idx !== -1) {
          const next = [...transportState.messages];
          next[idx] = { ...next[idx], status: "delivered" };
          transportState.messages = next;
        }
        return;
      }

      // Handle incoming DM chat message
      const senderDid = _peerIdToDid.get(peerId) ?? peerId;
      (async () => {
        const roomCode = await ensureDmRoomForPeer(peerId);
        _transport.joinRoom(roomCode);

        const msg: Message = {
          id: envelope.payload.id,
          roomCode,
          senderId: senderDid,
          senderName: resolveDmDisplayName(peerId),
          timestamp: envelope.payload.ts,
          lamport: envelope.payload.ts,
          type: MessageType.Text,
          content: envelope.payload.text,
          attachments: [],
          status: "delivered",
        };

        if (!transportState.messages.some((m) => m.id === msg.id)) {
          await putMessage(msg);
          await refreshDmRooms();
          transportState.dmVersion += 1;
          const activeDid = resolveToDid(transportState.activeDmPeerId ?? "");
          const isViewingThisDm =
            transportState.chatMode === "dm" &&
            (activeDid === senderDid || activeDid === peerId);
          if (isViewingThisDm) {
            transportState.messages = [...transportState.messages, msg].sort(
              (a, b) => a.timestamp - b.timestamp
            );
            await markRoomSeen(roomCode, msg.lamport);
            const roomIndex = roomsStore.dmRooms.findIndex(
              (r) => r.roomCode === roomCode
            );
            if (roomIndex !== -1) {
              roomsStore.dmRooms[roomIndex] = {
                ...roomsStore.dmRooms[roomIndex],
                lastSeenLamport: msg.lamport,
              };
            }
            await refreshDmRooms();
            transportState.dmVersion += 1;
          }
        }

        _transport
          .send(peerId, encodeDmAckEnvelope(envelope.payload.id))
          .catch(() => {});
      })().catch(console.error);
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
    if (did && transportState.roomCode) {
      updateParticipantLastSeen(transportState.roomCode, did).catch(() => {});
    }

    const msg = decoded as AnyWireMessage;

    switch (msg.type) {
      case MessageType.Profile:
        _handleProfile(peerId, msg);
        break;
      case MessageType.CallPresence:
        _handleCallPresence(peerId, msg.inCall);
        break;
      case MessageType.CallState:
        _handleCallState(peerId, msg);
        break;
      case MessageType.RoomName:
        _handleRoomName(msg.name);
        break;
      case MessageType.JoinRoom:
        _handleJoinRoom(msg.peerId);
        break;
      case MessageType.LeaveRoom:
        _handleLeaveRoom(msg.peerId);
        break;
      case MessageType.RoomUsersSync:
        _handleRoomUsersSync(msg.participants);
        break;
      case MessageType.SyncDigest:
        _handleDigest(peerId, msg.watermarks).catch(() => {});
        break;
      case MessageType.SyncBatch:
        _handleSyncBatch(msg.messages).catch(() => {});
        break;
      case MessageType.SyncComplete:
        _handleSyncComplete(peerId);
        break;
      case MessageType.Text:
      case MessageType.Reply:
      case MessageType.Reaction:
      case MessageType.File:
        _handleChatMessage(msg, room ?? undefined, peerId);
        break;
    }
  } catch (e) {
    console.warn("[app] message decode failed", e, data);
  }
});

// ── Voice events ──────────────────────────────────────────────────────────────

_voice.on("trackAdded", (peerId, track) => {
  const existing = transportState.participants.get(peerId) ?? {
    peerId,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
  };
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    {
      ...existing,
      audioTrack: track,
    }
  );
});

_voice.on("trackRemoved", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    {
      ...p,
      audioTrack: null,
    }
  );
});

_voice.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    {
      ...p,
      audioTrack: null,
    }
  );
});

_voice.on("error", (err) => {
  transportState.error = err.message;
});

// ── Video events ──────────────────────────────────────────────────────────────

_video.on("trackAdded", (peerId, track, source) => {
  const existing = transportState.participants.get(peerId) ?? {
    peerId,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
  };
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    source === "camera"
      ? { ...existing, videoTrack: track }
      : track.kind === "audio"
        ? { ...existing, screenAudioTrack: track }
        : { ...existing, screenTrack: track }
  );
  if (!transportState.sfuPeerIds.has(peerId)) {
    transportState.sfuPeerIds = new Set([...transportState.sfuPeerIds, peerId]);
  }
});

_video.on("trackRemoved", (peerId, source) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    source === "camera"
      ? { ...p, videoTrack: null }
      : { ...p, screenTrack: null, screenAudioTrack: null }
  );
});

_video.on("peerJoined", (peerId) => {
  if (!transportState.sfuPeerIds.has(peerId)) {
    transportState.sfuPeerIds = new Set([...transportState.sfuPeerIds, peerId]);
  }
});

_video.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (p) {
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...p,
        videoTrack: null,
        screenTrack: null,
        screenAudioTrack: null,
      }
    );
  }
  const next = new Set(transportState.sfuPeerIds);
  next.delete(peerId);
  transportState.sfuPeerIds = next;

  const tx = new Map(transportState.pendingTransmissions);
  tx.delete(peerId);
  transportState.pendingTransmissions = tx;

  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
  }
});

_video.on("transmissionAvailable", (peerId, producerId) => {
  transportState.pendingTransmissions = new Map(
    transportState.pendingTransmissions
  ).set(peerId, producerId);
  if (!transportState.sfuPeerIds.has(peerId)) {
    transportState.sfuPeerIds = new Set([...transportState.sfuPeerIds, peerId]);
  }
});

_video.on("transmissionEnded", (peerId) => {
  const next = new Map(transportState.pendingTransmissions);
  next.delete(peerId);
  transportState.pendingTransmissions = next;
  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
    playTransmissionEndedSound();
  }
});

_video.on("transmissionWatched", () => {
  playTransmissionJoinSound();
});

_video.on("transmissionWatchEnded", () => {
  playTransmissionLeaveSound();
});

_video.on("error", (err) => {
  transportState.error = err.message;
});

// ── Public API ────────────────────────────────────────────────────────────────

export async function connect() {
  if (transportState.relayConnected) return;
  if (_connectPromise) {
    await _connectPromise;
    return;
  }

  _connectPromise = (async () => {
    try {
      await _transport.connect(requireSession().privateKey);
      transportState.relayConnected = true;
      joinPhonebookDmRooms().catch(() => {});
    } catch (err) {
      transportState.error = err instanceof Error ? err.message : String(err);
      transportState.relayConnected = false;
    } finally {
      _connectPromise = null;
    }
  })();

  await _connectPromise;
}

export async function joinRoom(roomCode: string): Promise<void> {
  if (!transportState.relayConnected) {
    await connect();
  }

  if (!transportState.relayConnected) {
    transportState.error = "Transport not connected to relay";
    transportState.connecting = false;
    return;
  }

  transportState.error = null;
  transportState.connecting = true;
  try {
    await _loadHistory(roomCode);
    await _hydrateFileTransfersFromStorage(roomCode);
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
    transportState.roomUsers = [...participants];
    await addRoomParticipant(roomCode, selfDid);
    await _resumeAttachmentSeeding(roomCode);
    await _broadcastProfile();
    _broadcastJoinRoom();
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    transportState.connecting = false;
    throw err;
  }
}

export function leaveRoom(): void {
  _broadcastLeaveRoomAndDisconnect();
}

export function switchRoom(): void {
  _disconnectWithoutBroadcasting();
}

function _broadcastLeaveRoomAndDisconnect(): void {
  const roomCode = transportState.roomCode;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (roomCode && selfDid) {
    _broadcastLeaveRoom();
  }
  _disconnectWithoutBroadcasting();
}

function _disconnectWithoutBroadcasting(): void {
  for (const transfer of transportState.fileTransfers.values()) {
    if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
  }
  leaveCall();
  _transport.disconnect();
  _peerIdToDid.clear();
  transportState.connected = false;
  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.peers = [];
  transportState.messages = [];
  transportState.participants = new Map();
  transportState.peerNames = new Map();
  transportState.peerAvatars = new Map();
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

interface SendMessageOptions {
  replyTo?: Message["replyTo"];
  type?: ChatMessageType;
  meta?: FileMeta;
  attachments?: string[];
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

export async function sendMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
  if (transportState.chatMode === "dm") {
    await sendDirectMessage(text);
    return;
  }
  if (!transportState.roomCode) return;

  const profile = await getOwnProfile();
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const lamport = lamportSend();

  const msg: Message = {
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

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = [...transportState.messages, msg].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
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
  const lamport = lamportSend();

  const msg: Message = {
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

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);
  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = [...transportState.messages, msg].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
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
  const existing = transportState.messages
    .filter(
      (m) =>
        m.type === MessageType.Reaction &&
        m.reactionTo === messageId &&
        m.reactionEmoji === emoji
    )
    .sort((a, b) => b.lamport - a.lamport)
    .find((m) => m.senderId === (identityStore.did ?? _transport.selfId()));

  await sendMessage("", {
    type: MessageType.Reaction,
    reactionTo: messageId,
    reactionEmoji: emoji,
    reactionOp: existing?.reactionOp === "add" ? "remove" : "add",
  });
}

export async function loadMoreMessages(
  beforeLamport: number
): Promise<boolean> {
  if (!transportState.roomCode) return false;
  const older = await getMessages(transportState.roomCode, beforeLamport);
  if (!older.length) return false;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newOnes = older.filter((m) => !existingIds.has(m.id));
  transportState.messages = [...newOnes, ...transportState.messages].sort(
    (a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
  );
  return newOnes.length === 50;
}

export async function markSeen(): Promise<void> {
  if (!transportState.roomCode || !transportState.messages.length) return;
  const roomCode = transportState.roomCode;
  const maxLamport = Math.max(...transportState.messages.map((m) => m.lamport));
  await markRoomSeen(roomCode, maxLamport);
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) {
    roomsStore.rooms[idx] = {
      ...roomsStore.rooms[idx],
      lastSeenLamport: maxLamport,
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

export function directPeerId(): string {
  return _transport.selfId();
}

export function peerId(): string {
  return _transport.selfId();
}

export function isRelayed(peerId: string): boolean {
  return _transport.isRelayed(peerId);
}

export function peerIdToDid(peerId: string): string {
  return _peerIdToDid.get(peerId) ?? peerId;
}

export function didToPeerId(did: string): string | null {
  for (const [peerId, mappedDid] of _peerIdToDid) {
    if (mappedDid === did) return peerId;
  }
  return null;
}

export function isDmConversation(): boolean {
  return transportState.chatMode === "dm";
}

export async function dmConversationCodeFor(
  peerIdOrDid: string
): Promise<string> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  return dmConversationCodeAsync(resolvedPeerId);
}

export function dmConversationCodeForSync(peerIdOrDid: string): string {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  return dmConversationCodeSync(resolvedPeerId);
}

export async function openDmConversation(peerIdOrDid: string): Promise<void> {
  if (!_transport.selfId()) return;
  // Use the input as-is if we can't resolve to a peer ID
  // This supports opening DMs with DIDs directly
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  if (!resolvedPeerId) return;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  _transport.joinRoom(roomCode);
  await _loadHistory(roomCode);
  transportState.chatMode = "dm";
  transportState.activeDmPeerId = resolvedPeerId;
  transportState.roomCode = roomCode;
  transportState.roomName = resolveDmDisplayName(resolvedPeerId);
  transportState.connected = true;
}

export async function sendDirectMessage(text: string): Promise<void> {
  const peerId = transportState.activeDmPeerId;
  if (!peerId) return;
  const body = text.trim();
  if (!body) return;

  const roomCode = await ensureDmRoomForPeer(peerId);
  _transport.joinRoom(roomCode);

  const id = crypto.randomUUID();
  const ts = Date.now();
  const envelope = encodeDmChatEnvelope({ id, text: body, ts });

  const peerDid = _peerIdToDid.get(peerId) ?? peerId;
  const resolvedPeerId = resolveDmPeerId(peerId);

  if (!resolvedPeerId || !_transport.peers().includes(resolvedPeerId)) {
    queueDmMessage(peerDid, envelope);
  } else {
    try {
      await _transport.send(resolvedPeerId, envelope);
    } catch {
      queueDmMessage(peerDid, envelope);
    }
  }

  const mySenderId = identityStore.did ?? _transport.selfId();
  const msg: Message = {
    id,
    roomCode,
    senderId: mySenderId,
    senderName: "You",
    timestamp: ts,
    lamport: ts,
    type: MessageType.Text,
    content: body,
    attachments: [],
    status: "sent",
  };

  await putMessage(msg);
  // Refresh DM rooms list so the UI updates
  await refreshDmRooms();
  transportState.dmVersion += 1;
  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === peerId
  ) {
    transportState.messages = [...transportState.messages, msg].sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }
}

export async function addToPhonebook(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid);
  if (!resolvedPeerId) return;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  const did = _peerIdToDid.get(resolvedPeerId);
  const profile = did ? await getPeerProfile(did) : undefined;
  await putPhonebookEntry({
    peerId: resolvedPeerId,
    nickname: profile?.nickname || resolveDmDisplayName(resolvedPeerId),
    addedAt: Date.now(),
  });
  _transport.joinRoom(roomCode);
}

export async function removeFromPhonebook(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  await deletePhonebookEntry(resolvedPeerId);
  const roomCode = await dmConversationCodeAsync(resolvedPeerId);
  _transport.leaveRoom(roomCode);
}

export async function removeDmConversation(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  const allDmRooms = await getDMRooms();

  // Get the canonical room code for this peer
  const canonicalRoomCode = await dmConversationCodeAsync(resolvedPeerId);
  const candidates = new Set<string>([canonicalRoomCode]);

  // Also check rooms by participantDid match
  for (const room of allDmRooms) {
    if (
      room.participantDid === resolvedPeerId ||
      room.participantDid === peerIdOrDid
    ) {
      candidates.add(room.roomCode);
    }
  }

  const queue = loadQueuedDmMessages();
  saveQueuedDmMessages(queue.filter((q) => q.to !== resolvedPeerId));
  await Promise.all(
    [...candidates].map(async (roomCode) => {
      await deleteRoom(roomCode);
    })
  );

  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === resolvedPeerId
  ) {
    transportState.activeDmPeerId = null;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.messages = [];
    transportState.chatMode = "room";
    transportState.connected = false;
  }

  transportState.dmVersion += 1;
}

// ── Call ──────────────────────────────────────────────────────────────────────

export async function joinCall(): Promise<void> {
  transportState.error = null;
  try {
    await _voice.join(transportState.roomCode ?? "");
    await _video.join(transportState.roomCode ?? "", _transport.selfId());
    transportState.inCall = true;
    playJoinSound();
    _sendCallPresence();
    transportState.muted = _voice.isMuted();
    _sendCallState();
    transportState.localMicStream = _voice.getMicStream();
  } catch (err) {
    _voice.leave();
    _video.leave();
    transportState.inCall = false;
    transportState.muted = false;
    transportState.localCameraStream = null;
    transportState.localScreenStream = null;
    transportState.localMicStream = null;
    transportState.cameraOff = true;
    transportState.screenSharing = false;
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function leaveCall(): void {
  if (transportState.inCall) {
    playLeaveSound();
    transportState.inCall = false;
    _sendCallPresence();
  }
  stopCamera();
  stopScreenShare();
  _voice.leave();
  _video.leave();
  transportState.inCall = false;
  transportState.muted = false;
  transportState.deafened = false;
  transportState.participants = new Map();
  transportState.localCameraStream = null;
  transportState.localScreenStream = null;
  transportState.localMicStream = null;
  transportState.cameraOff = true;
  transportState.screenSharing = false;
  transportState.sfuPeerIds = new Set();
  transportState.pendingTransmissions = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
}

export function toggleMute(): void {
  if (_voice.isMuted()) {
    _voice.unmute();
    playUnmuteSound();
  } else {
    _voice.mute();
    playMuteSound();
  }
  transportState.muted = _voice.isMuted();
  _sendCallState();
}

export async function startCamera(): Promise<void> {
  transportState.error = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    transportState.localCameraStream = stream;
    transportState.cameraOff = false;
    playCameraOnSound();
    await _video.startCamera(stream);
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopCamera(): void {
  transportState.localCameraStream?.getTracks().forEach((t) => t.stop());
  transportState.localCameraStream = null;
  transportState.cameraOff = true;
  playCameraOffSound();
  _video.stopCamera();
}

export async function toggleCamera(): Promise<void> {
  if (transportState.cameraOff) await startCamera();
  else stopCamera();
}

export async function startScreenShare(): Promise<void> {
  transportState.error = null;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: true,
    });
    transportState.localScreenStream = stream;
    transportState.screenSharing = true;
    playScreenShareStartSound();
    stream.getVideoTracks()[0].onended = () => stopScreenShare();
    await _video.startScreenShare(stream);
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopScreenShare(): void {
  transportState.localScreenStream?.getTracks().forEach((t) => t.stop());
  transportState.localScreenStream = null;
  transportState.screenSharing = false;
  playScreenShareStopSound();
  _video.stopScreenShare();
}

export function pauseVideo(source: VideoSource): void {
  _video.pauseVideo(source);
}
export function resumeVideo(source: VideoSource): void {
  _video.resumeVideo(source);
}

export async function watchTransmission(
  peerId: string,
  producerId: string
): Promise<void> {
  transportState.error = null;
  try {
    await _video.watchTransmission(peerId, producerId);
    transportState.watchingTransmissionPeerId = peerId;
    transportState.watchingTransmissionProducerId = producerId;
    const next = new Map(transportState.pendingTransmissions);
    next.delete(peerId);
    transportState.pendingTransmissions = next;
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopWatchingTransmission(): void {
  const peerId = transportState.watchingTransmissionPeerId;
  const producerId = transportState.watchingTransmissionProducerId;
  if (!peerId || !producerId) return;
  _video.stopWatchingTransmission(peerId);
  transportState.pendingTransmissions = new Map(
    transportState.pendingTransmissions
  ).set(peerId, producerId);
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
}

// ── Voice device / gain controls ──────────────────────────────────────────────

export async function setVoiceInputDevice(deviceId: string): Promise<void> {
  await _voice.setInputDevice(deviceId);
  transportState.localMicStream = _voice.getMicStream();
}

export function getVoiceInputDevices(): Promise<MediaDeviceInfo[]> {
  return _voice.getInputDevices();
}

export function getVoiceActiveInputDevice(): string | null {
  return _voice.getActiveInputDevice();
}

export function setVoiceInputGain(gain: number): void {
  _voice.setInputGain(gain);
}
export function getVoiceInputGain(): number {
  return _voice.getInputGain();
}

export async function setVoiceOutputDevice(deviceId: string): Promise<void> {
  await _voice.setOutputDevice(deviceId);
}

export function getVoiceOutputDevices(): Promise<MediaDeviceInfo[]> {
  return _voice.getOutputDevices();
}

export function getVoiceActiveOutputDevice(): string | null {
  return _voice.getActiveOutputDevice();
}

export function setVoiceOutputVolume(volume: number): void {
  const next = Math.max(0, volume);
  _voiceOutputBeforeDeafen = next;
  if (!transportState.deafened) _voice.setOutputVolume(next);
}

export function getVoiceOutputVolume(): number {
  return _voice.getOutputVolume();
}

export function setVoiceDtlnNoiseGate(threshold: number): void {
  _dtln.setNoiseGate(threshold);
}

export function setVoiceDtlnEnabled(enabled: boolean): void {
  _voice.setDtlnEnabled(enabled);
}

export function getVoiceDtlnEnabled(): boolean {
  return _voice.isDtlnEnabled();
}

export function setTransmissionOutputVolume(volume: number): void {
  const next = Math.max(0, Math.min(1, volume));
  _videoOutputBeforeDeafen = next;
  transportState.transmissionOutputVolume = next;
  _applyTransmissionVolume(next);
}

function _applyTransmissionVolume(volume: number): void {
  document
    .querySelectorAll<HTMLAudioElement>("audio[data-remote]")
    .forEach((el) => {
      el.volume = volume;
    });
}

export function getTransmissionOutputVolume(): number {
  return _videoOutputBeforeDeafen;
}

export function setDeafened(deafened: boolean): void {
  if (deafened) {
    // Save current states before deafening
    _voiceOutputBeforeDeafen = _voice.getOutputVolume();
    _videoOutputBeforeDeafen = transportState.transmissionOutputVolume;
    _mutedBeforeDeafen = transportState.muted;
    // Deafen (mute output)
    _voice.setOutputVolume(0);
    transportState.transmissionOutputVolume = 0;
    _applyTransmissionVolume(0);
    // Also mute input if not already muted
    if (!_voice.isMuted()) {
      _voice.mute();
      transportState.muted = true;
    }
    transportState.deafened = true;
    playDeafenSound();
  } else {
    // Undeafen (restore output)
    _voice.setOutputVolume(_voiceOutputBeforeDeafen);
    transportState.transmissionOutputVolume = _videoOutputBeforeDeafen;
    _applyTransmissionVolume(_videoOutputBeforeDeafen);
    // Restore mute state: unmute only if we weren't muted before deafening
    if (!_mutedBeforeDeafen && _voice.isMuted()) {
      _voice.unmute();
      transportState.muted = false;
    }
    transportState.deafened = false;
    playUndeafenSound();
  }
  _sendCallState();
}

export function toggleDeafen(): void {
  setDeafened(!transportState.deafened);
}
