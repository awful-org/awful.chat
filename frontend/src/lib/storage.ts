import { openDB, type IDBPDatabase } from "idb";
import * as Y from "yjs";

import type {
  Attachment,
  AttachmentStatus,
  Message,
  MessageStatus,
  PendingMessage,
} from "./types/message";
import type { KeypairRecord, MnemonicRecord } from "./identity";

export type RoomType = "text" | "voice" | "dm";

export interface Room {
  roomCode: string;
  type: RoomType;
  name: string;
  lastSeenLamport: number; // unread count = messages with lamport > this
  createdAt: number;
  pfpData?: ArrayBuffer; // local upload — blobURL generated at runtime, never stored
  pfpURL?: string; // external URL (tenor, giphy, etc) — stored as-is
  // pfpData and pfpURL are mutually exclusive
}

export interface DMRoom extends Room {
  type: "dm";
  participantDid: string;
}

export interface OwnProfile {
  id: "own";
  did: string;
  nickname: string;
  pfpData?: ArrayBuffer; // local upload
  pfpURL?: string; // external URL — stored as-is
  updatedAt: number;
}

export interface PeerProfile {
  did: string; // PK
  nickname: string;
  pfpData?: ArrayBuffer;
  pfpURL?: string;
  updatedAt: number;
}

export interface WatermarkRecord {
  id: string; // "roomCode:senderId"
  roomCode: string;
  senderId: string;
  maxLamport: number;
}

export interface YjsDocRecord {
  id: string; // "channel:{roomCode}"
  update: Uint8Array;
}

type AppDB = IDBPDatabase<{
  messages: {
    key: string;
    value: Message;
    indexes: {
      byRoom: string;
      byRoomLamport: [string, number];
      bySender: string;
    };
  };
  attachments: {
    key: string;
    value: Attachment;
    indexes: {
      byMessage: string;
      byInfoHash: string;
      byStatus: string;
    };
  };
  pending: {
    key: string;
    value: PendingMessage;
    indexes: {
      byRecipient: string;
    };
  };
  identity: {
    key: string;
    value: MnemonicRecord | KeypairRecord;
  };
  watermarks: {
    key: string;
    value: WatermarkRecord;
    indexes: {
      byRoom: string;
    };
  };
  yjsDocs: {
    key: string;
    value: YjsDocRecord;
  };
  rooms: {
    key: string;
    value: Room | DMRoom;
    indexes: {
      byType: string;
    };
  };
  profiles: {
    key: string;
    value: OwnProfile | PeerProfile;
  };
}>;

let db: AppDB | null = null;

async function getDB(): Promise<AppDB> {
  if (db) return db;

  db = (await openDB("awful-chat", 1, {
    upgrade(database) {
      // messages
      const msgStore = database.createObjectStore("messages", {
        keyPath: "id",
      });
      msgStore.createIndex("byRoom", "roomCode", { unique: false });
      msgStore.createIndex("byRoomLamport", ["roomCode", "lamport"], {
        unique: false,
      });
      msgStore.createIndex("bySender", "senderId", { unique: false });

      // attachments
      const attStore = database.createObjectStore("attachments", {
        keyPath: "id",
      });
      attStore.createIndex("byMessage", "messageId", { unique: false });
      attStore.createIndex("byInfoHash", "infoHash", { unique: false });
      attStore.createIndex("byStatus", "status", { unique: false });

      // pending DM messages
      const penStore = database.createObjectStore("pending", { keyPath: "id" });
      penStore.createIndex("byRecipient", "to", { unique: false });

      // identity — keyed by "mnemonic" | "keypair"
      database.createObjectStore("identity", { keyPath: "id" });

      // watermarks — keyed by "roomCode:senderId"
      const wmStore = database.createObjectStore("watermarks", {
        keyPath: "id",
      });
      wmStore.createIndex("byRoom", "roomCode", { unique: false });

      // Yjs snapshots — keyed by "channel:{roomCode}"
      database.createObjectStore("yjsDocs", { keyPath: "id" });

      // rooms — keyed by roomCode
      const roomStore = database.createObjectStore("rooms", {
        keyPath: "roomCode",
      });
      roomStore.createIndex("byType", "type", { unique: false });

      // profiles — "own" for self, did:key for peers
      database.createObjectStore("profiles", { keyPath: "id" });
    },
  })) as AppDB;

  return db;
}

const PAGE_SIZE = 50;

/**
 * Load a page of messages for a room, sorted by lamport ascending.
 * Pass beforeLamport for cursor-based pagination (scroll up to load older).
 */
export async function getMessages(
  roomCode: string,
  beforeLamport?: number,
): Promise<Message[]> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");

  const upper: [string, number] = [
    roomCode,
    beforeLamport ?? Number.MAX_SAFE_INTEGER,
  ];
  const lower: [string, number] = [roomCode, 0];
  const range = IDBKeyRange.bound(
    lower,
    upper,
    false,
    beforeLamport !== undefined,
  );

  const results: Message[] = [];
  let cursor = await index.openCursor(range, "prev");

  while (cursor && results.length < PAGE_SIZE) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }

  return results.reverse();
}

export async function getMessage(id: string): Promise<Message | undefined> {
  const database = await getDB();
  return database.get("messages", id);
}

export async function putMessage(message: Message): Promise<void> {
  const database = await getDB();
  await database.put("messages", message);
}

export async function bulkPutMessages(messages: Message[]): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("messages", "readwrite");
  await Promise.all([...messages.map((m) => tx.store.put(m)), tx.done]);
}

export async function updateMessageStatus(
  id: string,
  status: MessageStatus,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("messages", "readwrite");
  const message = await tx.store.get(id);
  if (!message) return;
  await tx.store.put({ ...message, status });
  await tx.done;
}

export async function getAttachment(
  id: string,
): Promise<Attachment | undefined> {
  const database = await getDB();
  return database.get("attachments", id);
}

export async function getAttachmentsByMessage(
  messageId: string,
): Promise<Attachment[]> {
  const database = await getDB();
  return database.getAllFromIndex("attachments", "byMessage", messageId);
}

export async function getSeedableAttachments(): Promise<Attachment[]> {
  const database = await getDB();
  const complete = await database.getAllFromIndex(
    "attachments",
    "byStatus",
    "complete",
  );
  return complete.filter((a) => !!a.data);
}

export async function putAttachment(attachment: Attachment): Promise<void> {
  const database = await getDB();
  const { blobURL: _, ...record } = attachment;
  await database.put("attachments", record);
}

export async function updateAttachmentStatus(
  id: string,
  status: AttachmentStatus,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("attachments", "readwrite");
  const attachment = await tx.store.get(id);
  if (!attachment) return;
  await tx.store.put({ ...attachment, status });
  await tx.done;
}

export async function getPendingByRecipient(
  recipientDid: string,
): Promise<PendingMessage[]> {
  const database = await getDB();
  return database.getAllFromIndex("pending", "byRecipient", recipientDid);
}

export async function putPending(pending: PendingMessage): Promise<void> {
  const database = await getDB();
  await database.put("pending", pending);
}

export async function incrementPendingAttempts(id: string): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("pending", "readwrite");
  const record = await tx.store.get(id);
  if (!record) return;
  await tx.store.put({ ...record, attempts: record.attempts + 1 });
  await tx.done;
}

export async function deletePending(id: string): Promise<void> {
  const database = await getDB();
  await database.delete("pending", id);
}

export async function getKeypairRecord(): Promise<KeypairRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "keypair") as Promise<
    KeypairRecord | undefined
  >;
}

export async function getMnemonicRecord(): Promise<MnemonicRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "mnemonic") as Promise<
    MnemonicRecord | undefined
  >;
}

export async function putIdentityRecord(
  record: MnemonicRecord | KeypairRecord,
): Promise<void> {
  const database = await getDB();
  await database.put("identity", record);
}

export async function getRoom(
  roomCode: string,
): Promise<Room | DMRoom | undefined> {
  const database = await getDB();
  return database.get("rooms", roomCode);
}

export async function getAllRooms(): Promise<(Room | DMRoom)[]> {
  const database = await getDB();
  return database.getAll("rooms");
}

export async function getDMRooms(): Promise<DMRoom[]> {
  const database = await getDB();
  return database.getAllFromIndex("rooms", "byType", "dm") as Promise<DMRoom[]>;
}

export async function putRoom(room: Room | DMRoom): Promise<void> {
  const database = await getDB();
  await database.put("rooms", room);
}

/**
 * Patch a room's mutable fields.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updateRoom(
  roomCode: string,
  patch: Partial<Pick<Room, "name" | "pfpData" | "pfpURL">>,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  const updated = { ...room, ...patch };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  await tx.store.put(updated);
  await tx.done;
}

/**
 * Mark all messages up to the given lamport as seen.
 * Used to derive unread count in the sidebar.
 */
export async function markRoomSeen(
  roomCode: string,
  lamport: number,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  await tx.store.put({ ...room, lastSeenLamport: lamport });
  await tx.done;
}

export async function deleteRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  await database.delete("rooms", roomCode);
}

export async function getOwnProfile(): Promise<OwnProfile | undefined> {
  const database = await getDB();
  return database.get("profiles", "own") as Promise<OwnProfile | undefined>;
}

export async function putOwnProfile(profile: OwnProfile): Promise<void> {
  const database = await getDB();
  await database.put("profiles", { ...profile, id: "own" });
}

/**
 * Patch own profile.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updateOwnProfile(
  patch: Partial<Pick<OwnProfile, "nickname" | "pfpData" | "pfpURL">>,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("profiles", "readwrite");
  const profile = (await tx.store.get("own")) as OwnProfile | undefined;
  if (!profile) return;
  const updated = { ...profile, ...patch, updatedAt: Date.now() };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  await tx.store.put(updated);
  await tx.done;
}

export async function getPeerProfile(
  did: string,
): Promise<PeerProfile | undefined> {
  const database = await getDB();
  return database.get("profiles", did) as Promise<PeerProfile | undefined>;
}

export async function putPeerProfile(profile: PeerProfile): Promise<void> {
  const database = await getDB();
  await database.put("profiles", profile);
}

/**
 * Patch a cached peer profile.
 * Called when a peer broadcasts a profile update over the data channel.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updatePeerProfile(
  did: string,
  patch: Partial<Pick<PeerProfile, "nickname" | "pfpData" | "pfpURL">>,
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("profiles", "readwrite");
  const profile = (await tx.store.get(did)) as PeerProfile | undefined;
  if (!profile) return;
  const updated = { ...profile, ...patch, updatedAt: Date.now() };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  await tx.store.put(updated);
  await tx.done;
}

/**
 * Generate a runtime blobURL from pfpData.
 * Use when pfpData is set and you need an <img src>.
 * Caller must call URL.revokeObjectURL() when done.
 */
export function pfpBlobURL(
  pfpData: ArrayBuffer,
  mimeType = "image/jpeg",
): string {
  return URL.createObjectURL(new Blob([pfpData], { type: mimeType }));
}

function watermarkId(roomCode: string, senderId: string): string {
  return `${roomCode}:${senderId}`;
}

export async function getWatermark(
  roomCode: string,
  senderId: string,
): Promise<number> {
  const database = await getDB();
  const record = await database.get(
    "watermarks",
    watermarkId(roomCode, senderId),
  );
  return record?.maxLamport ?? 0;
}

export async function setWatermark(
  roomCode: string,
  senderId: string,
  maxLamport: number,
): Promise<void> {
  const database = await getDB();
  await database.put("watermarks", {
    id: watermarkId(roomCode, senderId),
    roomCode,
    senderId,
    maxLamport,
  });
}

export async function getWatermarksForRoom(
  roomCode: string,
): Promise<Record<string, number>> {
  const database = await getDB();
  const records = await database.getAllFromIndex(
    "watermarks",
    "byRoom",
    roomCode,
  );
  return Object.fromEntries(records.map((r) => [r.senderId, r.maxLamport]));
}

/**
 * Load a persisted Yjs snapshot into a doc.
 * Call before connecting peers to avoid redundant re-sync.
 */
export async function loadYjsDoc(id: string, doc: Y.Doc): Promise<void> {
  const database = await getDB();
  const record = await database.get("yjsDocs", id);
  if (record) Y.applyUpdate(doc, record.update);
}

/**
 * Persist the current Yjs doc state as a full snapshot.
 * Call in doc.on("update", ...) to keep IndexedDB in sync.
 */
export async function saveYjsDoc(id: string, doc: Y.Doc): Promise<void> {
  const database = await getDB();
  const update = Y.encodeStateAsUpdate(doc);
  await database.put("yjsDocs", { id, update });
}
