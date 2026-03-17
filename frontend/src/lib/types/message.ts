export enum MessageType {
  // chat — persisted to IDB, sent over wire
  Text = "text",
  Reply = "reply",
  Reaction = "reaction",
  File = "file",
  // presence — wire only, never persisted
  Profile = "profile",
  CallPresence = "call_presence",
  RoomName = "room_name",
  // sync — wire only, never persisted
  SyncDigest = "sync_digest",
  SyncBatch = "sync_batch",
  SyncComplete = "sync_complete",
  // future
  SyncAck = "sync_ack",
  DeliveryAck = "delivery_ack",
  ReadAck = "read_ack",
  System = "system",
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
  sig?: string; // ed25519 over canonical(id, senderId, lamport, content)
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
}

export interface WireCallPresence {
  type: MessageType.CallPresence;
  inCall: boolean;
}

export interface WireRoomName {
  type: MessageType.RoomName;
  name: string;
}

// ── Sync wire messages ────────────────────────────────────────────────────────

export interface WireSyncDigest {
  type: MessageType.SyncDigest;
  watermarks: Record<string, number>; // senderId → maxLamport
}

export interface WireSyncBatch {
  type: MessageType.SyncBatch;
  messages: WireChatMessage[];
  batchIndex: number;
  totalBatches: number;
}

export interface WireSyncComplete {
  type: MessageType.SyncComplete;
}

// ── Ack wire messages ─────────────────────────────────────────────────────────

export interface WireDeliveryAck {
  type: MessageType.DeliveryAck;
  messageId: string;
  senderId: string;
}

export interface WireReadAck {
  type: MessageType.ReadAck;
  messageId: string;
  senderId: string;
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type AnyWireMessage =
  | WireChatMessage
  | WireProfile
  | WireCallPresence
  | WireRoomName
  | WireSyncDigest
  | WireSyncBatch
  | WireSyncComplete
  | WireDeliveryAck
  | WireReadAck;

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

/** Type guard — is this a chat message that should be persisted? */
export function isChatMessage(msg: AnyWireMessage): msg is WireChatMessage {
  return (
    msg.type === MessageType.Text ||
    msg.type === MessageType.Reply ||
    msg.type === MessageType.Reaction ||
    msg.type === MessageType.File
  );
}
