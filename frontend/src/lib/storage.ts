import { deleteDB, openDB, type IDBPDatabase } from "idb";
import * as Y from "yjs";

import type {
  Attachment,
  AttachmentStatus,
  Message,
  MessageStatus,
  PendingMessage,
} from "./types/message";
import type { KeypairRecord, MnemonicRecord, WebAuthnRecord } from "./identity";

export type RoomType = "text" | "voice" | "dm";

export interface Room {
  roomCode: string;
  type: RoomType;
  name: string;
  lastSeenLamport: number; // unread count = messages with lamport > this
  createdAt: number;
  pfpData?: ArrayBuffer; // local upload — blobURL generated at runtime, never stored
  pfpURL?: string; // external URL (tenor, giphy, etc) — stored as-is
  participants: string[]; // DIDs of users in the room (stable identity)
  participantLastSeen?: Record<string, number>; // DID -> timestamp of last seen
}

const PARTICIPANT_INACTIVE_DAYS = 7;
const PARTICIPANT_INACTIVE_MS = PARTICIPANT_INACTIVE_DAYS * 24 * 60 * 60 * 1000;

export interface DMRoom extends Room {
  type: "dm";
  participantDid: string;
}

export interface OwnProfile {
  did: string; // PK — the local identity DID
  isMe: true;
  nickname: string;
  pfpData?: ArrayBuffer; // local upload
  pfpURL?: string; // external URL — stored as-is
  updatedAt: number;
}

export interface PeerProfile {
  did: string; // PK
  isMe: false;
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

export interface SavedGif {
  id: string;
  gifId: string;
  title: string;
  url: string;
  previewUrl: string;
  savedAt: number;
}

export interface PhonebookEntry {
  peerId: string;
  nickname: string;
  addedAt: number;
  favorite?: boolean;
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
    value: MnemonicRecord | KeypairRecord | WebAuthnRecord;
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
  savedGifs: {
    key: string;
    value: SavedGif;
  };
  phonebook: {
    key: string;
    value: PhonebookEntry;
  };
}>;

let db: AppDB | null = null;

export async function getDB(): Promise<AppDB> {
  if (db) return db;

  db = (await openDB("awful-chat", 4, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
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
        const penStore = database.createObjectStore("pending", {
          keyPath: "id",
        });
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

        // profiles — keyed by did for both own and peer profiles
        database.createObjectStore("profiles", { keyPath: "did" });
      }

      if (oldVersion < 2) {
        database.createObjectStore("savedGifs", { keyPath: "id" });
      }

      if (oldVersion < 3) {
        // Recreate profiles store with keyPath "did" instead of "id".
        // Existing peer profile data is dropped (it was broken anyway — see fix).
        // Own profile is preserved below via a cursor copy.
        if (database.objectStoreNames.contains("profiles")) {
          database.deleteObjectStore("profiles");
        }
        database.createObjectStore("profiles", { keyPath: "did" });
      }

      if (oldVersion < 4) {
        database.createObjectStore("phonebook", { keyPath: "peerId" });
      }
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
  beforeLamport?: number
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
    beforeLamport !== undefined
  );

  const results: Message[] = [];
  let cursor = await index.openCursor(range, "prev");

  while (cursor && results.length < PAGE_SIZE) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }

  return results.reverse();
}

/**
 * Fetch every message for a room with no page limit.
 * Only used for sync — do not use for display.
 */
export async function getAllMessages(roomCode: string): Promise<Message[]> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  const results = await index.getAll(range);
  return results;
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

export async function deleteMessagesForRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  const tx = database.transaction(["messages", "attachments"], "readwrite");
  const messagesIndex = tx.objectStore("messages").index("byRoom");
  const messages = await messagesIndex.getAll(roomCode);

  for (const message of messages) {
    const attachmentsIndex = tx.objectStore("attachments").index("byMessage");
    const attachments = await attachmentsIndex.getAll(message.id);
    for (const attachment of attachments) {
      await tx.objectStore("attachments").delete(attachment.id);
    }
    await tx.objectStore("messages").delete(message.id);
  }

  await tx.done;
}

export async function getUnreadCount(
  roomCode: string,
  lastSeenLamport: number,
  excludeSenderId?: string
): Promise<number> {
  const database = await getDB();
  const tx = database.transaction("messages");
  const index = tx.store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, lastSeenLamport + 1],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );

  if (!excludeSenderId) {
    return index.count(range);
  }

  const messages = await index.getAll(range);
  return messages.filter((m) => m.senderId !== excludeSenderId).length;
}

export async function updateMessageStatus(
  id: string,
  status: MessageStatus
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("messages", "readwrite");
  const message = await tx.store.get(id);
  if (!message) return;
  await tx.store.put({ ...message, status });
  await tx.done;
}

export async function getAttachment(
  id: string
): Promise<Attachment | undefined> {
  const database = await getDB();
  return database.get("attachments", id);
}

export async function getAttachmentsByMessage(
  messageId: string
): Promise<Attachment[]> {
  const database = await getDB();
  return database.getAllFromIndex("attachments", "byMessage", messageId);
}

export async function getAttachmentsByInfoHash(
  infoHash: string
): Promise<Attachment[]> {
  const database = await getDB();
  return database.getAllFromIndex("attachments", "byInfoHash", infoHash);
}

export async function getSeedableAttachments(): Promise<Attachment[]> {
  const database = await getDB();
  const complete = await database.getAllFromIndex(
    "attachments",
    "byStatus",
    "complete"
  );
  return complete.filter((a) => !!a.data);
}

export async function getAttachmentsWithData(
  roomCode: string
): Promise<Attachment[]> {
  const database = await getDB();
  const all = await database.getAllFromIndex(
    "attachments",
    "byStatus",
    "complete"
  );
  const maybeSeeding = await database.getAllFromIndex(
    "attachments",
    "byStatus",
    "seeding"
  );
  return [...all, ...maybeSeeding].filter(
    (attachment) => attachment.roomCode === roomCode && !!attachment.data
  );
}

export async function putAttachment(attachment: Attachment): Promise<void> {
  const database = await getDB();
  const { blobURL: _, ...record } = attachment;
  await database.put("attachments", record);
}

export async function updateAttachmentStatus(
  id: string,
  status: AttachmentStatus
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("attachments", "readwrite");
  const attachment = await tx.store.get(id);
  if (!attachment) return;
  await tx.store.put({ ...attachment, status });
  await tx.done;
}

export async function getPendingByRecipient(
  recipientDid: string
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
  record: MnemonicRecord | KeypairRecord | WebAuthnRecord
): Promise<void> {
  const database = await getDB();
  await database.put("identity", record);
}

export async function getRoom(
  roomCode: string
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
  const roomWithParticipants = {
    ...room,
    participants: room.participants ?? [],
  };
  await database.put("rooms", roomWithParticipants);
}

export async function getRoomParticipants(roomCode: string): Promise<string[]> {
  const database = await getDB();
  const room = await database.get("rooms", roomCode);
  return room?.participants ?? [];
}

export async function addRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  const participants = new Set(room.participants ?? []);
  participants.add(peerId);
  const participantLastSeen = room.participantLastSeen ?? {};
  participantLastSeen[peerId] = Date.now();
  await tx.store.put({
    ...room,
    participants: [...participants],
    participantLastSeen,
  });
  await tx.done;
}

export async function updateParticipantLastSeen(
  roomCode: string,
  peerId: string
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  const participantLastSeen = room.participantLastSeen ?? {};
  participantLastSeen[peerId] = Date.now();
  await tx.store.put({ ...room, participantLastSeen });
  await tx.done;
}

export async function removeRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  const participants = new Set(room.participants ?? []);
  participants.delete(peerId);
  const participantLastSeen = room.participantLastSeen ?? {};
  delete participantLastSeen[peerId];
  await tx.store.put({
    ...room,
    participants: [...participants],
    participantLastSeen,
  });
  await tx.done;
}

export async function cleanupInactiveParticipants(
  roomCode: string
): Promise<string[]> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return [];
  const cutoff = Date.now() - PARTICIPANT_INACTIVE_MS;
  const participantLastSeen = room.participantLastSeen ?? {};
  const removed: string[] = [];
  const participants = new Set(room.participants ?? []);
  for (const peerId of participants) {
    const lastSeen = participantLastSeen[peerId] ?? 0;
    if (lastSeen < cutoff) {
      participants.delete(peerId);
      delete participantLastSeen[peerId];
      removed.push(peerId);
    }
  }
  await tx.store.put({
    ...room,
    participants: [...participants],
    participantLastSeen,
  });
  await tx.done;
  return removed;
}

/**
 * Patch a room's mutable fields.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updateRoom(
  roomCode: string,
  patch: Partial<Pick<Room, "name" | "pfpData" | "pfpURL">>
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
  lamport: number
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
  const all = await database.getAll("profiles");
  return all.find((p): p is OwnProfile => p.isMe === true);
}

export async function putOwnProfile(profile: OwnProfile): Promise<void> {
  const database = await getDB();
  await database.put("profiles", { ...profile, isMe: true as const });
}

/**
 * Patch own profile.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updateOwnProfile(
  patch: Partial<Pick<OwnProfile, "nickname" | "pfpData" | "pfpURL">>
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("profiles", "readwrite");
  const all = await tx.store.getAll();
  const profile = all.find((p): p is OwnProfile => p.isMe === true);
  if (!profile) return;
  const updated: OwnProfile = { ...profile, ...patch, updatedAt: Date.now() };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  await tx.store.put(updated);
  await tx.done;
}

export async function getPeerProfile(
  did: string
): Promise<PeerProfile | undefined> {
  const database = await getDB();
  const record = await database.get("profiles", did);
  if (!record || record.isMe) return undefined;
  return record as PeerProfile;
}

export async function putPeerProfile(profile: PeerProfile): Promise<void> {
  const database = await getDB();
  await database.put("profiles", { ...profile, isMe: false as const });
}

export async function getAllPeerProfiles(): Promise<PeerProfile[]> {
  const database = await getDB();
  const all = await database.getAll("profiles");
  return all.filter((p): p is PeerProfile => p.isMe === false);
}

/**
 * Patch a cached peer profile.
 * Called when a peer broadcasts a profile update over the data channel.
 * pfpData and pfpURL are mutually exclusive — setting one clears the other.
 */
export async function updatePeerProfile(
  did: string,
  patch: Partial<Pick<PeerProfile, "nickname" | "pfpData" | "pfpURL">>
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("profiles", "readwrite");
  const record = await tx.store.get(did);
  if (!record || record.isMe) return;
  const profile = record as PeerProfile;
  const updated: PeerProfile = { ...profile, ...patch, updatedAt: Date.now() };
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
  mimeType = "image/jpeg"
): string {
  return URL.createObjectURL(new Blob([pfpData], { type: mimeType }));
}

function watermarkId(roomCode: string, senderId: string): string {
  return `${roomCode}:${senderId}`;
}

export async function getWatermark(
  roomCode: string,
  senderId: string
): Promise<number> {
  const database = await getDB();
  const record = await database.get(
    "watermarks",
    watermarkId(roomCode, senderId)
  );
  return record?.maxLamport ?? 0;
}

export async function setWatermark(
  roomCode: string,
  senderId: string,
  maxLamport: number
): Promise<void> {
  const database = await getDB();
  const id = watermarkId(roomCode, senderId);
  const existing = await database.get("watermarks", id);
  // Never regress — only advance the watermark
  if (existing && existing.maxLamport >= maxLamport) return;
  await database.put("watermarks", {
    id,
    roomCode,
    senderId,
    maxLamport,
  });
}

export async function getWatermarksForRoom(
  roomCode: string
): Promise<Record<string, number>> {
  const database = await getDB();
  const records = await database.getAllFromIndex(
    "watermarks",
    "byRoom",
    roomCode
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

export async function getAllSavedGifs(): Promise<SavedGif[]> {
  const database = await getDB();
  return database.getAll("savedGifs");
}

export async function putSavedGif(gif: SavedGif): Promise<void> {
  const database = await getDB();
  await database.put("savedGifs", gif);
}

export async function deleteSavedGif(id: string): Promise<void> {
  const database = await getDB();
  await database.delete("savedGifs", id);
}

export async function isGifSaved(gifId: string): Promise<SavedGif | undefined> {
  const database = await getDB();
  const all = await database.getAll("savedGifs");
  return all.find((g) => g.gifId === gifId);
}

export async function getWebAuthnRecord(): Promise<WebAuthnRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "webauthn") as Promise<
    WebAuthnRecord | undefined
  >;
}

export async function getPhonebookEntries(): Promise<PhonebookEntry[]> {
  const database = await getDB();
  const entries = await database.getAll("phonebook");
  return entries.sort((a, b) => {
    const favDiff = Number(!!b.favorite) - Number(!!a.favorite);
    if (favDiff !== 0) return favDiff;
    return a.addedAt - b.addedAt;
  });
}

export async function getPhonebookEntry(
  peerId: string
): Promise<PhonebookEntry | undefined> {
  const database = await getDB();
  return database.get("phonebook", peerId);
}

export async function putPhonebookEntry(entry: PhonebookEntry): Promise<void> {
  const database = await getDB();
  await database.put("phonebook", entry);
}

export async function deletePhonebookEntry(peerId: string): Promise<void> {
  const database = await getDB();
  await database.delete("phonebook", peerId);
}

export async function putWebAuthnRecord(record: WebAuthnRecord): Promise<void> {
  const database = await getDB();
  await database.put("identity", record);
}

export async function deleteWebAuthnRecord(): Promise<void> {
  const database = await getDB();
  await database.delete("identity", "webauthn");
}

export async function wipeLocalDatabase(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  await deleteDB("awful-chat");
}

export interface StorageMetrics {
  totalMessages: number;
  totalRooms: number;
  totalProfiles: number;
  seedingAttachments: number;
  totalAttachments: number;
  storedDataSize: number;
  rooms: { name: string; messageCount: number }[];
}

export async function getStorageMetrics(): Promise<StorageMetrics> {
  const database = await getDB();

  const messages = await database.getAll("messages");
  const rooms = await database.getAll("rooms");
  const profiles = await database.getAll("profiles");
  const attachments = await database.getAll("attachments");

  const seedingCount = attachments.filter((a) => a.status === "seeding").length;

  let storedSize = 0;
  attachments.forEach((a) => {
    if (a.data) storedSize += a.data.byteLength;
  });

  const roomMetrics = rooms
    .slice(0, 5)
    .map((room) => {
      const roomMessages = messages.filter(
        (m) => m.roomCode === (room as Room | DMRoom).roomCode
      ).length;
      return {
        name: (room as Room | DMRoom).name || (room as Room | DMRoom).roomCode,
        messageCount: roomMessages,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);

  return {
    totalMessages: messages.length,
    totalRooms: rooms.length,
    totalProfiles: profiles.length,
    seedingAttachments: seedingCount,
    totalAttachments: attachments.length,
    storedDataSize: storedSize,
    rooms: roomMetrics,
  };
}
