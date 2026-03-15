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
  peers: string[];
  messages: Message[];
  inCall: boolean;
  muted: boolean;
  participants: Map<string, ParticipantState>;
  localCameraStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  localMicStream: MediaStream | null;
  cameraOff: boolean;
  screenSharing: boolean;
  peerNames: Map<string, string>;
  peerAvatars: Map<string, string>;
  error: string | null;
}

export const transportState = $state<TransportState>({
  connected: false,
  roomCode: null,
  peers: [],
  messages: [],
  inCall: false,
  muted: false,
  participants: new Map(),
  localCameraStream: null,
  localScreenStream: null,
  localMicStream: null,
  cameraOff: true,
  screenSharing: false,
  peerNames: new Map(),
  peerAvatars: new Map(),
  error: null,
});

let _lamport = 0;

function lamportSend(): number {
  _lamport += 1;
  return _lamport;
}

function lamportReceive(remote: number): void {
  _lamport = Math.max(_lamport, remote) + 1;
}

const _transport = new SimplePeerTransport();
const _voice = new SimplePeerVoice(_transport);
const _video = new MediasoupVideo(_transport);

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
  for (const p of profiles) {
    transportState.peerNames.set(p.did, p.nickname);
    if (p.pfpURL) transportState.peerAvatars.set(p.did, p.pfpURL);
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
}

async function _handleSyncRequest(
  peerId: string,
  watermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const allMsgs = await getMessages(transportState.roomCode);

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
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newMsgs = messages.filter((m) => !existingIds.has(m.id));
  if (!newMsgs.length) return;

  await bulkPutMessages(newMsgs);

  for (const m of newMsgs) {
    lamportReceive(m.lamport);
    await setWatermark(m.roomCode, m.senderId, m.lamport);
  }

  if (transportState.roomCode) {
    refreshUnreadCount(transportState.roomCode).catch(() => {});
  }

  transportState.messages = [...transportState.messages, ...newMsgs].sort(
    (a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
  );
}

function _handleSyncComplete(peerId: string): void {
  if (_pendingSyncPeer === peerId) {
    if (_syncTimeoutId) clearTimeout(_syncTimeoutId);
    _syncTimeoutId = null;
    _pendingSyncPeer = null;
  }
}

// ── Transport event handlers ─────────────────────────────────────────────────

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  if (!transportState.participants.has(peerId)) {
    transportState.participants.set(peerId, {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
    });
  }
  _broadcastProfile();

  const myId = _transport.selfId();
  const host = selectSyncHost(_transport.peers(), myId);
  if (host !== myId) {
    _sendSyncRequest(peerId);
  }
});

_transport.on("disconnect", (peerId) => {
  transportState.peers = _transport.peers();
  transportState.participants.delete(peerId);
  const did = _peerIdToDid.get(peerId);
  if (did) {
    transportState.peerNames.delete(did);
    transportState.peerAvatars.delete(did);
    _peerIdToDid.delete(peerId);
  }
});

_transport.on("message", (peerId, data) => {
  try {
    const envelope = decode(data) as { kind: string; [k: string]: unknown };

    if (envelope.kind === "profile" && typeof envelope.name === "string") {
      const did = typeof envelope.did === "string" ? envelope.did : peerId;
      _peerIdToDid.set(peerId, did);
      transportState.peerNames.set(did, envelope.name);
      const avatarUrl =
        typeof envelope.avatarUrl === "string" ? envelope.avatarUrl : undefined;
      if (avatarUrl) {
        transportState.peerAvatars.set(did, avatarUrl);
      } else {
        transportState.peerAvatars.delete(did);
      }
      getPeerProfile(did)
        .then((existing) => {
          putPeerProfile({
            did,
            nickname: envelope.name as string,
            pfpURL: avatarUrl,
            updatedAt: Date.now(),
            ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
          }).catch(() => {});
        })
        .catch(() => {});
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

        transportState.messages = [...transportState.messages, msg].sort(
          (a, b) =>
            a.lamport !== b.lamport
              ? a.lamport - b.lamport
              : a.senderId.localeCompare(b.senderId)
        );
      }
    }
  } catch {}
});

// ── Voice handlers ───────────────────────────────────────────────────────────

_voice.on("trackAdded", (peerId, track) => {
  if (!transportState.participants.has(peerId)) {
    transportState.participants.set(peerId, {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
    });
  }
  const p = transportState.participants.get(peerId)!;
  transportState.participants.set(peerId, { ...p, audioTrack: track });
});

_voice.on("trackRemoved", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (p) transportState.participants.set(peerId, { ...p, audioTrack: null });
});

_voice.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (p) transportState.participants.set(peerId, { ...p, audioTrack: null });
});

_voice.on("error", (err) => {
  transportState.error = err.message;
});

// ── Video handlers ───────────────────────────────────────────────────────────

_video.on("trackAdded", (peerId, track, source) => {
  if (!transportState.participants.has(peerId)) {
    transportState.participants.set(peerId, {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
    });
  }
  const p = transportState.participants.get(peerId)!;
  if (source === "camera") {
    transportState.participants.set(peerId, { ...p, videoTrack: track });
  } else {
    transportState.participants.set(peerId, { ...p, screenTrack: track });
  }
});

_video.on("trackRemoved", (peerId, source) => {
  const p = transportState.participants.get(peerId);
  if (!p) return;
  if (source === "camera") {
    transportState.participants.set(peerId, { ...p, videoTrack: null });
  } else {
    transportState.participants.set(peerId, { ...p, screenTrack: null });
  }
});

_video.on("peerLeft", (peerId) => {
  const p = transportState.participants.get(peerId);
  if (p)
    transportState.participants.set(peerId, {
      ...p,
      videoTrack: null,
      screenTrack: null,
    });
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
  transportState.peers = [];
  transportState.messages = [];
  transportState.participants = new Map();
  transportState.peerNames = new Map();
  transportState.peerAvatars = new Map();
  transportState.error = null;
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

export function selfId(): string {
  return identityStore.did ?? _transport.selfId();
}

export async function joinCall(): Promise<void> {
  transportState.error = null;
  try {
    await _voice.join(transportState.roomCode ?? "");
    transportState.inCall = true;
    transportState.muted = _voice.isMuted();
    transportState.localMicStream = _voice.getMicStream();
    await _video.join(transportState.roomCode ?? "");
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function leaveCall(): void {
  stopCamera();
  stopScreenShare();
  _voice.leave();
  _video.leave();
  transportState.inCall = false;
  transportState.muted = false;
  transportState.localCameraStream = null;
  transportState.localScreenStream = null;
  transportState.localMicStream = null;
  transportState.cameraOff = true;
  transportState.screenSharing = false;
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
    await _video.startCamera();
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
    await _video.startScreenShare();
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
  _voice.setOutputVolume(volume);
}

export function getVoiceOutputVolume(): number {
  return _voice.getOutputVolume();
}
