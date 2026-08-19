import { deleteDB, openDB, type IDBPDatabase } from "idb";

import type {
  Attachment,
  AttachmentStatus,
  Message,
  MessageStatus,
  PendingMessage,
} from "./types/message";
import { MessageType } from "./types/message";
import type {
  KeypairRecord,
  MnemonicRecord,
  WebAuthnRecord,
} from "./identity/identity";

export type RoomType = "text" | "dm";

export interface Room {
  roomCode: string;
  type: RoomType;
  name: string;
  lastSeenLamport: number; // unread count = messages with lamport > this
  createdAt: number;
  pfpData?: ArrayBuffer; // local upload - blobURL generated at runtime, never stored
  pfpURL?: string; // external URL (tenor, giphy, etc) - stored as-is
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
  did: string; // PK - the local identity DID
  isMe: true;
  nickname: string;
  pfpData?: ArrayBuffer; // local upload
  pfpURL?: string; // external URL - stored as-is
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color?: string;
  updatedAt: number;
}

export interface PeerProfile {
  did: string; // PK
  isMe: false;
  nickname: string;
  pfpData?: ArrayBuffer;
  pfpURL?: string;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color?: string;
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
  did?: string;
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
    async upgrade(database, oldVersion, _newVersion, transaction) {
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

        // identity - keyed by "mnemonic" | "keypair"
        database.createObjectStore("identity", { keyPath: "id" });

        // watermarks - keyed by "roomCode:senderId"
        const wmStore = database.createObjectStore("watermarks", {
          keyPath: "id",
        });
        wmStore.createIndex("byRoom", "roomCode", { unique: false });

        // Yjs snapshots - keyed by "channel:{roomCode}"
        database.createObjectStore("yjsDocs", { keyPath: "id" });

        // rooms - keyed by roomCode
        const roomStore = database.createObjectStore("rooms", {
          keyPath: "roomCode",
        });
        roomStore.createIndex("byType", "type", { unique: false });

        // profiles - keyed by did for both own and peer profiles
        database.createObjectStore("profiles", { keyPath: "did" });
      }

      if (oldVersion < 2) {
        database.createObjectStore("savedGifs", { keyPath: "id" });
      }

      if (oldVersion < 3) {
        // Recreate profiles store with keyPath "did" instead of "id".
        // Peer profile data is dropped (it was broken anyway), but the user's
        // OWN profile (nickname + avatar) must survive - copy it across the
        // recreate instead of silently wiping it.
        let ownProfiles: unknown[] = [];
        if (database.objectStoreNames.contains("profiles")) {
          const all = (await transaction
            .objectStore("profiles")
            .getAll()) as unknown[];
          ownProfiles = all.filter((p) => {
            const rec = p as { isMe?: unknown; did?: unknown };
            return !!p && rec.isMe === true && typeof rec.did === "string";
          });
          database.deleteObjectStore("profiles");
        }
        const store = database.createObjectStore("profiles", {
          keyPath: "did",
        });
        for (const p of ownProfiles) store.put(p as OwnProfile);
      }

      if (oldVersion < 4) {
        database.createObjectStore("phonebook", { keyPath: "peerId" });
      }
    },
  })) as AppDB;

  return db;
}

export const PAGE_SIZE = 50;

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
 * Just the newest message of a room - for inbox previews, where loading a
 * whole page per room adds up.
 */
export async function getLastMessage(
  roomCode: string
): Promise<Message | undefined> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  const cursor = await index.openCursor(range, "prev");
  return cursor?.value;
}

/**
 * Next lamport for a DM room: wall-clock ms with a monotonic floor. A peer
 * whose clock runs behind must still land AFTER everything already in the
 * room, or their messages fall below the seen watermark and never show as
 * unread. Allocations are serialized per room so two quick sends cannot
 * take the same value.
 */
const _dmLamportChain = new Map<string, Promise<number>>();

export function nextDmLamport(roomCode: string, ts: number): Promise<number> {
  const prev = _dmLamportChain.get(roomCode) ?? Promise.resolve(0);
  const next = prev.then(async (lastIssued) => {
    const stored = (await getLastMessage(roomCode))?.lamport ?? 0;
    const floor = Math.max(stored, lastIssued);
    return ts > floor ? ts : floor + 1;
  });
  _dmLamportChain.set(
    roomCode,
    next.catch(() => 0)
  );
  return next;
}

/**
 * Newest message in a room from anyone but the given sender - lets read
 * acks name the peer's latest message even when the loaded page holds
 * only our own.
 */
export async function getLastMessageFrom(
  roomCode: string,
  notSenderId: string
): Promise<Message | undefined> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  let cursor = await index.openCursor(range, "prev");
  while (cursor) {
    if (cursor.value.senderId !== notSenderId) return cursor.value;
    cursor = await cursor.continue();
  }
  return undefined;
}

/**
 * Fetch every message for a room with no page limit.
 * Only used for sync - do not use for display.
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
  const tx = database.transaction(
    ["messages", "attachments", "watermarks"],
    "readwrite"
  );
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

  // Sync watermarks go with the history: left behind, a later re-join of the
  // same code would tell peers we already hold messages we just deleted, and
  // they would never be offered again.
  const wmIndex = tx.objectStore("watermarks").index("byRoom");
  for (const wm of await wmIndex.getAll(roomCode)) {
    await tx
      .objectStore("watermarks")
      .delete(watermarkId(wm.roomCode, wm.senderId));
  }

  await tx.done;
  // The Yjs snapshot lives in its own store; a leftover one would resurrect
  // the shared doc if the same room code is ever joined again.
  await database.delete("yjsDocs", `channel:${roomCode}`).catch(() => {});
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

  // Reactions are not "new messages": a heart on an old message must not
  // light the unread badge with nothing visible to read. The range holds
  // only unseen messages, so materializing it stays cheap.
  const messages = await index.getAll(range);
  return messages.filter(
    (m) =>
      m.type !== MessageType.Reaction &&
      (!excludeSenderId || m.senderId !== excludeSenderId)
  ).length;
}

const MESSAGE_STATUS_RANK: Record<MessageStatus, number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * A read receipt for one message implies everything the same sender wrote
 * earlier in that room was read too. Acks only name the page the reader had
 * loaded, so cascade the status down the backlog. Returns the ids that
 * actually changed so callers can update in-memory copies.
 */
export async function markOwnMessagesReadUpTo(
  roomCode: string,
  senderId: string,
  lamport: number
): Promise<string[]> {
  const database = await getDB();
  const tx = database.transaction("messages", "readwrite");
  const index = tx.store.index("byRoomLamport");
  const range = IDBKeyRange.bound([roomCode, 0], [roomCode, lamport]);
  const updated: string[] = [];
  let cursor = await index.openCursor(range);
  while (cursor) {
    const m = cursor.value;
    if (
      m.senderId === senderId &&
      (!m.status || MESSAGE_STATUS_RANK[m.status] < MESSAGE_STATUS_RANK.read)
    ) {
      await cursor.update({ ...m, status: "read" });
      updated.push(m.id);
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return updated;
}

/** Advance a message's delivery status. Never regresses (read stays read). */
export async function updateMessageStatus(
  id: string,
  status: MessageStatus
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("messages", "readwrite");
  const message = await tx.store.get(id);
  if (!message) return;
  if (
    message.status &&
    MESSAGE_STATUS_RANK[message.status] >= MESSAGE_STATUS_RANK[status]
  ) {
    return;
  }
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

const ATTACHMENT_STATUS_RANK: Record<AttachmentStatus, number> = {
  pending: 0,
  downloading: 1,
  failed: 2,
  complete: 3,
  seeding: 4,
};

/** Advance an attachment's status. Late progress events must not regress it. */
export async function updateAttachmentStatus(
  id: string,
  status: AttachmentStatus
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("attachments", "readwrite");
  const attachment = await tx.store.get(id);
  if (!attachment) return;
  if (
    ATTACHMENT_STATUS_RANK[attachment.status] >= ATTACHMENT_STATUS_RANK[status]
  ) {
    return;
  }
  await tx.store.put({ ...attachment, status });
  await tx.done;
}

/**
 * Patch only the downloaded bytes onto an attachment, in one transaction.
 * A whole-record put built before the (long) blob read clobbered whatever
 * status the seeding path wrote in the meantime.
 */
export async function updateAttachmentData(
  id: string,
  data: ArrayBuffer
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("attachments", "readwrite");
  const attachment = await tx.store.get(id);
  if (!attachment) return;
  const status =
    ATTACHMENT_STATUS_RANK[attachment.status] >=
    ATTACHMENT_STATUS_RANK.complete
      ? attachment.status
      : ("complete" as AttachmentStatus);
  await tx.store.put({ ...attachment, data, status });
  await tx.done;
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
  // participants are documented as DIDs; a raw peerId written here is never
  // matched by a leave (keyed by DID) and ghosts the member list for 7 days.
  if (!peerId.startsWith("did:")) return;
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
 * Mark all messages up to the given lamport as seen.
 * Used to derive unread count in the sidebar.
 *
 * Monotonic: concurrent callers race while a conversation is open (the
 * incoming-message handler vs the open-conversation path working from an
 * older snapshot), and a late write with a lower lamport would resurrect
 * already-read messages as unread.
 */
export async function markRoomSeen(
  roomCode: string,
  lamport: number
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("rooms", "readwrite");
  const room = await tx.store.get(roomCode);
  if (!room) return;
  await tx.store.put({
    ...room,
    lastSeenLamport: Math.max(room.lastSeenLamport ?? 0, lamport),
  });
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
 * Move the own-profile row to a new key. Used to repair rows written before
 * the identity existed, which landed under an empty did.
 */
export async function rekeyOwnProfile(
  from: string,
  to: string
): Promise<void> {
  if (from === to) return;
  const database = await getDB();
  const tx = database.transaction("profiles", "readwrite");
  const existing = await tx.store.get(from);
  if (existing) {
    await tx.store.put({ ...existing, did: to, isMe: true as const });
    await tx.store.delete(from);
  }
  await tx.done;
}

/**
 * Patch own profile.
 * pfpData and pfpURL are mutually exclusive - setting one clears the other.
 */
export async function updateOwnProfile(
  patch: Partial<Pick<OwnProfile, "nickname" | "pfpData" | "pfpURL" | "color">>
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
  // Read+write in ONE transaction so concurrent fire-and-forget callers can't
  // interleave and regress the watermark (a late lower value clobbering a
  // higher one written between our get and put).
  const tx = database.transaction("watermarks", "readwrite");
  const existing = await tx.store.get(id);
  // Never regress - only advance the watermark
  if (!existing || existing.maxLamport < maxLamport) {
    await tx.store.put({ id, roomCode, senderId, maxLamport });
  }
  await tx.done;
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

/**
 * Merge duplicate phonebook rows referring to one human. The store is keyed
 * by whichever identity form was known at add time, so the same contact can
 * exist once keyed by DID (added offline) and once by peerId (added online).
 * Entries with no DID at all are left alone - a peerId cannot be turned into
 * an identity DID after the fact.
 */
export async function dedupePhonebook(): Promise<void> {
  const database = await getDB();
  const entries = await database.getAll("phonebook");
  const byDid = new Map<string, PhonebookEntry[]>();
  for (const e of entries) {
    const did =
      e.did ?? (e.peerId.startsWith("did:") ? e.peerId : undefined);
    if (!did) continue;
    const group = byDid.get(did) ?? [];
    group.push(e);
    byDid.set(did, group);
  }
  for (const [did, group] of byDid) {
    if (group.length < 2) continue;
    // Prefer the row with a real transport peerId; the union keeps the
    // earliest addedAt (sort order) and any favorite flag.
    const keeper =
      group.find((e) => !e.peerId.startsWith("did:")) ?? group[0];
    const merged: PhonebookEntry = {
      ...keeper,
      did,
      nickname: group.find((e) => e.nickname)?.nickname ?? keeper.nickname,
      addedAt: Math.min(...group.map((e) => e.addedAt)),
      favorite: group.some((e) => e.favorite) || undefined,
    };
    for (const e of group) await database.delete("phonebook", e.peerId);
    await database.put("phonebook", merged);
  }
}

export async function putPhonebookEntry(entry: PhonebookEntry): Promise<void> {
  const database = await getDB();
  await database.put("phonebook", entry);
}

export async function deletePhonebookEntry(peerId: string): Promise<void> {
  const database = await getDB();
  await database.delete("phonebook", peerId);
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

/**
 * Ask the browser to keep this origin's data out of automatic eviction.
 *
 * This app has no server copy: everything you own lives in IndexedDB here, so
 * eviction under storage pressure means losing your identity and history. Safe
 * to call repeatedly. Chrome grants it silently based on engagement/install,
 * Firefox may prompt, and unsupported browsers just report false.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

export interface StorageMetrics {
  /** True when the browser promised not to evict this origin's data. */
  persisted: boolean;
  /** Bytes the browser is willing to give this origin, when it reports one. */
  quota: number | null;
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

  const rooms = await database.getAll("rooms");
  const profiles = await database.getAll("profiles");
  const attachments = await database.getAll("attachments");

  const seedingCount = attachments.filter((a) => a.status === "seeding").length;

  let storedSize = 0;
  attachments.forEach((a) => {
    if (a.data) storedSize += a.data.byteLength;
  });

  const totalMessages = await database.count("messages");
  const roomCounts = new Map<string, number>();
  for (const room of rooms) {
    const count = await database.countFromIndex(
      "messages",
      "byRoomLamport",
      IDBKeyRange.bound(
        [room.roomCode, 0],
        [room.roomCode, Number.MAX_SAFE_INTEGER]
      )
    );
    roomCounts.set(room.roomCode, count);
  }

  const roomMetrics = Array.from(roomCounts.entries())
    .map(([roomCode, messageCount]) => {
      const room = rooms.find((r) => r.roomCode === roomCode);
      return {
        name: room?.name || roomCode,
        messageCount,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5);

  let quota: number | null = null;
  try {
    quota = (await navigator.storage?.estimate?.())?.quota ?? null;
  } catch {
    quota = null;
  }

  return {
    persisted: await isStoragePersisted(),
    quota,
    totalMessages,
    totalRooms: rooms.length,
    totalProfiles: profiles.length,
    seedingAttachments: seedingCount,
    totalAttachments: attachments.length,
    storedDataSize: storedSize,
    rooms: roomMetrics,
  };
}
