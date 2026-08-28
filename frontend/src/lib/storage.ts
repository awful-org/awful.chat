import { deleteDB, openDB, type IDBPDatabase } from "idb";

import {
  sealRow,
  openRow,
  openRows,
  isSealed,
  isStorageLockedError,
  isBlinded,
  rowHasBytes,
  storageCryptoReady,
  blindValue,
  STORE_SPECS,
  type Blinded,
  type EncryptedStoreName,
  type StoreCryptoSpec,
} from "./storage-crypto";
import type {
  Attachment,
  AttachmentStatus,
  ChatMessageType,
  FileEntry,
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
  bannerData?: ArrayBuffer; // local upload
  bannerURL?: string; // external URL
  tagText?: string; // 2-5 chars
  tagTextColor?: string; // hex like "#aabbcc"
  tagChipColor?: string; // hex like "#aabbcc"
  bio?: string; // max 200 chars
  nameEffect?: string; // none | gradient | shimmer | glow | rainbow
  /** Extra gradient stops for the "gradient" name effect. */
  gradient2?: string;
  gradient3?: string;
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
  bannerData?: ArrayBuffer; // local upload
  bannerURL?: string; // external URL
  tagText?: string; // 2-5 chars
  tagTextColor?: string; // hex like "#aabbcc"
  tagChipColor?: string; // hex like "#aabbcc"
  bio?: string; // max 200 chars
  nameEffect?: string; // none | gradient | shimmer | glow | rainbow
  /** Extra gradient stops for the "gradient" name effect. */
  gradient2?: string;
  gradient3?: string;
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
  /** Uploaded (webtorrent) gifs have no CDN url; the bytes live here. */
  data?: ArrayBuffer;
  mimeType?: string;
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
      byRoom: Blinded;
      byRoomLamport: [Blinded, number];
      bySender: Blinded;
    };
  };
  attachments: {
    key: string;
    value: Attachment;
    indexes: {
      byMessage: Blinded;
      byInfoHash: Blinded;
      byStatus: string;
    };
  };
  pending: {
    key: string;
    value: PendingMessage;
    indexes: {
      byRecipient: Blinded;
    };
  };
  identity: {
    key: string;
    value: MnemonicRecord | KeypairRecord | WebAuthnRecord;
  };
  watermarks: {
    key: Blinded;
    value: WatermarkRecord;
    indexes: {
      byRoom: Blinded;
    };
  };
  yjsDocs: {
    key: Blinded;
    value: YjsDocRecord;
  };
  rooms: {
    key: Blinded;
    value: Room | DMRoom;
    indexes: {
      byType: string;
    };
  };
  profiles: {
    key: Blinded;
    value: OwnProfile | PeerProfile;
  };
  savedGifs: {
    key: string;
    value: SavedGif;
  };
  phonebook: {
    key: Blinded;
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

// ── at-rest encryption boundary ──────────────────────────────────────────────
// Rows go into IDB sealed (index fields clear, everything else AES-GCM) but
// keep their compile-time types; these two casts are the only place that lie
// lives. Crypto is async and an IDB transaction auto-commits the moment a
// non-IDB await runs inside it, so every read-modify-write below reads first,
// does its crypto OUTSIDE any transaction, then writes.

async function _seal<T extends object>(
  store: EncryptedStoreName,
  record: T
): Promise<T> {
  return (await sealRow(
    record as unknown as Record<string, unknown>,
    STORE_SPECS[store]
  )) as unknown as T;
}

async function _open<T>(
  store: EncryptedStoreName,
  row: T | undefined,
  opts?: { skipBytes?: boolean }
): Promise<T | undefined> {
  if (row === undefined) return undefined;
  try {
    return await openRow<T>(row, STORE_SPECS[store], opts);
  } catch (err) {
    if (isStorageLockedError(err)) throw err; // too-early read: stay loud
    // One undecryptable row (truncated blob, foreign key) degrades to one
    // missing row, never to a thrown query.
    console.warn(`[storage] dropped undecryptable ${store} row:`, err);
    return undefined;
  }
}

async function _openAll<T>(store: EncryptedStoreName, rows: T[]): Promise<T[]> {
  return openRows<T>(rows, STORE_SPECS[store]);
}

/**
 * Load a page of messages for a room, sorted by lamport ascending.
 * Pass beforeLamport for cursor-based pagination (scroll up to load older).
 */
export async function getMessages(
  roomCode: string,
  beforeLamport?: number
): Promise<Message[]> {
  const database = await getDB();

  // TWO cursors, walked together newest-first, not two getAll()s merged.
  // getAll over the range materializes the WHOLE room to return one page - on
  // a long-lived room that is tens of thousands of sealed rows built and
  // thrown away every time the chat opens, which is the memory spike this
  // file avoids everywhere else. A cursor per range keeps the early exit: we
  // stop as soon as the page is full, having read about PAGE_SIZE rows.
  //
  // The second cursor exists only for the migration window: until the sweep
  // finishes, a room's history is split between blinded and plaintext rows,
  // and reading just one of them silently drops half the conversation.
  const ranges: Array<[string, number][]> = [];
  const blindRoomCode = await blindValue(roomCode);
  const top = beforeLamport ?? Number.MAX_SAFE_INTEGER;
  ranges.push([
    [blindRoomCode, 0],
    [blindRoomCode, top],
  ]);
  if (!isMigrationComplete()) {
    ranges.push([
      [roomCode, 0],
      [roomCode, top],
    ]);
  }

  const exclusive = beforeLamport !== undefined;
  const tx = database.transaction("messages");
  const index = tx.store.index("byRoomLamport");
  const cursors = await Promise.all(
    ranges.map((r) =>
      index.openCursor(IDBKeyRange.bound(r[0], r[1], false, exclusive), "prev")
    )
  );

  const results: Message[] = [];
  const seen = new Set<string>();
  for (;;) {
    // Whichever cursor is sitting on the newer row goes next, so the merged
    // walk stays in lamport-descending order exactly as one cursor was.
    let pick = -1;
    for (let i = 0; i < cursors.length; i++) {
      const c = cursors[i];
      if (!c) continue;
      if (pick === -1 || c.value.lamport > cursors[pick]!.value.lamport) {
        pick = i;
      }
    }
    if (pick === -1) break;
    const cursor = cursors[pick]!;
    const row = cursor.value;
    // Plugin updates are stored as messages but never rendered (card state
    // replays them from storage directly). Letting them fill the page meant
    // one steam-roulette library link (~40 update rows per member) pushed
    // every real message out of the newest page.
    if (row.type !== MessageType.PluginUpdate && !seen.has(row.id)) {
      seen.add(row.id);
      results.push(row);
      if (results.length >= PAGE_SIZE) break;
    }
    cursors[pick] = await cursor.continue();
  }

  // Decrypt AFTER filtering - the filter reads only clear fields.
  return _openAll("messages", results.reverse());
}

/**
 * Just the newest message of a room - for inbox previews, where loading a
 * whole page per room adds up.
 */
export async function getLastMessage(
  roomCode: string
): Promise<Message | undefined> {
  const database = await getDB();
  const blindRoomCode = await blindValue(roomCode);
  const blindedRange = IDBKeyRange.bound(
    [blindRoomCode, 0],
    [blindRoomCode, Number.MAX_SAFE_INTEGER]
  );
  const newest = await database
    .transaction("messages")
    .store.index("byRoomLamport")
    .openCursor(blindedRange, "prev");

  // During migration, also check the plaintext range in case the newest
  // message has not been migrated yet
  if (!isMigrationComplete()) {
    const plaintextRange = IDBKeyRange.bound(
      [roomCode, 0],
      [roomCode, Number.MAX_SAFE_INTEGER]
    );
    const plaintextNewest = await database
      .transaction("messages")
      .store.index("byRoomLamport")
      .openCursor(plaintextRange, "prev");
    // Return whichever is newer
    if (plaintextNewest && (!newest || plaintextNewest.value.lamport > newest.value.lamport)) {
      return _open("messages", plaintextNewest.value);
    }
  }

  return _open("messages", newest?.value);
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
  const blindRoomCode = await blindValue(roomCode);
  const blindedNotSenderId = await blindValue(notSenderId);

  // Early exit on first match: walk cursors from newest-first, picking the
  // newer message from whichever cursor has one, and return immediately on
  // the first message not from the excluded sender. This avoids materializing
  // the entire range. During migration, use two cursors and walk together.
  const ranges = [
    IDBKeyRange.bound(
      [blindRoomCode, 0],
      [blindRoomCode, Number.MAX_SAFE_INTEGER]
    ),
  ];
  if (!isMigrationComplete()) {
    ranges.push(
      IDBKeyRange.bound(
        [roomCode, 0],
        [roomCode, Number.MAX_SAFE_INTEGER]
      )
    );
  }

  const tx = database.transaction("messages");
  const index = tx.store.index("byRoomLamport");
  const cursors = await Promise.all(
    ranges.map((r) => index.openCursor(r, "prev"))
  );

  for (;;) {
    // Pick the cursor sitting on the newer message
    let pick = -1;
    for (let i = 0; i < cursors.length; i++) {
      const c = cursors[i];
      if (!c) continue;
      if (pick === -1 || c.value.lamport > cursors[pick]!.value.lamport) {
        pick = i;
      }
    }
    if (pick === -1) break; // No more messages

    const cursor = cursors[pick]!;
    const msg = cursor.value;
    if (msg.senderId !== blindedNotSenderId) {
      // Found a message not from the excluded sender
      return _open("messages", msg);
    }
    cursors[pick] = await cursor.continue();
  }

  return undefined;
}

/**
 * Fetch every message for a room with no page limit.
 * Only used for sync - do not use for display.
 */
export async function getAllMessages(roomCode: string): Promise<Message[]> {
  const database = await getDB();
  const blindRoomCode = await blindValue(roomCode);
  const blindedRange = IDBKeyRange.bound(
    [blindRoomCode, 0],
    [blindRoomCode, Number.MAX_SAFE_INTEGER]
  );
  const results = await database
    .transaction("messages")
    .store.index("byRoomLamport")
    .getAll(blindedRange);

  // During migration, also query the plaintext range to see unmigrated rows
  if (!isMigrationComplete()) {
    const plaintextRange = IDBKeyRange.bound(
      [roomCode, 0],
      [roomCode, Number.MAX_SAFE_INTEGER]
    );
    const plaintextResults = await database
      .transaction("messages")
      .store.index("byRoomLamport")
      .getAll(plaintextRange);
    // Deduplicate by id
    const byId = new Map<string, Message>();
    for (const m of results) {
      byId.set(m.id, m);
    }
    for (const m of plaintextResults) {
      byId.set(m.id, m);
    }
    return _openAll("messages", Array.from(byId.values()));
  }

  return _openAll("messages", results);
}

/**
 * Only the room's PluginCard messages. type is a CLEAR field, so the cursor
 * walk filters without decrypting and only the few card rows pay for
 * crypto - callers used getAllMessages for this, which decrypts the entire
 * room history and froze the UI for seconds on every rescan.
 */
export async function getPluginCardMessages(
  roomCode: string
): Promise<Message[]> {
  return getMessagesOfTypes(roomCode, [MessageType.PluginCard]);
}

/**
 * Only the room's messages of the given clear types, decrypted. Same cursor
 * trick as getPluginCardMessages: rows that fail the clear-field filter
 * never pay for crypto.
 */
export async function getMessagesOfTypes(
  roomCode: string,
  types: ChatMessageType[]
): Promise<Message[]> {
  // One bulk read, then filter on clear fields, then decrypt survivors.
  // NOT a cursor: an await per row is an IDB round-trip per message, and
  // walking a big room that way (recurring, per digest) jammed the
  // database enough to delay live attachment writes and sends. Sealed
  // message rows are small; materializing them raw is the cheap part -
  // the decrypt is what must stay scoped.
  const rows = await _rawRoomMessages(roomCode);
  const wanted = new Set<ChatMessageType>(types);
  const opened = await _openAll(
    "messages",
    rows.filter((r) => wanted.has(r.type))
  );
  return opened.sort((a, b) => a.lamport - b.lamport);
}

/** Raw (still-sealed) message rows for a room - one bulk index read. */
async function _rawRoomMessages(roomCode: string): Promise<Message[]> {
  const database = await getDB();
  const blindRoomCode = await blindValue(roomCode);
  const blindedRange = IDBKeyRange.bound(
    [blindRoomCode, 0],
    [blindRoomCode, Number.MAX_SAFE_INTEGER]
  );
  const results = await database
    .transaction("messages")
    .store.index("byRoomLamport")
    .getAll(blindedRange);

  // During migration, also query the plaintext range to see unmigrated rows
  if (!isMigrationComplete()) {
    const plaintextRange = IDBKeyRange.bound(
      [roomCode, 0],
      [roomCode, Number.MAX_SAFE_INTEGER]
    );
    const plaintextResults = await database
      .transaction("messages")
      .store.index("byRoomLamport")
      .getAll(plaintextRange);
    // Deduplicate by id
    const byId = new Map<string, Message>();
    for (const m of results) {
      byId.set(m.id, m);
    }
    for (const m of plaintextResults) {
      byId.set(m.id, m);
    }
    return Array.from(byId.values());
  }

  return results;
}

/**
 * Per-sender maximum lamport for a room, from CLEAR fields alone - digest
 * reconciliation needs nothing else, and building this via getAllMessages
 * decrypted the entire room on every background digest exchange.
 *
 * Returns a map keyed by REAL DID (not blinded): watermarks are advertised
 * on the wire keyed by real identities. Rows are grouped by blinded senderId
 * (cheap), then exactly one row per group is decrypted to get the real DID.
 */
export async function getSenderMaxLamports(
  roomCode: string
): Promise<Map<string, number>> {
  const rows = await _rawRoomMessages(roomCode);
  // Group by blinded senderId and track the highest lamport per group.
  const highestByBlinded = new Map<string, { lamport: number; row: Message }>();
  for (const row of rows) {
    const { senderId, lamport } = row;
    const at = highestByBlinded.get(senderId);
    if (at === undefined || lamport > at.lamport) {
      highestByBlinded.set(senderId, { lamport, row });
    }
  }

  // Decrypt exactly one row per distinct blinded sender to get the real DID.
  const result = new Map<string, number>();
  for (const { lamport, row } of highestByBlinded.values()) {
    const decrypted = await _open<Message>("messages", row);
    if (decrypted?.senderId) {
      result.set(decrypted.senderId, lamport);
    }
  }
  return result;
}

/**
 * Messages above a peer's per-sender watermarks - the sync push. The
 * filter runs on CLEAR senderId/lamport, so only the rows actually being
 * pushed are decrypted (previously the whole room, twice per exchange).
 *
 * watermarks parameter is keyed by real DID (from the wire); stored senderId
 * fields are blinded, so we blind each key once up front for the comparison.
 */
export async function getMessagesAboveWatermarks(
  roomCode: string,
  watermarks: Record<string, number>
): Promise<Message[]> {
  const rows = await _rawRoomMessages(roomCode);
  // Build maps of watermarks for both blinded and plaintext forms to handle
  // the migration window. A legacy row has plaintext senderId and needs the
  // plaintext watermark value. Blinded rows need the blinded value. Checking
  // both ensures no messages are over-included by missing their watermark.
  const blindedWatermarks = new Map<string, number>();
  const plaintextWatermarks = new Map<string, number>();
  for (const [did, maxLamport] of Object.entries(watermarks)) {
    const blinded = await blindValue(did);
    blindedWatermarks.set(blinded, maxLamport);
    plaintextWatermarks.set(did, maxLamport);
  }
  return _openAll(
    "messages",
    rows.filter((r) => {
      const blinded = blindedWatermarks.get(r.senderId);
      const plaintext = plaintextWatermarks.get(r.senderId);
      const maxLamport = blinded !== undefined ? blinded : plaintext ?? -1;
      return r.lamport > maxLamport;
    })
  );
}

export async function getMessage(id: string): Promise<Message | undefined> {
  const database = await getDB();
  return _open("messages", await database.get("messages", id));
}

/**
 * Clear fields of a stored message - readable without decrypting it.
 *
 * WARNING: roomCode and senderId are BLINDED values. Callers that compare
 * them against wire-supplied values must blind the wire values first.
 */
export interface MessageClearFields {
  roomCode: string; // blinded
  senderId: string; // blinded
  lamport: number;
}

/**
 * Clear fields for the message ids we hold, in ONE transaction and with no
 * decryption at all: roomCode, senderId and lamport all live outside the
 * sealed blob (see STORE_SPECS). Every caller is a hot path that only needs
 * these - the sync relocation check, and the DM receipt paths, which used to
 * call getMessage per id and so paid a transaction plus a full AES-GCM
 * decrypt and JSON.parse of the whole row to read one string.
 *
 * Returns blinded roomCode and senderId values (see MessageClearFields).
 */
export async function messageClearFieldsByIds(
  ids: string[]
): Promise<Map<string, MessageClearFields>> {
  // Ids arrive straight off the wire on the sync path. IDBObjectStore.get()
  // throws DataError synchronously for undefined or null, which would reject
  // the Promise.all below and abandon the whole batch, so filter first.
  const wanted = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (!wanted.length) return new Map();
  const database = await getDB();
  const out = new Map<string, MessageClearFields>();
  // ONE transaction for the whole batch. A get() per id opens a transaction
  // each, and cursor-per-row awaits jamming IDB is precisely the regression
  // this file's other queries were rewritten to avoid - and these run on the
  // sync and receipt paths, which were profiled as a CPU problem once already.
  const tx = database.transaction("messages", "readonly");
  await Promise.all([
    ...wanted.map(async (id) => {
      const row = (await tx.store.get(id)) as
        | { roomCode?: unknown; senderId?: unknown; lamport?: unknown }
        | undefined;
      if (
        row &&
        typeof row.roomCode === "string" &&
        typeof row.senderId === "string" &&
        typeof row.lamport === "number"
      ) {
        out.set(id, {
          roomCode: row.roomCode,
          senderId: row.senderId,
          lamport: row.lamport,
        });
      }
    }),
    tx.done,
  ]);
  return out;
}

export async function putMessage(message: Message): Promise<void> {
  const database = await getDB();
  await database.put("messages", await _seal("messages", message));
}

export async function bulkPutMessages(messages: Message[]): Promise<void> {
  const database = await getDB();
  const sealed = await Promise.all(messages.map((m) => _seal("messages", m)));
  const tx = database.transaction("messages", "readwrite");
  await Promise.all([...sealed.map((m) => tx.store.put(m)), tx.done]);
}

export async function deleteMessagesForRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  const blindRoomCode = await blindValue(roomCode);

  // Query both blinded and plaintext ranges to handle messages mid-migration.
  // A legacy row in plaintext would be invisible to getAll(blindRoomCode).
  let messages: Message[] = [];
  let watermarks: WatermarkRecord[] = [];
  let attachmentIds: string[] = [];

  // Read data in transaction
  const readTx = database.transaction(
    ["messages", "watermarks", "attachments"],
    "readonly"
  );
  {
    const messagesIndex = readTx.objectStore("messages").index("byRoom");
    messages = await messagesIndex.getAll(blindRoomCode);
    if (!isMigrationComplete()) {
      // During migration, query plaintext keys too. The cast is safe: we are
      // intentionally querying the index with legacy plaintext values that exist
      // in the database alongside blinded ones.
      const plaintextMessages = await messagesIndex.getAll(
        roomCode as Blinded
      );
      const byId = new Map<string, Message>();
      for (const m of messages) byId.set(m.id, m);
      for (const m of plaintextMessages) byId.set(m.id, m);
      messages = Array.from(byId.values());
    }

    // Get watermarks
    const wmIndex = readTx.objectStore("watermarks").index("byRoom");
    watermarks = await wmIndex.getAll(blindRoomCode);
    if (!isMigrationComplete()) {
      // During migration, also query plaintext roomCode for legacy rows.
      // The cast is safe: we are intentionally querying the index with legacy
      // plaintext values that exist in the database alongside blinded ones.
      const plaintextWatermarks = await wmIndex.getAll(roomCode as Blinded);
      const byId = new Map<string, WatermarkRecord>();
      for (const w of watermarks) byId.set(w.id as string, w);
      for (const w of plaintextWatermarks) byId.set(w.id as string, w);
      watermarks = Array.from(byId.values());
    }
  }
  await readTx.done;

  // Pre-blind all message IDs outside the transaction
  const blindedMessageIds = new Map<string, string>();
  for (const msg of messages) {
    blindedMessageIds.set(msg.id, await blindValue(msg.id));
  }

  // Get attachments in second transaction
  const attTx = database.transaction(["attachments"], "readonly");
  for (const msg of messages) {
    const blindedMsgId = blindedMessageIds.get(msg.id)!;
    const attachmentsIndex = attTx.objectStore("attachments").index("byMessage");
    let attachments = await attachmentsIndex.getAll(blindedMsgId as Blinded);
    if (!isMigrationComplete()) {
      const plaintextAttachments = await attachmentsIndex.getAll(
        msg.id as Blinded
      );
      const byId = new Map<string, Attachment>();
      for (const a of attachments) byId.set(a.id, a);
      for (const a of plaintextAttachments) byId.set(a.id, a);
      attachments = Array.from(byId.values());
    }
    attachmentIds.push(...attachments.map((a) => a.id));
  }
  await attTx.done;

  // Delete in a separate transaction
  const writeTx = database.transaction(
    ["messages", "attachments", "watermarks"],
    "readwrite"
  );
  for (const attId of attachmentIds) {
    await writeTx.objectStore("attachments").delete(attId);
    _attachmentEpoch += 1;
  }
  for (const msg of messages) {
    await writeTx.objectStore("messages").delete(msg.id);
  }
  for (const wm of watermarks) {
    // Use wm.id directly - it is already the composite key in the correct
    // form (blinded if the row is migrated, plaintext if legacy). Avoid
    // double-blinding: wm.roomCode and wm.senderId are already blinded in
    // migrated rows, so constructing the composite from them and blinding
    // again would produce a key that never matches. Cast to Blinded because
    // we know the value is either properly blinded or plaintext, both of
    // which are present in the store as-is.
    await writeTx.objectStore("watermarks").delete(wm.id as Blinded);
  }
  await writeTx.done;
  // The Yjs snapshot lives in its own store; a leftover one would resurrect
  // the shared doc if the same room code is ever joined again. Delete both the
  // blinded key (if migrated) and the plaintext key (if legacy).
  await database.delete("yjsDocs", await blindValue("channel:" + roomCode)).catch(() => {});
  // Cast to Blinded: during migration, legacy plaintext keys exist and must
  // be deleted. This is intentional and safe.
  await database.delete("yjsDocs", ("channel:" + roomCode) as Blinded).catch(() => {});
}

export async function getUnreadCount(
  roomCode: string,
  lastSeenLamport: number,
  excludeSenderId?: string
): Promise<number> {
  const database = await getDB();
  const blindRoomCode = await blindValue(roomCode);
  const blindedExcludeSenderId = excludeSenderId
    ? await blindValue(excludeSenderId)
    : undefined;
  const blindedRange = IDBKeyRange.bound(
    [blindRoomCode, lastSeenLamport + 1],
    [blindRoomCode, Number.MAX_SAFE_INTEGER]
  );

  // Reactions and plugin updates are not "new messages": a heart on an old
  // message or a plugin update must not light the unread badge with nothing
  // visible to read. The range holds only unseen messages, so materializing
  // it stays cheap.
  let messages = await database
    .transaction("messages")
    .store.index("byRoomLamport")
    .getAll(blindedRange);

  // During migration, also query the plaintext range to see unmigrated rows
  if (!isMigrationComplete()) {
    const plaintextRange = IDBKeyRange.bound(
      [roomCode, lastSeenLamport + 1],
      [roomCode, Number.MAX_SAFE_INTEGER]
    );
    const plaintextMessages = await database
      .transaction("messages")
      .store.index("byRoomLamport")
      .getAll(plaintextRange);
    // Deduplicate by id
    const byId = new Map<string, Message>();
    for (const m of messages) {
      byId.set(m.id, m);
    }
    for (const m of plaintextMessages) {
      byId.set(m.id, m);
    }
    messages = Array.from(byId.values());
  }

  return messages.filter(
    (m) =>
      m.type !== MessageType.Reaction &&
      m.type !== MessageType.PluginUpdate &&
      (!blindedExcludeSenderId || m.senderId !== blindedExcludeSenderId)
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
  // status lives inside the sealed blob, so this is a three-step cascade:
  // collect candidates by clear senderId, decrypt/filter/re-seal outside any
  // transaction, then write the changed rows back.
  const blindRoomCode = await blindValue(roomCode);
  const blindedSenderId = await blindValue(senderId);
  const blindedRange = IDBKeyRange.bound(
    [blindRoomCode, 0],
    [blindRoomCode, lamport]
  );

  // Collect candidates from both blinded and plaintext ranges to see all rows
  const candidates: Message[] = [];
  let cursor = await database
    .transaction("messages")
    .store.index("byRoomLamport")
    .openCursor(blindedRange);
  while (cursor) {
    const v = cursor.value;
    // senderId and status are clear fields: already-read backlog is skipped
    // here without a decrypt, so a cascade costs crypto only for the rows it
    // actually changes. A sealed row without a clear status (pre-status-clear
    // layout) falls through and the post-decrypt check below decides.
    if (
      v.senderId === blindedSenderId &&
      (!v.status || MESSAGE_STATUS_RANK[v.status] < MESSAGE_STATUS_RANK.read)
    ) {
      candidates.push(v);
    }
    cursor = await cursor.continue();
  }

  // During migration, also walk the plaintext range in a separate transaction
  if (!isMigrationComplete()) {
    const plaintextRange = IDBKeyRange.bound(
      [roomCode, 0],
      [roomCode, lamport]
    );
    cursor = await database
      .transaction("messages")
      .store.index("byRoomLamport")
      .openCursor(plaintextRange);
    const seenIds = new Set(candidates.map((m) => m.id));
    while (cursor) {
      const v = cursor.value;
      if (!seenIds.has(v.id)) {
        if (
          v.senderId === blindedSenderId &&
          (!v.status || MESSAGE_STATUS_RANK[v.status] < MESSAGE_STATUS_RANK.read)
        ) {
          candidates.push(v);
        }
      }
      cursor = await cursor.continue();
    }
  }

  const changed: Message[] = [];
  for (const row of candidates) {
    const m = (await _open("messages", row))!;
    if (!m.status || MESSAGE_STATUS_RANK[m.status] < MESSAGE_STATUS_RANK.read) {
      changed.push(await _seal("messages", { ...m, status: "read" as const }));
    }
  }
  if (!changed.length) return [];

  const tx = database.transaction("messages", "readwrite");
  const written: string[] = [];
  for (const m of changed) {
    // Skip rows deleted while the crypto ran; "read" is the max rank, so
    // overwriting a surviving row can never regress it.
    const fresh = await tx.store.get(m.id);
    if (!fresh) continue;
    await tx.store.put(m);
    written.push(m.id);
  }
  await tx.done;
  return written;
}

/** Advance a message's delivery status. Never regresses (read stays read). */
export async function updateMessageStatus(
  id: string,
  status: MessageStatus
): Promise<void> {
  const database = await getDB();
  const message = await _open<Message>(
    "messages",
    await database.get("messages", id)
  );
  if (!message) return;
  if (
    message.status &&
    MESSAGE_STATUS_RANK[message.status] >= MESSAGE_STATUS_RANK[status]
  ) {
    return;
  }
  const sealed = await _seal("messages", { ...message, status });
  // The crypto ran outside any transaction; re-check against the freshest
  // row (status is a clear field on sealed rows) so a read-cascade that
  // landed meanwhile is never regressed, and a deleted row never returns.
  const tx = database.transaction("messages", "readwrite");
  const fresh = await tx.store.get(id);
  if (
    fresh &&
    (!fresh.status ||
      MESSAGE_STATUS_RANK[fresh.status] < MESSAGE_STATUS_RANK[status])
  ) {
    await tx.store.put(sealed);
  }
  await tx.done;
}

export async function getAttachment(
  id: string
): Promise<Attachment | undefined> {
  const database = await getDB();
  return _open("attachments", await database.get("attachments", id));
}

export async function getAttachmentsByMessage(
  messageId: string
): Promise<Attachment[]> {
  const database = await getDB();
  const blindedMessageId = await blindValue(messageId);
  let attachments = await database.getAllFromIndex(
    "attachments",
    "byMessage",
    blindedMessageId
  );
  // During migration, also query the plaintext messageId for legacy rows.
  if (!isMigrationComplete()) {
    // Cast to Blinded: we are intentionally querying the index with legacy
    // plaintext values that exist in the database alongside blinded ones.
    const plaintextAttachments = await database.getAllFromIndex(
      "attachments",
      "byMessage",
      messageId as Blinded
    );
    const byId = new Map<string, Attachment>();
    for (const a of attachments) byId.set(a.id, a);
    for (const a of plaintextAttachments) byId.set(a.id, a);
    attachments = Array.from(byId.values());
  }
  return _openAll("attachments", attachments);
}

export async function getAttachmentsByInfoHash(
  infoHash: string
): Promise<Attachment[]> {
  const database = await getDB();
  const blindedInfoHash = await blindValue(infoHash);
  return _openAll(
    "attachments",
    await database.getAllFromIndex("attachments", "byInfoHash", blindedInfoHash)
  );
}

/**
 * Whether a stored (possibly not-yet-migrated) field matches a real value.
 *
 * The blind migration rewrites rows in the background and can be interrupted
 * by a closed tab, so for a while a store holds BOTH shapes: migrated rows
 * carry the keyed hash, legacy rows still carry the plaintext. Comparing only
 * against the hash makes every unmigrated row invisible - not an error, just
 * silently missing history - which breaks the guarantee that the app stays
 * usable while the sweep runs.
 */
export async function getAttachmentsWithData(
  roomCode: string
): Promise<Attachment[]> {
  const database = await getDB();
  const blindedRoomCode = await blindValue(roomCode);
  // Select by the bytes, not the status: rows written before the status
  // rank guards could be stuck at "downloading"/"failed" WITH data present,
  // and filtering on status made those images unrenderable forever.
  // rowHasBytes sees the bytes whether the row is sealed or legacy, and the
  // filter runs BEFORE decryption so no-data rows never cost a decrypt.
  // A cursor, not getAll: every room's multi-MB sealed blobs materialized
  // at once just to pick this room's - a real memory spike on phones for
  // every single room open.
  const matches: Attachment[] = [];
  let cursor = await database.transaction("attachments").store.openCursor();
  while (cursor) {
    const a = cursor.value;
    if (
      rowHasBytes(a, "data") &&
      (a.roomCode === blindedRoomCode || a.roomCode === roomCode)
    ) {
      matches.push(a);
    }
    cursor = await cursor.continue();
  }
  return _openAll("attachments", matches);
}

/**
 * Bumped whenever the stored attachment set changes, so callers that cache a
 * derived view of it can tell theirs is stale without re-reading the store.
 */
let _attachmentEpoch = 0;
export function attachmentEpoch(): number {
  return _attachmentEpoch;
}

/**
 * Every file we still hold the bytes for, with the room it belongs to.
 *
 * Walked with a cursor rather than getAll(): the records carry the blobs, and
 * materialising all of them at once to read four small fields is how you run a
 * phone out of memory.
 */
export async function getSeedableFiles(): Promise<
  Array<{ roomCode: string; file: FileEntry }>
> {
  const database = await getDB();
  // Two passes: the cursor walk collects one small clone per file using only
  // clear fields and drops the blob references, then the metadata decrypt
  // (skipBytes: filename/mimeType/size live in the JSON blob, the file bytes
  // stay sealed) happens outside the transaction. Deduplication happens after
  // decryption using the plaintext infoHash - during migration, the raw
  // infoHash is blinded for migrated rows and plaintext for legacy rows, so
  // the same file could appear twice without plaintext-based deduplication.
  const rows: Attachment[] = [];
  let cursor = await database.transaction("attachments").store.openCursor();
  while (cursor) {
    const row = cursor.value;
    if (rowHasBytes(row, "data")) {
      const { data: _d, ...meta } = row as Attachment & {
        _encBytes?: unknown;
      };
      delete (meta as { _encBytes?: unknown })._encBytes;
      rows.push(meta as Attachment);
    }
    cursor = await cursor.continue();
  }
  const out: Array<{ roomCode: string; file: FileEntry }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const a = await openRow<Attachment>(row, STORE_SPECS.attachments, {
      skipBytes: true,
    });
    if (!seen.has(a.infoHash)) {
      seen.add(a.infoHash);
      out.push({
        roomCode: a.roomCode,
        file: {
          infoHash: a.infoHash,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        },
      });
    }
  }
  return out;
}

export async function putAttachment(attachment: Attachment): Promise<void> {
  const database = await getDB();
  const { blobURL: _, ...record } = attachment;
  await database.put("attachments", await _seal("attachments", record));
  _attachmentEpoch += 1;
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
  const attachment = await _open<Attachment>(
    "attachments",
    await database.get("attachments", id)
  );
  if (!attachment) return;
  const status =
    ATTACHMENT_STATUS_RANK[attachment.status] >=
    ATTACHMENT_STATUS_RANK.complete
      ? attachment.status
      : ("complete" as AttachmentStatus);
  const sealed = await _seal("attachments", { ...attachment, data, status });
  // The seal ran outside any transaction; status is a CLEAR field, so the
  // regression guard re-checks against the freshest row at write time - the
  // seeding path may have advanced it while we were encrypting the blob.
  const tx = database.transaction("attachments", "readwrite");
  const fresh = await tx.store.get(id);
  if (!fresh) {
    // Deleted (room wipe) while the blob was encrypting: re-inserting it
    // would leave an undeletable orphan.
    await tx.done;
    return;
  }
  if (
    ATTACHMENT_STATUS_RANK[fresh.status] > ATTACHMENT_STATUS_RANK[sealed.status]
  ) {
    sealed.status = fresh.status;
  }
  await tx.store.put(sealed);
  await tx.done;
  _attachmentEpoch += 1;
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
  const blindedRoomCode = await blindValue(roomCode);
  let result = await database.get("rooms", blindedRoomCode);
  // During migration, the store holds both blinded and plaintext rows - look
  // up both keys so unmigrated rows are not invisible.
  if (!result && !isMigrationComplete()) {
    // Cast to Blinded: during migration, legacy plaintext keys exist and must
    // be looked up. This is intentional and safe.
    result = await database.get("rooms", roomCode as Blinded);
  }
  return _open("rooms", result);
}

export async function getAllRooms(): Promise<(Room | DMRoom)[]> {
  const database = await getDB();
  return _openAll("rooms", await database.getAll("rooms"));
}

export async function getDMRooms(): Promise<DMRoom[]> {
  const database = await getDB();
  return _openAll(
    "rooms",
    (await database.getAllFromIndex("rooms", "byType", "dm")) as DMRoom[]
  );
}

export async function putRoom(room: Room | DMRoom): Promise<void> {
  const database = await getDB();
  const roomWithParticipants = {
    ...room,
    participants: room.participants ?? [],
  };
  const sealed = await _seal("rooms", roomWithParticipants);
  const blindedRoomCode = await blindValue(room.roomCode);
  // The primary key changed (roomCode is now blinded), so we must delete the
  // old plaintext key if it exists, then put the new blinded one. Otherwise
  // we end up with both versions in the store.
  const tx = database.transaction("rooms", "readwrite");
  // Cast to Blinded: during migration, legacy plaintext keys exist and must
  // be deleted. This is intentional and safe.
  await tx.store.delete(room.roomCode as Blinded);
  await tx.store.put(sealed);
  await tx.done;
}

/** Shared read-decrypt-modify-seal-write cycle for room records. The old
 *  single-transaction versions cannot survive at-rest crypto (an IDB tx
 *  auto-commits on any non-IDB await), so the patch runs between a read and
 *  a write; every patch below is idempotent or monotonic, which keeps the
 *  slightly wider race window harmless. */
async function _patchRoom(
  roomCode: string,
  patch: (room: Room | DMRoom) => Room | DMRoom | null
): Promise<void> {
  const database = await getDB();
  const blindedRoomCode = await blindValue(roomCode);
  let result = await database.get("rooms", blindedRoomCode);
  // During migration, the store holds both blinded and plaintext rows - look
  // up both keys so unmigrated rows are not invisible.
  if (!result && !isMigrationComplete()) {
    // Cast to Blinded: during migration, legacy plaintext keys exist and must
    // be looked up. This is intentional and safe.
    result = await database.get("rooms", roomCode as Blinded);
  }
  const room = await _open<Room | DMRoom>("rooms", result);
  if (!room) return;
  const updated = patch(room);
  if (!updated) return;
  const sealed = await _seal("rooms", updated);
  // The primary key is blinded, so delete the old plaintext key before
  // putting the updated version under the blinded key. For new rooms this
  // is a no-op; for migrated ones it cleans up the plaintext record.
  const tx = database.transaction("rooms", "readwrite");
  // Cast to Blinded: we are intentionally deleting the legacy plaintext key.
  await tx.store.delete(roomCode as Blinded);
  await tx.store.put(sealed);
  await tx.done;
}

export async function getRoomParticipants(roomCode: string): Promise<string[]> {
  const room = await getRoom(roomCode);
  return room?.participants ?? [];
}

export async function addRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  // participants are documented as DIDs; a raw peerId written here is never
  // matched by a leave (keyed by DID) and ghosts the member list for 7 days.
  if (!peerId.startsWith("did:")) return;
  await _patchRoom(roomCode, (room) => {
    const participants = new Set(room.participants ?? []);
    participants.add(peerId);
    const participantLastSeen = room.participantLastSeen ?? {};
    participantLastSeen[peerId] = Date.now();
    return { ...room, participants: [...participants], participantLastSeen };
  });
}

export async function updateParticipantLastSeen(
  roomCode: string,
  peerId: string
): Promise<void> {
  await _patchRoom(roomCode, (room) => {
    const participantLastSeen = room.participantLastSeen ?? {};
    participantLastSeen[peerId] = Date.now();
    return { ...room, participantLastSeen };
  });
}

export async function removeRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  await _patchRoom(roomCode, (room) => {
    const participants = new Set(room.participants ?? []);
    participants.delete(peerId);
    const participantLastSeen = room.participantLastSeen ?? {};
    delete participantLastSeen[peerId];
    return { ...room, participants: [...participants], participantLastSeen };
  });
}

export async function cleanupInactiveParticipants(
  roomCode: string
): Promise<string[]> {
  const removed: string[] = [];
  await _patchRoom(roomCode, (room) => {
    const cutoff = Date.now() - PARTICIPANT_INACTIVE_MS;
    const participantLastSeen = room.participantLastSeen ?? {};
    const participants = new Set(room.participants ?? []);
    for (const peerId of participants) {
      const lastSeen = participantLastSeen[peerId] ?? 0;
      if (lastSeen < cutoff) {
        participants.delete(peerId);
        delete participantLastSeen[peerId];
        removed.push(peerId);
      }
    }
    return { ...room, participants: [...participants], participantLastSeen };
  });
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
  await _patchRoom(roomCode, (room) => ({
    ...room,
    lastSeenLamport: Math.max(room.lastSeenLamport ?? 0, lamport),
  }));
}

export async function deleteRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  const blindedRoomCode = await blindValue(roomCode);
  const tx = database.transaction("rooms", "readwrite");
  // Delete both the old plaintext key (for migrated records) and the new
  // blinded key, in case the record exists under either.
  // Cast to Blinded: during migration, both forms may exist and must be deleted.
  await tx.store.delete(roomCode as Blinded);
  await tx.store.delete(blindedRoomCode);
  await tx.done;
}

export async function getOwnProfile(
  selfDid?: string,
  opts?: { skipBytes?: boolean }
): Promise<OwnProfile | undefined> {
  const database = await getDB();
  // did and isMe are clear fields, so both lookups run before any decrypt.
  const all = await database.getAll("profiles");
  const mine = all.find((p) => p.isMe === true);
  // skipBytes: senders only need the nickname - decrypting the avatar and
  // banner blobs on EVERY message send was a visible chunk of send latency.
  if (mine) return _open("profiles", mine as OwnProfile, opts);
  // Fall back to the row under our own did, and repair the flag. An incoming
  // profile used to be written over that row with isMe:false - our own second
  // device carries the same did - and the flag alone then hid a row that was
  // otherwise intact, so the app looked like it had forgotten who we are.
  if (!selfDid) return undefined;
  // Matches a migrated (blinded) row or a legacy plaintext one - during the
  // sweep the store holds both.
  const selfDidBlinded = await blindValue(selfDid);
  const byDid = all.find(
    (p) => p.did === selfDidBlinded || p.did === selfDid
  );
  if (!byDid) return undefined;
  const repaired = {
    ...(await _open<OwnProfile>("profiles", byDid as OwnProfile))!,
    isMe: true as const,
  };
  try {
    await database.put("profiles", await _seal("profiles", repaired));
  } catch {
    // Reading still works even if the repair write does not.
  }
  return repaired;
}

export async function putOwnProfile(profile: OwnProfile): Promise<void> {
  const database = await getDB();
  const sealed = await _seal("profiles", { ...profile, isMe: true as const });
  const blindedDid = await blindValue(profile.did);
  // The primary key changed (did is now blinded), so we must delete the old
  // plaintext key if it exists, then put the new blinded one.
  const tx = database.transaction("profiles", "readwrite");
  // Cast to Blinded: we are intentionally deleting the legacy plaintext key.
  await tx.store.delete(profile.did as Blinded);
  await tx.store.put(sealed);
  await tx.done;
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
  const blindedFrom = await blindValue(from);
  const blindedTo = await blindValue(to);
  const existing = await _open<OwnProfile>(
    "profiles",
    (await database.get("profiles", blindedFrom)) as OwnProfile | undefined
  );
  if (existing) {
    const sealed = await _seal("profiles", {
      ...existing,
      did: to,
      isMe: true as const,
    });
    // Crypto done; delete old keys (plaintext and blinded) and put the new
    // blinded key in ONE transaction so an interruption can never leave two
    // isMe rows behind.
    const tx = database.transaction("profiles", "readwrite");
    // Cast to Blinded: we are intentionally deleting both the legacy plaintext
    // key and the previous blinded key.
    await tx.store.delete(from as Blinded);
    await tx.store.delete(blindedFrom);
    await tx.store.put(sealed);
    await tx.done;
  }
}

/**
 * Patch own profile.
 * pfpData and pfpURL are mutually exclusive - setting one clears the other.
 */
export async function updateOwnProfile(
  patch: Partial<Pick<OwnProfile, "nickname" | "pfpData" | "pfpURL" | "color" | "bannerData" | "bannerURL" | "tagText" | "tagTextColor" | "tagChipColor" | "bio" | "nameEffect" | "gradient2" | "gradient3">>
): Promise<void> {
  const database = await getDB();
  const all = await database.getAll("profiles");
  const row = all.find((p) => p.isMe === true);
  if (!row) return;
  const profile = (await _open<OwnProfile>("profiles", row as OwnProfile))!;
  const updated: OwnProfile = { ...profile, ...patch, updatedAt: Date.now() };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  if (patch.bannerData !== undefined) updated.bannerURL = undefined;
  if (patch.bannerURL !== undefined) updated.bannerData = undefined;
  const sealed = await _seal("profiles", updated);
  const blindedDid = await blindValue(updated.did);
  // The primary key is blinded, so delete the old plaintext key before
  // putting the updated version under the blinded key.
  const tx = database.transaction("profiles", "readwrite");
  // Cast to Blinded: we are intentionally deleting the legacy plaintext key.
  await tx.store.delete(profile.did as Blinded);
  await tx.store.put(sealed);
  await tx.done;
}

export async function getPeerProfile(
  did: string
): Promise<PeerProfile | undefined> {
  const database = await getDB();
  const blindedDid = await blindValue(did);
  let record = await database.get("profiles", blindedDid);
  // During migration, the store holds both blinded and plaintext rows - look
  // up both keys so unmigrated rows are not invisible.
  if (!record && !isMigrationComplete()) {
    // Cast to Blinded: during migration, legacy plaintext keys exist and must
    // be looked up. This is intentional and safe.
    record = await database.get("profiles", did as Blinded);
  }
  if (!record || record.isMe) return undefined;
  return _open("profiles", record as PeerProfile);
}

export async function putPeerProfile(profile: PeerProfile): Promise<void> {
  const database = await getDB();
  const sealed = await _seal("profiles", { ...profile, isMe: false as const });
  const blindedDid = await blindValue(profile.did);
  // The primary key changed (did is now blinded), so we must delete the old
  // plaintext key if it exists, then put the new blinded one.
  const tx = database.transaction("profiles", "readwrite");
  // Cast to Blinded: we are intentionally deleting the legacy plaintext key.
  await tx.store.delete(profile.did as Blinded);
  await tx.store.put(sealed);
  await tx.done;
}

export async function getAllPeerProfiles(): Promise<PeerProfile[]> {
  const database = await getDB();
  const all = await database.getAll("profiles");
  return _openAll(
    "profiles",
    all.filter((p): p is PeerProfile => p.isMe === false)
  );
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

/**
 * Composite watermark key from real roomCode and senderId.
 * sealRow will blind the entire id field, so we don't pre-blind the parts.
 * The format is "roomCode:senderId" which sealRow will convert to a hash.
 */
function watermarkId(roomCode: string, senderId: string): string {
  return `${roomCode}:${senderId}`;
}

export async function getWatermark(
  roomCode: string,
  senderId: string
): Promise<number> {
  const database = await getDB();
  const id = watermarkId(roomCode, senderId);
  const blindedId = await blindValue(id);
  let record = await database.get("watermarks", blindedId);
  // During migration, the store holds both blinded and plaintext rows - look
  // up both keys so unmigrated rows are not invisible.
  if (!record && !isMigrationComplete()) {
    // Cast to Blinded: during migration, legacy plaintext keys exist and must
    // be looked up. This is intentional and safe.
    record = await database.get("watermarks", id as Blinded);
  }
  return record?.maxLamport ?? 0;
}

export async function setWatermark(
  roomCode: string,
  senderId: string,
  maxLamport: number
): Promise<void> {
  const database = await getDB();
  const id = watermarkId(roomCode, senderId);
  const blindedId = await blindValue(id);
  // Seal OUTSIDE the transaction to avoid timeout issues with async ops.
  const sealed = await _seal("watermarks", {
    id,
    roomCode,
    senderId,
    maxLamport,
  });
  // Read+write in ONE transaction so concurrent fire-and-forget callers can't
  // interleave and regress the watermark (a late lower value clobbering a
  // higher one written between our get and put).
  const tx = database.transaction("watermarks", "readwrite");
  const existing = await tx.store.get(blindedId);
  // Never regress - only advance the watermark
  if (!existing || existing.maxLamport < maxLamport) {
    await tx.store.put(sealed);
  }
  await tx.done;
}

export async function getWatermarksForRoom(
  roomCode: string
): Promise<Record<string, number>> {
  const database = await getDB();
  const blindedRoomCode = await blindValue(roomCode);
  let records = await database.getAllFromIndex(
    "watermarks",
    "byRoom",
    blindedRoomCode
  );

  // During migration, also query the plaintext roomCode to see unmigrated rows
  if (!isMigrationComplete()) {
    // Cast to Blinded: we are intentionally querying the index with legacy
    // plaintext values that exist in the database alongside blinded ones.
    const plaintextRecords = await database.getAllFromIndex(
      "watermarks",
      "byRoom",
      roomCode as Blinded
    );
    // Deduplicate by id field
    const byId = new Map<string, WatermarkRecord>();
    for (const r of records) {
      byId.set(r.id, r);
    }
    for (const r of plaintextRecords) {
      byId.set(r.id, r);
    }
    records = Array.from(byId.values());
  }

  // Watermarks are stored with blinded senderId, but we need to return a map
  // keyed by real DID. Group by blinded senderId first (cheap), then decrypt
  // one row per group to get the real DID.
  const byBlinded = new Map<string, WatermarkRecord>();
  for (const record of records) {
    const existing = byBlinded.get(record.senderId);
    // Keep the highest lamport per blinded sender (consistency).
    if (!existing || record.maxLamport > existing.maxLamport) {
      byBlinded.set(record.senderId, record);
    }
  }
  const result: Record<string, number> = {};
  for (const record of byBlinded.values()) {
    const decrypted = await _open<WatermarkRecord>("watermarks", record);
    if (decrypted?.senderId) {
      result[decrypted.senderId] = decrypted.maxLamport;
    }
  }
  return result;
}

export async function getAllSavedGifs(): Promise<SavedGif[]> {
  const database = await getDB();
  return _openAll("savedGifs", await database.getAll("savedGifs"));
}

export async function putSavedGif(gif: SavedGif): Promise<void> {
  const database = await getDB();
  await database.put("savedGifs", await _seal("savedGifs", gif));
}

export async function deleteSavedGif(id: string): Promise<void> {
  const database = await getDB();
  await database.delete("savedGifs", id);
}

export async function isGifSaved(gifId: string): Promise<SavedGif | undefined> {
  const database = await getDB();
  const all = await database.getAll("savedGifs");
  // gifId is blinded in sealed rows: check against both the blinded and
  // plaintext versions during the migration window to handle both forms.
  const blindedGifId = await blindValue(gifId);
  const row = all.find((g) => g.gifId === blindedGifId || g.gifId === gifId);
  return _open("savedGifs", row);
}

export async function getWebAuthnRecord(): Promise<WebAuthnRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "webauthn") as Promise<
    WebAuthnRecord | undefined
  >;
}

export async function getPhonebookEntries(): Promise<PhonebookEntry[]> {
  const database = await getDB();
  const entries = await _openAll<PhonebookEntry>(
    "phonebook",
    await database.getAll("phonebook")
  );
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
  const entries = await _openAll<PhonebookEntry>(
    "phonebook",
    await database.getAll("phonebook")
  );
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
    // e.peerId came off an OPENED row, so it is the real value - but the
    // store is keyed by the blinded one. Deleting the raw value silently
    // matches nothing and leaves both duplicates behind.
    for (const e of group) {
      await database.delete("phonebook", await blindValue(e.peerId));
    }
    await database.put("phonebook", await _seal("phonebook", merged));
  }
}

export async function putPhonebookEntry(entry: PhonebookEntry): Promise<void> {
  const database = await getDB();
  await database.put("phonebook", await _seal("phonebook", entry));
}

export async function deletePhonebookEntry(peerId: string): Promise<void> {
  const database = await getDB();
  const blindedPeerId = await blindValue(peerId);
  const tx = database.transaction("phonebook", "readwrite");
  // Delete both the old plaintext key (for legacy records) and the new
  // blinded key, in case the entry exists under either.
  // Cast to Blinded: during migration, legacy plaintext keys exist and must
  // be deleted.
  await tx.store.delete(peerId as Blinded);
  await tx.store.delete(blindedPeerId);
  await tx.done;
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

/** Close the cached connection without deleting anything - a
 *  deleteDatabase from elsewhere (the duress wipe) blocks forever while
 *  this module holds its handle open. */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── at-rest migration ────────────────────────────────────────────────────────

// Scoped to the IDENTITY, not the device. "This device has been swept" was
// the wrong question: the sweep seals rows with the signed-in identity's key,
// so a device that finished sweeping for one account would skip the sweep
// entirely for the next one, leaving whatever was still plaintext readable -
// and unsealed rows are readable by ANY identity (openRow returns them before
// it asks for a key).
const ATREST_FLAG_PREFIX = "awful:atrest:v2";
let _atRestOwner: string | null = null;
let _migrationRunning = false;

function atRestFlagKey(): string {
  return _atRestOwner
    ? `${ATREST_FLAG_PREFIX}:${_atRestOwner}`
    : ATREST_FLAG_PREFIX;
}

/**
 * Check if the blind migration is complete. While the migration runs in
 * the background, reads must see both blinded and plaintext rows; once
 * the flag is set, the extra lookups are unnecessary.
 */
function isMigrationComplete(): boolean {
  try {
    return localStorage.getItem(atRestFlagKey()) !== null;
  } catch {
    // Without localStorage (tests), assume NOT complete so dual reads happen.
    return false;
  }
}

/** Names the identity whose data the sweep is responsible for. */
export function setAtRestOwner(did: string | null): void {
  _atRestOwner = did;
}

/** Call after any write that may have landed plaintext (a locked import):
 *  the next unlock's sweep re-scans and seals it. */
export function markAtRestSweepNeeded(): void {
  try {
    localStorage.removeItem(atRestFlagKey());
    // The unscoped key is what older builds wrote; clear it too so an
    // upgrade does not inherit a "done" that was never true for this
    // identity.
    localStorage.removeItem(ATREST_FLAG_PREFIX);
  } catch {
    // Without localStorage the sweep always runs anyway.
  }
}

/**
 * Check if a row needs re-sealing for the blinding migration. A row needs
 * blinding if: (1) it is not sealed at all (legacy plaintext), OR (2) it is
 * sealed but contains unblinded values in the blind fields.
 */
function needsBlindingMigration(
  row: unknown,
  spec: StoreCryptoSpec
): boolean {
  if (!isSealed(row)) return true; // Legacy plaintext - needs sealing
  const r = row as Record<string, unknown>;
  // Check if any blind field contains an unblinded value (not prefixed with b1:)
  for (const field of spec.blind ?? []) {
    const value = r[field];
    if (typeof value === "string" && !isBlinded(value)) {
      return true; // Sealed but unblinded - needs re-sealing
    }
  }
  return false; // Already sealed and blinded
}

/**
 * One-time background sweep re-encrypting rows written before at-rest
 * encryption existed AND re-blinding sealed rows that lack blinding.
 * The blinding migration changes PRIMARY KEYS for rooms, profiles, watermarks,
 * and yjsDocs, so those stores delete the old key and insert the new one.
 * Reads pass legacy plaintext rows through, so the app is fully usable while
 * this runs; each pass converts a chunk and loops until a full scan finds
 * nothing needing migration. Chunked so no transaction spans the (async,
 * tx-killing) crypto, and so a mid-sweep close just resumes next unlock.
 */
export async function migrateAtRest(): Promise<void> {
  if (_migrationRunning) return;
  try {
    if (localStorage.getItem(atRestFlagKey())) return;
  } catch {
    // No localStorage (tests): scan anyway, it is cheap when all is blinded.
  }
  if (!storageCryptoReady()) return;
  _migrationRunning = true;
  try {
    const database = await getDB();
    let migratedCount = 0;
    // Stores whose primary key changed due to blinding: must delete old and
    // insert new to avoid duplicates.
    // Stores whose PRIMARY KEY is a blinded field. Their rows cannot be
    // rewritten in place: the put lands under the new hashed key and the old
    // plaintext-keyed row stays behind, so the store ends up holding both -
    // and the leftover is re-migrated on every future sweep, never
    // disappearing. Derived from STORE_SPECS rather than hand-listed, because
    // hand-listing it silently omitted phonebook (keyPath "peerId", blinded).
    const keyPathChangedStores = new Set<EncryptedStoreName>(
      (Object.keys(STORE_SPECS) as EncryptedStoreName[]).filter((name) => {
        const keyPath = database.transaction(name).store.keyPath;
        return (
          typeof keyPath === "string" &&
          ((STORE_SPECS[name] as StoreCryptoSpec).blind ?? []).includes(keyPath)
        );
      })
    );

    for (const store of Object.keys(STORE_SPECS) as EncryptedStoreName[]) {
      const spec = STORE_SPECS[store];
      // Byte-carrying stores hold multi-MB blobs per row: a 100-row chunk
      // of attachments would materialize hundreds of MB at once.
      const CHUNK = (STORE_SPECS[store] as { bytes?: string[] }).bytes?.length
        ? 8
        : 100;
      // Resume each chunk AFTER the last processed key: restarting the
      // cursor at the store head made every chunk re-skip all previously
      // migrated rows - O(n²) over a big legacy history, minutes of IDB
      // churn on the very unlock that migrates it.
      let lastKey: IDBValidKey | null = null;
      for (;;) {
        // Collect one chunk of rows needing migration (no crypto inside tx)...
        const toMigrate: Array<{
          key: IDBValidKey;
          row: Record<string, unknown>;
        }> = [];
        let cursor = await database
          .transaction(store)
          .store.openCursor(
            lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true)
          );
        while (cursor && toMigrate.length < CHUNK) {
          lastKey = cursor.primaryKey;
          if (needsBlindingMigration(cursor.value, spec)) {
            toMigrate.push({
              key: cursor.primaryKey,
              row: cursor.value as unknown as Record<string, unknown>,
            });
          }
          cursor = await cursor.continue();
        }
        if (toMigrate.length === 0) break;
        // ...seal/re-seal it outside, write it back conditionally. Every app
        // write seals, so a row that changed while our crypto ran is migrated
        // by now - re-checking inside the (atomic) write transaction means the
        // sweep can never clobber a live update with its stale pre-read.
        const sealed = await Promise.all(
          toMigrate.map((m) => sealRow(m.row, spec))
        );
        const tx = database.transaction(store, "readwrite");
        for (let i = 0; i < sealed.length; i++) {
          const fresh = await tx.store.get(toMigrate[i].key as string);
          if (fresh && needsBlindingMigration(fresh, spec)) {
            // For stores whose key path changed, delete the old key before
            // putting the new one (the sealed row's key is now blinded).
            if (keyPathChangedStores.has(store)) {
              await tx.store.delete(toMigrate[i].key as string);
            }
            await tx.store.put(sealed[i] as never);
            migratedCount += 1;
          }
        }
        await tx.done;
        if (toMigrate.length < CHUNK) break;
      }
    }
    if (migratedCount > 0) {
      console.log(`[storage] at-rest migration migrated ${migratedCount} rows`);
    }
    try {
      localStorage.setItem(atRestFlagKey(), String(Date.now()));
    } catch {
      // Flag is an optimization; the scan re-runs next unlock without it.
    }
  } finally {
    _migrationRunning = false;
  }
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

  const rooms = await _openAll<Room | DMRoom>(
    "rooms",
    await database.getAll("rooms")
  );
  const totalProfiles = await database.count("profiles");

  // A cursor, never getAll: materializing every attachment's bytes at once
  // just to sum their lengths stalled phones long enough that the Data tab
  // sat on "Loading metrics" forever - keeping the eviction warning and the
  // persist button unreachable on exactly the platform that needs them.
  // Ciphertext length ~= plaintext length for AES-GCM, so sealed rows report
  // their size without decrypting a single blob.
  let seedingCount = 0;
  let storedSize = 0;
  let totalAttachments = 0;
  let cursor = await database.transaction("attachments").store.openCursor();
  while (cursor) {
    const a = cursor.value as Attachment & {
      _encBytes?: { data?: { ct: ArrayBuffer } };
    };
    totalAttachments += 1;
    if (a.status === "seeding") seedingCount += 1;
    if (a.data) storedSize += a.data.byteLength;
    else if (a._encBytes?.data) storedSize += a._encBytes.data.ct.byteLength;
    cursor = await cursor.continue();
  }

  const totalMessages = await database.count("messages");
  const roomCounts = new Map<string, number>();
  for (const room of rooms) {
    const blindedRoomCode = await blindValue(room.roomCode);
    const count = await database.countFromIndex(
      "messages",
      "byRoomLamport",
      IDBKeyRange.bound(
        [blindedRoomCode, 0],
        [blindedRoomCode, Number.MAX_SAFE_INTEGER]
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
    totalProfiles,
    seedingAttachments: seedingCount,
    totalAttachments,
    storedDataSize: storedSize,
    rooms: roomMetrics,
  };
}
