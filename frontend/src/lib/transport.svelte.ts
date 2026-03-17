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
import {
  MessageType,
  wireToMessage,
  messageToWire,
  type Message,
  type ChatMessageType,
  type AnyWireMessage,
  type WireChatMessage,
  type WireProfile,
} from "./types/message";
import { refreshUnreadCount, roomsStore } from "./rooms.svelte";

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
  callPeerIds: Set<string>;
  sfuPeerIds: Set<string>;
  pendingTransmissions: Map<string, string>;
  watchingTransmissionPeerId: string | null;
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

const BATCH_SIZE = 20;
const _peerIdToDid = new Map<string, string>();

const _transport = new SimplePeerTransport();
const _voice = new SimplePeerVoice(_transport);
const _video = new MediasoupVideo();

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

// ── Senders ───────────────────────────────────────────────────────────────────

function _sendCallPresence(peerId?: string): void {
  const payload = encode({
    type: MessageType.CallPresence,
    inCall: transportState.inCall,
  });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload);
}

function _sendRoomName(peerId?: string): void {
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name) return;
  const payload = encode({ type: MessageType.RoomName, name });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload);
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
      encode({ type: MessageType.Profile, name, did, avatarUrl })
    );
  } catch {}
}

async function _sendDigest(peerId: string): Promise<void> {
  if (!transportState.roomCode) return;
  const watermarks = await getWatermarksForRoom(transportState.roomCode);
  _transport.send(peerId, encode({ type: MessageType.SyncDigest, watermarks }));
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
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function _handleDigest(
  peerId: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const mine = await getWatermarksForRoom(transportState.roomCode);

  // Push what they're missing — they'll do the same for us when they receive our digest
  const theyAreMissingSenders = Object.keys(mine).filter(
    (sid) => (theirWatermarks[sid] ?? -1) < mine[sid]
  );

  if (theyAreMissingSenders.length > 0) {
    await _pushMissingTo(peerId, theirWatermarks);
  }
}

async function _pushMissingTo(
  peerId: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const all = await getAllMessages(transportState.roomCode);

  const missing = all
    .filter((m) => m.lamport > (theirWatermarks[m.senderId] ?? -1))
    .map(messageToWire);

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
  }

  transportState.callPeerIds = next;
}

function _handleRoomName(name: string): void {
  const trimmed = name.trim().slice(0, 64);
  if (trimmed.length > 0) transportState.roomName = trimmed;
}

function _handleChatMessage(wire: WireChatMessage): void {
  if (!transportState.roomCode) return;

  lamportReceive(wire.lamport);

  const msg = wireToMessage(wire, transportState.roomCode);

  putMessage(msg).catch(() => {});
  setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  refreshUnreadCount(msg.roomCode).catch(() => {});

  if (!transportState.messages.some((m) => m.id === msg.id)) {
    transportState.messages = [...transportState.messages, msg].sort((a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
    );
  }
}

// ── Transport events ──────────────────────────────────────────────────────────

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  _broadcastProfile().catch(() => {});
  _sendRoomName(peerId);
  if (transportState.inCall) _sendCallPresence(peerId);
  _sendDigest(peerId).catch(() => {});
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
    const msg = decode(data) as AnyWireMessage;

    switch (msg.type) {
      case MessageType.Profile:
        _handleProfile(peerId, msg);
        break;
      case MessageType.CallPresence:
        _handleCallPresence(peerId, msg.inCall);
        break;
      case MessageType.RoomName:
        _handleRoomName(msg.name);
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
        _handleChatMessage(msg);
        break;
    }
  } catch {}
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
  }
});

_video.on("error", (err) => {
  transportState.error = err.message;
});

// ── Public API ────────────────────────────────────────────────────────────────

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

interface SendMessageOptions {
  replyTo?: Message["replyTo"];
  type?: ChatMessageType;
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

export async function sendMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
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
    attachments: [],
    replyTo: options.replyTo,
    reactionTo: options.reactionTo,
    reactionEmoji: options.reactionEmoji,
    reactionOp: options.reactionOp,
  };

  _transport.broadcast(encode(messageToWire(msg)));

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

export function peerIdToDid(peerId: string): string {
  return _peerIdToDid.get(peerId) ?? peerId;
}

// ── Call ──────────────────────────────────────────────────────────────────────

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
  if (_voice.isMuted()) _voice.unmute();
  else _voice.mute();
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

export function setTransmissionOutputVolume(volume: number): void {
  const next = Math.max(0, volume);
  _videoOutputBeforeDeafen = next;
  if (!transportState.deafened) _video.setOutputVolume(next);
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
  } else {
    _voice.setOutputVolume(_voiceOutputBeforeDeafen);
    _video.setOutputVolume(_videoOutputBeforeDeafen);
    transportState.deafened = false;
  }
}

export function toggleDeafen(): void {
  setDeafened(!transportState.deafened);
}
