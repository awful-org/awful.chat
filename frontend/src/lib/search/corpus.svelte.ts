/**
 * The in-memory search corpus: per-room decrypted entries, built lazily the
 * first time a scope is searched and kept current by the message-stored
 * hook. Plaintext lives ONLY here; what persists is the sealed per-room
 * index row (see STORE_SPECS.searchIndex), which turns the next session's
 * rebuild from one decrypt per message into one per room, plus one per
 * message that arrived since the row was written.
 */
import {
  countRowsBelow,
  getMessages,
  getSearchableSince,
  getSearchableStats,
  getSearchIndex,
  onMessageStored,
  putSearchIndex,
  type SearchIndexRecord,
} from "$lib/storage";
import {
  MessageType,
  type ChatMessageType,
  type Message,
} from "$lib/types/message";
import { getManifest } from "$lib/plugins/registry";
import {
  entryFromMessage,
  searchEntries,
  type SearchEntry,
  type SearchHit,
} from "./engine";
import type { SearchQuery } from "./query";

const SEARCHABLE_TYPES: readonly ChatMessageType[] = [
  MessageType.Text,
  MessageType.Reply,
  MessageType.File,
  MessageType.PluginCard,
];

interface RoomCorpus {
  entries: SearchEntry[];
  ids: Set<string>;
  /** Oldest timestamp swept so far, for the "searched back to…" hint. */
  sweptTo: number | null;
  done: boolean;
  sweeping: boolean;
  /** Highest lamport among the entries: where a saved index ends. */
  lastLamport: number;
  /** Entries landed since the sealed index was last written. */
  dirty: boolean;
  /** When this session last wrote the room's index (0: not yet). */
  savedAt: number;
}

const _rooms = new Map<string, RoomCorpus>();

/** Bumped whenever any corpus grows; the overlay re-derives results on it. */
export const corpusState = $state({ version: 0 });

/**
 * How often growth is announced. A sweep lands a page of fifty rows at a
 * time, and every announcement re-ran the whole search over everything swept
 * so far - typing during a 10,000-message sweep ran it two hundred times.
 */
const BUMP_EVERY_MS = 250;
let _bumpedAt = 0;
let _bumpTimer: ReturnType<typeof setTimeout> | null = null;

function announce(): void {
  _bumpedAt = Date.now();
  corpusState.version += 1;
}

/** A corpus grew: tell the overlay now, or at the end of the current window. */
function bump(): void {
  if (_bumpTimer) return;
  const wait = _bumpedAt + BUMP_EVERY_MS - Date.now();
  if (wait <= 0) {
    announce();
    return;
  }
  _bumpTimer = setTimeout(() => {
    _bumpTimer = null;
    announce();
  }, wait);
}

/** A room finished, or went away: that shows at once. */
function bumpNow(): void {
  if (_bumpTimer) {
    clearTimeout(_bumpTimer);
    _bumpTimer = null;
  }
  announce();
}

function pluginNameOf(pluginId: string): string | undefined {
  return getManifest(pluginId)?.name;
}

function corpusFor(roomCode: string): RoomCorpus {
  let c = _rooms.get(roomCode);
  if (!c) {
    c = {
      entries: [],
      ids: new Set(),
      sweptTo: null,
      done: false,
      sweeping: false,
      lastLamport: 0,
      dirty: false,
      savedAt: 0,
    };
    _rooms.set(roomCode, c);
  }
  return c;
}

function add(c: RoomCorpus, entry: SearchEntry): boolean {
  if (c.ids.has(entry.id)) return false;
  c.ids.add(entry.id);
  c.entries.push(entry);
  if (c.sweptTo === null || entry.timestamp < c.sweptTo)
    c.sweptTo = entry.timestamp;
  if (entry.lamport > c.lastLamport) c.lastLamport = entry.lamport;
  return true;
}

// ── live append ──────────────────────────────────────────────────────────────

let _hooked = false;

function ensureHook(): void {
  if (_hooked) return;
  _hooked = true;
  onMessageStored((msg) => {
    // Only rooms searched this session. Every other room's sealed index is
    // brought up to date from storage the next time it is searched; keeping
    // them current from here re-read, re-sealed and rewrote a room's whole
    // index a few seconds after every message, for as long as the page lived.
    const c = _rooms.get(msg.roomCode);
    if (!c) return;
    const entry = entryFromMessage(msg, pluginNameOf);
    if (!entry || !add(c, entry)) return;
    c.dirty = true;
    bump();
    scheduleSave();
  });
  // Leaving the page is the last chance to keep what this session indexed.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void saveSearchIndexes();
    });
  }
}

// ── sealed index writes ──────────────────────────────────────────────────────

/** How long a room's new entries wait before its index is written. */
const SAVE_AFTER_MS = 10_000;
/**
 * The least time between two writes of one room's index. A write is the
 * whole index - JSON, sealed, put - so a room that keeps talking is written
 * this often at most; what it says in between is read from storage the next
 * time the room is searched, one decrypt per message.
 */
const SAVE_EVERY_MS = 5 * 60_000;

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _saveDue = Infinity;
let _saving = false;

function scheduleSave(delay = SAVE_AFTER_MS): void {
  const due = Date.now() + delay;
  if (_saveTimer && _saveDue <= due) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveDue = due;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _saveDue = Infinity;
    void saveSearchIndexes();
  }, delay);
}

/**
 * Write the index of every searched room that has entries its sealed row
 * lacks, as far as the write throttle allows; the rest wait their turn.
 */
export async function saveSearchIndexes(): Promise<void> {
  if (_saving) {
    scheduleSave();
    return;
  }
  _saving = true;
  let next = Infinity;
  try {
    for (const [roomCode, c] of [..._rooms]) {
      if (!c.dirty || !c.done || c.sweeping) continue;
      const wait = c.savedAt + SAVE_EVERY_MS - Date.now();
      if (c.savedAt > 0 && wait > 0) {
        next = Math.min(next, wait);
        continue;
      }
      try {
        await saveIndex(roomCode, c);
      } catch (err) {
        console.warn("[search] index write failed:", err);
      }
    }
  } finally {
    _saving = false;
  }
  if (next !== Infinity) scheduleSave(next);
}

async function saveIndex(roomCode: string, c: RoomCorpus): Promise<void> {
  const lastLamport = c.lastLamport;
  // Counted BEFORE the entries are taken. A row stored in between then sits
  // in the entries but not in the count, which the next session reads as
  // stale and rebuilds. The other order could count a row that never made
  // it into the entries, and that index would pass the check without it.
  const rowsBelow = await countRowsBelow(roomCode, lastLamport);
  if (_rooms.get(roomCode) !== c) return;
  const record: SearchIndexRecord = {
    roomCode,
    lastLamport,
    rowsBelow,
    data: encodeIndex(c.entries),
  };
  c.dirty = false;
  c.savedAt = Date.now();
  try {
    // The room may be deleted while its index is sealed - its corpus object
    // is dropped then, and this write would resurrect an index row for a
    // room whose messages are gone.
    await putSearchIndex(record, () => _rooms.get(roomCode) === c);
  } catch (err) {
    c.dirty = true;
    throw err;
  }
}

// ── sealed index (de)serialization ───────────────────────────────────────────

/**
 * Bumped when what an entry holds changes, so an index sealed before is
 * rebuilt rather than trusted. 2: text is the message with markdown dropped.
 */
const INDEX_VERSION = 2;

function encodeIndex(entries: SearchEntry[]): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: INDEX_VERSION, entries }));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function decodeIndex(data: ArrayBuffer): SearchEntry[] | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as {
      v?: number;
      entries?: SearchEntry[];
    };
    if (parsed.v !== INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

/**
 * Whether a sealed index still holds every searchable message below its
 * lastLamport, so that bringing it current takes only the rows from there
 * up. Checked on CLEAR fields alone.
 *
 * Messages below it do arrive: a repair sync backfills OLDER history, which
 * moves no high-water mark at all. So the row records how many rows sat
 * below lastLamport when it was written, and the database counts them again
 * now. A row an older build wrote has no such count; it is checked the old
 * way, against every row of the room, once, and written back with one.
 */
async function coversBelow(
  roomCode: string,
  record: SearchIndexRecord,
  stored: SearchEntry[]
): Promise<boolean> {
  if (typeof record.rowsBelow === "number") {
    return (await countRowsBelow(roomCode, record.lastLamport)) === record.rowsBelow;
  }
  const stats = await getSearchableStats(roomCode, SEARCHABLE_TYPES, record.lastLamport);
  let storedBelow = 0;
  for (const entry of stored) if (entry.lamport < record.lastLamport) storedBelow += 1;
  return stats.countBelow === storedBelow;
}

// ── building ─────────────────────────────────────────────────────────────────

/**
 * Make a room's corpus exist and complete, streaming: entries land page by
 * page (newest first), so results render while the sweep still runs. Safe
 * to call repeatedly.
 */
export async function ensureRoomCorpus(roomCode: string): Promise<void> {
  ensureHook();
  const c = corpusFor(roomCode);
  if (c.done || c.sweeping) return;
  c.sweeping = true;
  try {
    // A sealed index is one decrypt for the whole room. When nothing has
    // been stored underneath it since it was written, the rows from its
    // lastLamport up are all it lacks, and they are all that is read: a
    // room that merely kept talking is topped up, not swept again.
    const record = await getSearchIndex(roomCode);
    const stored = record ? decodeIndex(record.data) : null;
    if (record && stored && (await coversBelow(roomCode, record, stored))) {
      for (const entry of stored) add(c, entry);
      // Searchable now, while the newer rows are read.
      bump();
      const since = await getSearchableSince(
        roomCode,
        record.lastLamport,
        SEARCHABLE_TYPES,
        c.ids
      );
      for (const msg of since) {
        const entry = entryFromMessage(msg, pluginNameOf);
        if (entry && add(c, entry)) c.dirty = true;
      }
      if (typeof record.rowsBelow !== "number") c.dirty = true;
      c.done = true;
      bumpNow();
      if (c.dirty) scheduleSave();
      return;
    }

    // Full sweep, newest-first, through the same paged read the chat uses.
    let before: Pick<Message, "lamport" | "id"> | undefined = undefined;
    for (;;) {
      const page = { capped: false };
      const msgs: Message[] = await getMessages(roomCode, before, page);
      if (!msgs.length) break;
      for (const msg of msgs) {
        const entry = entryFromMessage(msg, pluginNameOf);
        if (entry) add(c, entry);
      }
      bump();
      if (!page.capped) break;
      before = msgs[0];
    }
    c.done = true;
    bumpNow();

    // The room may have been deleted while the sweep read it - its corpus
    // object is dropped then, and writing would resurrect its index.
    if (_rooms.get(roomCode) !== c) return;

    // Persist what the sweep learned so the NEXT session pays one decrypt.
    // Live appends that raced the sweep are in the corpus already; write
    // the corpus, not the page list.
    await saveIndex(roomCode, c);
  } catch (err) {
    console.warn("[search] corpus sweep failed:", err);
  } finally {
    c.sweeping = false;
  }
}

// ── querying ─────────────────────────────────────────────────────────────────

export interface ScopeProgress {
  /** Rooms still sweeping. */
  sweeping: number;
  /** Oldest timestamp covered so far, or null before anything landed. */
  sweptTo: number | null;
  done: boolean;
}

/** Match a query against the corpora of the given rooms. Reads
 *  corpusState.version so deriveds recompute as sweeps stream in. */
export function searchRooms(
  q: SearchQuery,
  roomCodes: readonly string[],
  limit = 80,
  nowMs = Date.now()
): SearchHit[] {
  void corpusState.version;
  const lists: SearchEntry[][] = [];
  for (const roomCode of roomCodes) {
    const c = _rooms.get(roomCode);
    if (c) lists.push(c.entries);
  }
  return searchEntries(lists, q, limit, nowMs);
}

export function scopeProgress(roomCodes: readonly string[]): ScopeProgress {
  void corpusState.version;
  let sweeping = 0;
  let sweptTo: number | null = null;
  // An empty scope (no rooms at all, or an in: filter matching none) has
  // nothing left to sweep - it is done, not forever "searching".
  let done = true;
  for (const roomCode of roomCodes) {
    const c = _rooms.get(roomCode);
    if (!c || !c.done) done = false;
    if (c?.sweeping) sweeping += 1;
    if (c?.sweptTo !== null && c?.sweptTo !== undefined)
      sweptTo = sweptTo === null ? c.sweptTo : Math.min(sweptTo, c.sweptTo);
  }
  return { sweeping, sweptTo, done };
}

/** A room was deleted: drop its corpus, and with it any index write still
 *  to come (the identity checks above). The sealed row itself is deleted
 *  by deleteMessagesForRoom. */
export function dropRoomCorpus(roomCode: string): void {
  _rooms.delete(roomCode);
  bumpNow();
}

/** Session teardown: identity switch or disconnect. Memory only - the
 *  sealed rows stay, unreadable to any other identity's key, and what had
 *  not been written yet is read from storage the next time it is searched. */
export function clearSearchCorpus(): void {
  _rooms.clear();
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    _saveDue = Infinity;
  }
  bumpNow();
}
