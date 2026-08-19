import type { FileSignalEnvelope } from "$lib/transport/types";

export enum MessageType {
  // chat - persisted to IDB, sent over wire
  Text = "text",
  Reply = "reply",
  Reaction = "reaction",
  File = "file",
  // presence - wire only, never persisted
  Profile = "profile",
  CallPresence = "call_presence",
  CallState = "call_state",
  WatchPresence = "watch_presence",
  RoomName = "room_name",
  // room users - wire only, never persisted
  JoinRoom = "join_room",
  LeaveRoom = "leave_room",
  RoomUsersSync = "room_users_sync",
  // sync - wire only, never persisted
  SyncDigest = "sync_digest",
  SyncBatch = "sync_batch",
  SyncComplete = "sync_complete",
  // DM delivery/read receipts do NOT use MessageType - they are tagged
  // binary envelopes over the direct stream (see dm-codec.ts)
}

/** Types that are persisted to IDB and displayed in the chat. */
export type ChatMessageType =
  | MessageType.Text
  | MessageType.Reply
  | MessageType.Reaction
  | MessageType.File;

export type MessageStatus = "sending" | "sent" | "delivered" | "read";
export type AttachmentStatus =
  | "seeding"
  | "pending"
  | "downloading"
  | "complete"
  | "failed";

// ── Storage shapes ────────────────────────────────────────────────────────────

/** Full message as stored in IDB. */
export interface Message {
  id: string; // UUIDv7
  roomCode: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string; // ed25519 over the canonical form (see messaging.ts)
  sigV?: number; // canonical version: absent = v1, 2 = covers reactions/reply/meta
  timestamp: number; // wall clock, display only
  lamport: number; // logical clock, ordering source of truth
  type: ChatMessageType;
  content: string;
  meta?: FileMeta;
  attachments: string[]; // Attachment.id refs
  replyTo?: ReplyTo;
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
  status?: MessageStatus; // DMs only
}

export interface Attachment {
  id: string; // UUIDv7
  roomCode: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string; // permanent WebTorrent reference
  data?: ArrayBuffer; // only if size < 5MB
  blobURL?: string; // runtime only, never persisted
  status: AttachmentStatus;
  createdAt: number;
}

/** DM retry queue. */
export interface PendingMessage {
  id: string; // same id as the WireMessage
  to: string; // recipient did:key
  message: WireChatMessage; // the chat message to deliver
  createdAt: number;
  attempts: number;
}

// ── Shared sub-types ──────────────────────────────────────────────────────────

export interface ReplyTo {
  id: string;
  senderName: string;
  content: string; // snapshot at send time
}

export interface FileMeta {
  files: FileEntry[];
}

export interface FileEntry {
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string;
}

// ── Wire shapes ───────────────────────────────────────────────────────────────

/** Chat message sent over the wire and stored in IDB after receipt. */
export interface WireChatMessage {
  type: ChatMessageType;
  id: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string;
  sigV?: number;
  timestamp: number;
  lamport: number;
  content: string;
  meta?: FileMeta;
  replyTo?: ReplyTo;
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

// ── Presence wire messages ────────────────────────────────────────────────────

export interface WireProfile {
  type: MessageType.Profile;
  name: string;
  did: string | null;
  avatarUrl: string | null;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color?: string;
  /**
   * Proof that `did` owns the libp2p peerId this arrived from: the sender's
   * peerId, signed by the identity key behind `did`. The peerId can no longer
   * be derived from the DID (devices have their own libp2p keys), so the
   * binding has to be proven instead of computed.
   */
  peerId?: string;
  bindingSig?: string;
  /** Set on a profile sent in answer to one, so replies do not ping-pong. */
  reply?: boolean;
}

export interface WireCallPresence {
  type: MessageType.CallPresence;
  inCall: boolean;
  roomCode?: string; // the room where they're calling
}

export interface WireCallState {
  type: MessageType.CallState;
  muted: boolean;
  deafened: boolean;
}

export interface WireWatchPresence {
  type: MessageType.WatchPresence;
  /** Sharer peerId being watched, or null when the viewer stopped. */
  watching: string | null;
}

export interface WireRoomName {
  type: MessageType.RoomName;
  name: string;
  /** Which room this name is for. Required on a direct send, where there is
   *  no pubsub topic to infer it from. */
  roomCode?: string;
}

export interface WireJoinRoom {
  type: MessageType.JoinRoom;
  peerId: string;
}

export interface WireLeaveRoom {
  type: MessageType.LeaveRoom;
  peerId: string;
}

export interface WireRoomUsersSync {
  type: MessageType.RoomUsersSync;
  participants: string[];
  /** Which room this list belongs to; see WireRoomName.roomCode. */
  roomCode?: string;
}

// ── Sync wire messages ────────────────────────────────────────────────────────

export interface WireSyncDigest {
  type: MessageType.SyncDigest;
  roomCode: string; // the room this digest is for - receiver must have joined it
  watermarks: Record<string, number>; // senderId → maxLamport
}

export interface WireSyncBatch {
  type: MessageType.SyncBatch;
  roomCode: string; // the room these messages belong to
  messages: WireChatMessage[];
  batchIndex: number;
  totalBatches: number;
}

export interface WireSyncComplete {
  type: MessageType.SyncComplete;
  roomCode: string;
}

// File wire
export interface FileSignalWireMessage {
  type: "__file_signal";
  payload: FileSignalEnvelope;
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type AnyWireMessage =
  | WireChatMessage
  | WireProfile
  | WireCallPresence
  | WireWatchPresence
  | WireCallState
  | WireRoomName
  | WireJoinRoom
  | WireLeaveRoom
  | WireRoomUsersSync
  | WireSyncDigest
  | WireSyncBatch
  | WireSyncComplete;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reconstruct a full Message from a WireChatMessage on the receiving end. */
export function wireToMessage(
  wire: WireChatMessage,
  roomCode: string
): Message {
  return {
    id: wire.id,
    roomCode,
    senderId: wire.senderId,
    senderName: wire.senderName,
    senderDid: wire.senderDid,
    sig: wire.sig,
    sigV: wire.sigV,
    timestamp: wire.timestamp,
    lamport: wire.lamport,
    type: wire.type,
    content: wire.content,
    meta: wire.meta,
    attachments: [],
    replyTo: wire.replyTo,
    reactionTo: wire.reactionTo,
    reactionEmoji: wire.reactionEmoji,
    reactionOp: wire.reactionOp,
  };
}

/** Strip storage-only fields to produce a WireChatMessage. */
export function messageToWire(msg: Message): WireChatMessage {
  return {
    type: msg.type,
    id: msg.id,
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderDid: msg.senderDid,
    sig: msg.sig,
    sigV: msg.sigV,
    timestamp: msg.timestamp,
    lamport: msg.lamport,
    content: msg.content,
    meta: msg.meta,
    replyTo: msg.replyTo,
    reactionTo: msg.reactionTo,
    reactionEmoji: msg.reactionEmoji,
    reactionOp: msg.reactionOp,
  };
}

/** Type guard - is this a chat message that should be persisted? */
export function isChatMessage(msg: AnyWireMessage): msg is WireChatMessage {
  return (
    msg.type === MessageType.Text ||
    msg.type === MessageType.Reply ||
    msg.type === MessageType.Reaction ||
    msg.type === MessageType.File
  );
}
