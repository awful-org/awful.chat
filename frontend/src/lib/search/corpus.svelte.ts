/**
 * The in-memory search corpus: per-room decrypted entries, built lazily the
 * first time a scope is searched and kept current by the message-stored
 * hook. Plaintext lives ONLY here; what persists is the sealed per-room
 * index row (see STORE_SPECS.searchIndex), which turns the next session's
 * rebuild from one decrypt per message into one per room.
 */
import {
  getMessages,
  getSearchableStats,
  getSearchIndex,
  onMessageStored,
  putSearchIndex,
} from "$lib/storage";
import {
  MessageType,
  type ChatMessageType,
  type Message,
} from "$lib/types/message";
import { getManifest } from "$lib/plugins/registry";
import {
  entryFromMessage,
  matchEntry,
  rankHits,
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
}

const _rooms = new Map<string, RoomCorpus>();

/** Bumped whenever any corpus grows; the overlay re-derives results on it. */
export const corpusState = $state({ version: 0 });

function bump(): void {
  corpusState.version += 1;
}

function pluginNameOf(pluginId: string): string | undefined {
  return getManifest(pluginId)?.name;
}

function corpusFor(roomCode: string): RoomCorpus {
  let c = _rooms.get(roomCode);
  if (!c) {
    c = { entries: [], ids: new Set(), sweptTo: null, done: false, sweeping: false };
    _rooms.set(roomCode, c);
  }
  return c;
}

function add(c: RoomCorpus, entry: SearchEntry): void {
  if (c.ids.has(entry.id)) return;
  c.ids.add(entry.id);
  c.entries.push(entry);
  if (c.sweptTo === null || entry.timestamp < c.sweptTo)
    c.sweptTo = entry.timestamp;
}

// ── live append ──────────────────────────────────────────────────────────────

let _hooked = false;
/** Rooms with sealed-index appends waiting to flush. */
const _pendingIndex = new Map<string, SearchEntry[]>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureHook(): void {
  if (_hooked) return;
  _hooked = true;
  onMessageStored((msg) => {
    const entry = entryFromMessage(msg, pluginNameOf);
    if (!entry) return;
    const c = _rooms.get(entry.roomCode);
    if (c && !c.ids.has(entry.id)) {
      add(c, entry);
      bump();
    }
    // The sealed index is appended out-of-band and debounced: sync batches
    // pour hundreds of rows, and a read-modify-write per row would swamp
    // the very writes it rides on.
    const pending = _pendingIndex.get(entry.roomCode) ?? [];
    pending.push(entry);
    _pendingIndex.set(entry.roomCode, pending);
    if (!_flushTimer) _flushTimer = setTimeout(() => void flushIndexAppends(), 3000);
  });
}

async function flushIndexAppends(): Promise<void> {
  _flushTimer = null;
  const batches = [...(_pendingIndex.entries())];
  _pendingIndex.clear();
  for (const [roomCode, entries] of batches) {
    // A sweep in flight will write the full index itself; re-queue nothing.
    const c = _rooms.get(roomCode);
    if (c?.sweeping) continue;
    try {
      const record = await getSearchIndex(roomCode);
      // No index yet: the first sweep writes it whole. Appending here would
      // create a row whose lastLamport lies about everything before it.
      if (!record) continue;
      const stored = decodeIndex(record.data);
      if (!stored) continue;
      const known = new Set(stored.map((e) => e.id));
      let last = record.lastLamport;
      let changed = false;
      for (const entry of entries) {
        if (known.has(entry.id)) continue;
        stored.push(entry);
        known.add(entry.id);
        last = Math.max(last, entry.lamport);
        changed = true;
      }
      if (changed)
        await putSearchIndex({ roomCode, lastLamport: last, data: encodeIndex(stored) });
    } catch (err) {
      console.warn("[search] index append failed:", err);
    }
  }
}

// ── sealed index (de)serialization ───────────────────────────────────────────

function encodeIndex(entries: SearchEntry[]): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, entries }));
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
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

// ── building ─────────────────────────────────────────────────────────────────

/**
 * Make a room's corpus exist and complete, streaming: entries land page by
 * page (newest first) with a version bump each, so results render while
 * the sweep still runs. Safe to call repeatedly.
 */
export async function ensureRoomCorpus(roomCode: string): Promise<void> {
  ensureHook();
  const c = corpusFor(roomCode);
  if (c.done || c.sweeping) return;
  c.sweeping = true;
  try {
    // Fast path: a sealed index that is provably current, checked against
    // CLEAR fields only (one decrypt instead of the room). Two conditions,
    // both load-bearing: lastLamport catches ordinary new messages, and the
    // entry count catches backfilled OLDER ones - a repair sync moves no
    // high-water mark, so a lamport check alone would bless an index that
    // lost its debounced append to a crash and never notice.
    const [record, stats] = await Promise.all([
      getSearchIndex(roomCode),
      getSearchableStats(roomCode, SEARCHABLE_TYPES),
    ]);
    if (record && record.lastLamport >= stats.newestLamport) {
      const stored = decodeIndex(record.data);
      if (stored && stored.length === stats.count) {
        for (const entry of stored) add(c, entry);
        c.done = true;
        bump();
        return;
      }
    }

    // Full sweep, newest-first, through the same paged read the chat uses.
    let before: Pick<Message, "lamport" | "id"> | undefined = undefined;
    let lastLamport = 0;
    for (;;) {
      const page = { capped: false };
      const msgs: Message[] = await getMessages(roomCode, before, page);
      if (!msgs.length) break;
      for (const msg of msgs) {
        const entry = entryFromMessage(msg, pluginNameOf);
        if (entry) {
          add(c, entry);
          lastLamport = Math.max(lastLamport, entry.lamport);
        }
      }
      bump();
      if (!page.capped) break;
      before = msgs[0];
    }
    c.done = true;
    bump();

    // The room may have been deleted while the sweep read it - its corpus
    // object is dropped then, so a stale identity means this write would
    // resurrect an index row for a room whose messages are gone.
    if (_rooms.get(roomCode) !== c) return;

    // Persist what the sweep learned so the NEXT session pays one decrypt.
    // Live appends that raced the sweep are in the corpus already; write
    // the corpus, not the page list.
    await putSearchIndex({
      roomCode,
      lastLamport: Math.max(
        lastLamport,
        ...c.entries.map((e) => e.lamport)
      ),
      data: encodeIndex(c.entries),
    });
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
  const hits: SearchHit[] = [];
  for (const roomCode of roomCodes) {
    const c = _rooms.get(roomCode);
    if (!c) continue;
    for (const entry of c.entries) {
      const hit = matchEntry(entry, q, nowMs);
      if (hit) hits.push(hit);
    }
  }
  return rankHits(hits, limit);
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

/** A room was deleted: drop its corpus and pending appends, and invalidate
 *  any in-flight sweep's final index write (identity check above). The
 *  sealed row itself is deleted by deleteMessagesForRoom. */
export function dropRoomCorpus(roomCode: string): void {
  _rooms.delete(roomCode);
  _pendingIndex.delete(roomCode);
  bump();
}

/** Session teardown: identity switch or disconnect. Memory only - the
 *  sealed rows stay, unreadable to any other identity's key. */
export function clearSearchCorpus(): void {
  _rooms.clear();
  _pendingIndex.clear();
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  bump();
}
