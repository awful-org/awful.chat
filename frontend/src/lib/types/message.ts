export interface Message {
  id: string; // UUIDv7
  roomCode: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string; // ed25519 over canonical(id, senderId, lamport, content)
  timestamp: number; // wall clock, display only
  lamport: number; // logical clock, ordering source of truth
  type: MessageType;
  content: string;
  meta?: FileMeta;
  attachments: string[]; // Attachment.id refs
  replyTo?: ReplyTo;
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
  status?: MessageStatus; // DMs only
}

export enum MessageType {
  Text = "text",
  File = "file",
  System = "system",
  Reply = "reply",
  Reaction = "reaction",
  SyncRequest = "sync_request",
  SyncOffer = "sync_offer",
  SyncBatch = "sync_batch",
  SyncComplete = "sync_complete",
  SyncAck = "sync_ack",
  DeliveryAck = "delivery_ack",
  ReadAck = "read_ack",
}

export type MessageStatus = "sending" | "sent" | "delivered" | "read";

export interface PendingMessage {
  id: string; // same id as WireMessage
  to: string; // recipient did:key
  message: unknown; // WireMessage — typed as unknown to avoid circular dep
  createdAt: number;
  attempts: number;
}

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

export type AttachmentStatus =
  | "seeding"
  | "pending"
  | "downloading"
  | "complete"
  | "failed";

export interface WireMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string;
  timestamp: number;
  lamport: number;
  type: MessageType;
  content: string;
  meta?: FileMeta;
  replyTo?: ReplyTo;
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

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
