import { SimplePeerTransport } from "./transport/simplepeer/transport";
import { SimplePeerVoice } from "./transport/simplepeer/voice";
import { MediasoupVideo } from "./transport/mediasoup";
import type { VideoSource } from "./transport/types";
import { identityStore } from "./identity.svelte";
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
} from "./storage";
import { type Message, type WireMessage, MessageType } from "./types/message";
import { refreshUnreadCount, roomsStore } from "./rooms.svelte";

export type { Message };

export interface ParticipantState {
  peerId: string;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
}

interface TransportState {
  connected: boolean;
  roomCode: string | null;
  roomName: string;
  peers: string[];
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
  /** Peers currently known to be in voice call (from call presence signaling). */
  callPeerIds: Set<string>;
  /** Peers known to be in the SFU room (have at least one producer). Used for the "join call" banner. */
  sfuPeerIds: Set<string>;
  /** Pending screen-share transmissions: peerId → producerId. Not yet being watched. */
  pendingTransmissions: Map<string, string>;
  /** The peerId of the transmission currently being watched, or null. */
  watchingTransmissionPeerId: string | null;
  /** The producerId of the transmission currently being watched, or null. */
  watchingTransmissionProducerId: string | null;
}

export const transportState = $state<TransportState>({
  connected: false,
  roomCode: null,
  roomName: "",
  peers: [],
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
});

let _lamport = 0;
let _voiceOutputBeforeDeafen = 1;
let _videoOutputBeforeDeafen = 1;

function lamportSend(): number {
  _lamport += 1;
  return _lamport;
}

function lamportReceive(remote: number): void {
  _lamport = Math.max(_lamport, remote) + 1;
}

const _transport = new SimplePeerTransport();
const _voice = new SimplePeerVoice(_transport);
const _video = new MediasoupVideo();

// ── Sync state ───────────────────────────────────────────────────────────────

const SYNC_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 20;

let _syncTimeoutId: ReturnType<typeof setTimeout> | null = null;
let _pendingSyncPeer: string | null = null;
const _peerIdToDid = new Map<string, string>();

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function _sendCallPresence(peerId?: string): void {
  const payload = encode({ kind: "call-presence", inCall: transportState.inCall });
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  _transport.broadcast(payload);
}

function _sendRoomName(peerId?: string): void {
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name) return;
  const payload = encode({ kind: "room-name", name });
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  _transport.broadcast(payload);
}

function selectSyncHost(peers: string[], myId: string): string {
  return [...peers, myId].sort()[0];
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
    _transport.broadcast(encode({ kind: "profile", name, did, avatarUrl }));
  } catch {}
}

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
}

async function _sendSyncRequest(peerId: string): Promise<void> {
  if (!transportState.roomCode) return;
  const watermarks = await getWatermarksForRoom(transportState.roomCode);
  _transport.send(
    peerId,
    encode({
      kind: "wire",
      type: MessageType.SyncRequest,
      roomCode: transportState.roomCode,
      watermarks,
    })
  );
  _pendingSyncPeer = peerId;
  if (_syncTimeoutId) clearTimeout(_syncTimeoutId);
  _syncTimeoutId = setTimeout(() => _onSyncTimeout(), SYNC_TIMEOUT_MS);
}

function _onSyncTimeout(): void {
  _syncTimeoutId = null;
  _pendingSyncPeer = null;
  const myId = _transport.selfId();
  const host = selectSyncHost(_transport.peers(), myId);
  if (host !== myId) {
    _sendSyncRequest(host).catch(() => {});
  }
}

async function _handleSyncRequest(
  peerId: string,
  watermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  // Use getAllMessages (no page limit) so we send the full history, not just the latest 50
  const allMsgs = await getAllMessages(transportState.roomCode);

  const missing = allMsgs.filter(
    (m) => m.lamport > (watermarks[m.senderId] ?? 0)
  );

  const batches: Message[][] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }

  _transport.send(
    peerId,
    encode({
      kind: "wire",
      type: MessageType.SyncOffer,
      totalMessages: missing.length,
      totalBatches: batches.length,
    })
  );

  for (let i = 0; i < batches.length; i++) {
    _transport.send(
      peerId,
      encode({
        kind: "wire",
        type: MessageType.SyncBatch,
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(
    peerId,
    encode({ kind: "wire", type: MessageType.SyncComplete })
  );
}

async function _handleSyncBatch(messages: Message[]): Promise<void> {
  if (!messages.length) return;

  // Write all to IDB — put is idempotent so duplicates are safe
  await bulkPutMessages(messages);

  for (const m of messages) {
    lamportReceive(m.lamport);
    // setWatermark now has max semantics so batch ordering doesn't matter
    await setWatermark(m.roomCode, m.senderId, m.lamport);
  }

  if (transportState.roomCode) {
    refreshUnreadCount(transportState.roomCode).catch(() => {});
  }

  // Merge into in-memory list (dedup by id, then sort)
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newMsgs = messages.filter((m) => !existingIds.has(m.id));
  if (newMsgs.length > 0) {
    transportState.messages = [...transportState.messages, ...newMsgs].sort(
      (a, b) =>
        a.lamport !== b.lamport
          ? a.lamport - b.lamport
          : a.senderId.localeCompare(b.senderId)
    );
  }
}

async function _reloadMessagesFromIDB(): Promise<void> {
  if (!transportState.roomCode) return;
  // Reload the latest page from IDB to reflect everything written during sync
  const msgs = await getMessages(transportState.roomCode);
  transportState.messages = msgs;
  if (msgs.length > 0) {
    _lamport = Math.max(_lamport, ...msgs.map((m) => m.lamport));
  }
}

function _handleSyncComplete(peerId: string): void {
  if (_pendingSyncPeer === peerId) {
    if (_syncTimeoutId) clearTimeout(_syncTimeoutId);
    _syncTimeoutId = null;
    _pendingSyncPeer = null;
    // Reload the display page from IDB — all batches have been written,
    // so the in-memory view is now authoritative and correctly paginated
    _reloadMessagesFromIDB().catch(() => {});
  }
}

// ── Transport event handlers ─────────────────────────────────────────────────

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  _broadcastProfile();
  _sendRoomName(peerId);
  if (transportState.inCall) {
    _sendCallPresence(peerId);
  }

  const myId = _transport.selfId();
  const host = selectSyncHost(_transport.peers(), myId);
  if (host !== myId) {
    _sendSyncRequest(host).catch(() => {});
  }
});

_transport.on("disconnect", (peerId) => {
  transportState.peers = _transport.peers();
  const parts = new Map(transportState.participants);
  parts.delete(peerId);
  transportState.participants = parts;
  const calls = new Set(transportState.callPeerIds);
  calls.delete(peerId);
  transportState.callPeerIds = calls;
  const did = _peerIdToDid.get(peerId);
  if (did) {
    const names = new Map(transportState.peerNames);
    const avatars = new Map(transportState.peerAvatars);
    names.delete(did);
    avatars.delete(did);
    transportState.peerNames = names;
    transportState.peerAvatars = avatars;
    _peerIdToDid.delete(peerId);
  }
  // Clean up SFU tracking and any pending transmission
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

_transport.on("message", (peerId, data) => {
  try {
    const envelope = decode(data) as { kind: string; [k: string]: unknown };

    if (envelope.kind === "profile" && typeof envelope.name === "string") {
      const did = typeof envelope.did === "string" ? envelope.did : peerId;
      _peerIdToDid.set(peerId, did);
      const avatarUrl = normalizeAvatarUrl(envelope.avatarUrl);
      const names = new Map(transportState.peerNames);
      names.set(did, envelope.name);
      transportState.peerNames = names;
      const avatars = new Map(transportState.peerAvatars);
      if (avatarUrl) {
        avatars.set(did, avatarUrl);
      } else {
        avatars.delete(did);
      }
      transportState.peerAvatars = avatars;
      getPeerProfile(did)
        .then((existing) => {
          putPeerProfile({
            did,
            isMe: false,
            nickname: envelope.name as string,
            pfpURL: avatarUrl,
            updatedAt: Date.now(),
            ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
          }).catch(() => {});
        })
        .catch(() => {});
      return;
    }

    if (envelope.kind === "call-presence") {
      const inCall = envelope.inCall === true;
      const next = new Set(transportState.callPeerIds);
      if (inCall) {
        next.add(peerId);
      } else {
        next.delete(peerId);

        // Peer left call: remove stale participant/media/transmission state.
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
      }
      transportState.callPeerIds = next;
      return;
    }

    if (envelope.kind === "room-name" && typeof envelope.name === "string") {
      const name = envelope.name.trim().slice(0, 64);
      if (name.length > 0) {
        transportState.roomName = name;
      }
      return;
    }

    if (envelope.kind === "wire") {
      const type = envelope.type as MessageType;

      if (type === MessageType.SyncRequest) {
        _handleSyncRequest(
          peerId,
          (envelope.watermarks as Record<string, number>) ?? {}
        );
        return;
      }

      if (type === MessageType.SyncOffer) {
        return;
      }

      if (type === MessageType.SyncBatch) {
        _handleSyncBatch((envelope.messages as Message[]) ?? []);
        return;
      }

      if (type === MessageType.SyncComplete) {
        _handleSyncComplete(peerId);
        return;
      }

      if (type === MessageType.Text || type === MessageType.Reply) {
        const wire = envelope as unknown as WireMessage;
        if (!transportState.roomCode) return;

        lamportReceive(wire.lamport);

        const msg: Message = {
          id: wire.id,
          roomCode: transportState.roomCode,
          senderId: wire.senderId,
          senderName: wire.senderName,
          senderDid: wire.senderDid,
          sig: wire.sig,
          timestamp: wire.timestamp,
          lamport: wire.lamport,
          type: wire.type,
          content: wire.content,
          meta: wire.meta,
          attachments: [],
          replyTo: wire.replyTo,
        };

        putMessage(msg).catch(() => {});
        setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
        refreshUnreadCount(msg.roomCode).catch(() => {});
        if (!transportState.messages.some((m) => m.id === msg.id)) {
          transportState.messages = [...transportState.messages, msg].sort(
            (a, b) =>
              a.lamport !== b.lamport
                ? a.lamport - b.lamport
                : a.senderId.localeCompare(b.senderId)
          );
        }
      }
    }
  } catch {}
});

// ── Voice handlers ───────────────────────────────────────────────────────────

_voice.on("trackAdded", (peerId, track) => {
  const existing = transportState.participants.get(peerId) ?? {
    peerId,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
  };
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    { ...existing, audioTrack: track }
  );
});

_voice.on("trackRemoved", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    { ...p, audioTrack: null }
  );
});

_voice.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    { ...p, audioTrack: null }
  );
});

_voice.on("error", (err) => {
  transportState.error = err.message;
});

// ── Video handlers ───────────────────────────────────────────────────────────

_video.on("trackAdded", (peerId, track, source) => {
  const existing = transportState.participants.get(peerId) ?? {
    peerId,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
  };
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    source === "camera"
      ? { ...existing, videoTrack: track }
      : { ...existing, screenTrack: track }
  );
  // When any track is added, the peer is confirmed in the SFU room
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
      : { ...p, screenTrack: null }
  );
});

_video.on("peerJoined", (peerId) => {
  // Peer is now active in the SFU room
  if (!transportState.sfuPeerIds.has(peerId)) {
    transportState.sfuPeerIds = new Set([...transportState.sfuPeerIds, peerId]);
  }
});

_video.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (p) {
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      { ...p, videoTrack: null, screenTrack: null }
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
  // Record as pending — the peer is also now known to be in the SFU room
  transportState.pendingTransmissions = new Map(transportState.pendingTransmissions).set(peerId, producerId);
  if (!transportState.sfuPeerIds.has(peerId)) {
    transportState.sfuPeerIds = new Set([...transportState.sfuPeerIds, peerId]);
  }
});

_video.on("transmissionEnded", (peerId) => {
  // Remove from pending
  const next = new Map(transportState.pendingTransmissions);
  next.delete(peerId);
  transportState.pendingTransmissions = next;
  // If we were watching this peer, clear that state
  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
  }
});

_video.on("error", (err) => {
  transportState.error = err.message;
});

// ── Public API ───────────────────────────────────────────────────────────────

export async function joinRoom(roomCode: string): Promise<void> {
  transportState.error = null;
  try {
    await _loadHistory(roomCode);
    await _transport.connect(roomCode);
    transportState.connected = true;
    transportState.roomCode = roomCode;
    transportState.roomName = "";
    transportState.peers = _transport.peers();
    await _broadcastProfile();
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function leaveRoom(): void {
  leaveCall();
  _transport.disconnect();
  if (_syncTimeoutId) {
    clearTimeout(_syncTimeoutId);
    _syncTimeoutId = null;
  }
  _pendingSyncPeer = null;
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
}

export async function sendMessage(text: string): Promise<void> {
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
    type: MessageType.Text,
    content: text,
    attachments: [],
  };

  const wire: WireMessage = {
    id: msg.id,
    senderId: msg.senderId,
    senderName: msg.senderName,
    timestamp: msg.timestamp,
    lamport: msg.lamport,
    type: msg.type,
    content: msg.content,
  };

  _transport.broadcast(encode({ kind: "wire", ...wire }));

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = [...transportState.messages, msg];

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
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

export function peerIdToDid(peerId: string): string {
  return _peerIdToDid.get(peerId) ?? peerId;
}

export async function joinCall(): Promise<void> {
  transportState.error = null;
  try {
    await _voice.join(transportState.roomCode ?? "");
    await _video.join(transportState.roomCode ?? "", _transport.selfId());
    transportState.inCall = true;
    _sendCallPresence();
    transportState.muted = _voice.isMuted();
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
  } else {
    _voice.mute();
  }
  transportState.muted = _voice.isMuted();
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
    // Pass the already-acquired stream so mediasoup publishes the same tracks
    // without triggering a second getUserMedia permission prompt.
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
  _video.stopCamera();
}

export async function toggleCamera(): Promise<void> {
  if (transportState.cameraOff) {
    await startCamera();
  } else {
    stopCamera();
  }
}

export async function startScreenShare(): Promise<void> {
  transportState.error = null;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: false,
    });
    transportState.localScreenStream = stream;
    transportState.screenSharing = true;
    stream.getVideoTracks()[0].onended = () => stopScreenShare();
    // Pass the already-acquired stream so mediasoup publishes the same tracks
    // without triggering a second getDisplayMedia permission prompt.
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
  _video.stopScreenShare();
}

export function pauseVideo(source: VideoSource): void {
  _video.pauseVideo(source);
}

export function resumeVideo(source: VideoSource): void {
  _video.resumeVideo(source);
}

export async function watchTransmission(peerId: string, producerId: string): Promise<void> {
  transportState.error = null;
  try {
    await _video.watchTransmission(peerId, producerId);
    transportState.watchingTransmissionPeerId = peerId;
    transportState.watchingTransmissionProducerId = producerId;
    // Remove from pending (mediasoup.ts deletes it too, but keep in sync)
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
  // Restore the "Click to watch" tile — the remote peer is still producing
  transportState.pendingTransmissions = new Map(transportState.pendingTransmissions).set(peerId, producerId);
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
}

// ── Voice device / gain controls ─────────────────────────────────────────────

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
  if (transportState.deafened) {
    _voiceOutputBeforeDeafen = next;
    return;
  }
  _voiceOutputBeforeDeafen = next;
  _voice.setOutputVolume(next);
}

export function getVoiceOutputVolume(): number {
  return _voice.getOutputVolume();
}

export function setTransmissionOutputVolume(volume: number): void {
  const next = Math.max(0, volume);
  if (transportState.deafened) {
    _videoOutputBeforeDeafen = next;
    return;
  }
  _videoOutputBeforeDeafen = next;
  _video.setOutputVolume(next);
}

export function getTransmissionOutputVolume(): number {
  return _videoOutputBeforeDeafen;
}

export function setDeafened(deafened: boolean): void {
  if (deafened) {
    _voiceOutputBeforeDeafen = _voice.getOutputVolume();
    _videoOutputBeforeDeafen = getTransmissionOutputVolume();
    _voice.setOutputVolume(0);
    _video.setOutputVolume(0);
    transportState.deafened = true;
    return;
  }
  _voice.setOutputVolume(_voiceOutputBeforeDeafen);
  _video.setOutputVolume(_videoOutputBeforeDeafen);
  transportState.deafened = false;
}

export function toggleDeafen(): void {
  setDeafened(!transportState.deafened);
}
