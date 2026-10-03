import {
  deleteMessagesForRoom,
  getAllRooms,
  getDMRooms,
  putRoom,
  deleteRoom,
  deleteRoomProfilesForRoom,
  getRoomDeletionMarker,
  getUnreadCount,
  getLastMessage,
  getRoom,
  getMessages,
  getPhonebookEntries,
  dedupePhonebook,
  setRoomPinned,
  setRoomPositions,
  setMessagePinned,
  type DMRoom,
  type PhonebookEntry,
  type Room,
} from "./storage";
import { identityStore } from "./identity/identity.svelte";
import { dropRoomCorpus } from "./search/corpus.svelte";
import { MessageType } from "./types/message";

/**
 * Your own messages must never count as unread - they arrive back through
 * sync (another device, or a peer replaying history) with a lamport above your
 * last-seen mark and would otherwise light up a badge for something you wrote.
 * The DM counters already do this; rooms need the same.
 */
function selfSenderId(): string | undefined {
  return identityStore.did ?? undefined;
}

interface RoomsStore {
  rooms: Room[];
  dmRooms: DMRoom[];
  phonebook: PhonebookEntry[];
  loading: boolean;
  unreadCounts: Map<string, number>;
  /** roomCode -> timestamp of the newest message from anyone. */
  lastActivity: Map<string, number>;
}

export const roomsStore = $state<RoomsStore>({
  rooms: [],
  dmRooms: [],
  phonebook: [],
  loading: false,
  unreadCounts: new Map(),
  lastActivity: new Map(),
});

/**
 * Record that a room saw a message, whoever sent it.
 * The sidebar used to show room.createdAt, so the "x minutes ago" line never
 * moved no matter how much was said in the room.
 */
export function noteRoomActivity(roomCode: string, timestamp: number): void {
  if (!roomCode || !timestamp) return;
  if ((roomsStore.lastActivity.get(roomCode) ?? 0) >= timestamp) return;
  const next = new Map(roomsStore.lastActivity);
  next.set(roomCode, timestamp);
  roomsStore.lastActivity = next;
}

let _phonebookDeduped = false;

export async function loadRooms(): Promise<void> {
  roomsStore.loading = true;
  try {
    if (!_phonebookDeduped) {
      _phonebookDeduped = true;
      // One pass per session: merge duplicate contacts left behind by the
      // old form-dependent keying before anything reads the list.
      await dedupePhonebook().catch(() => {});
    }
    const all = await getAllRooms();
    const freshRooms = all.filter((r) => r.type !== "dm") as Room[];
    const merged = new Map<string, Room>();
    for (const r of roomsStore.rooms) {
      merged.set(r.roomCode, r);
    }
    for (const r of freshRooms) {
      merged.set(r.roomCode, r);
    }
    roomsStore.rooms = Array.from(merged.values());
    await migrateLegacyRoomOrder();
    roomsStore.dmRooms = await getDMRooms();
    roomsStore.phonebook = await getPhonebookEntries();
    await _refreshAllUnread();
    await _refreshAllActivity();
  } finally {
    roomsStore.loading = false;
  }
}

export async function refreshPhonebook(): Promise<void> {
  roomsStore.phonebook = await getPhonebookEntries();
}

export async function refreshDmRooms(): Promise<void> {
  roomsStore.dmRooms = await getDMRooms();
}

/**
 * Rooms whose count is a base new rows can be added to: recounted from
 * storage since the user last read them. Reading a room drops it, so the
 * next arrival counts from storage again - a row that arrived while the room
 * was open but never reached the screen is still unread.
 */
const _counted = new Set<string>();
/** Recounts in flight, and whether another was asked for meanwhile. */
const _recounts = new Map<string, { again: boolean; done: Promise<void> }>();
/**
 * Rows already counted, by id: the live frame and its direct copy, or two
 * pushers, can store the same row at once, and it is one unread message.
 */
const COUNTED_IDS_MAX = 2048;
const _countedIds = new Set<string>();

function _firstSighting(id: string): boolean {
  if (_countedIds.has(id)) return false;
  _countedIds.add(id);
  if (_countedIds.size > COUNTED_IDS_MAX) {
    _countedIds.delete(_countedIds.values().next().value as string);
  }
  return true;
}

/**
 * Rows just stored for a room: add the ones that count to its unread total.
 *
 * Every incoming message used to recount its room from storage, reading the
 * whole unread backlog off IndexedDB - a room left unread for a week cost a
 * read of thousands of rows per message, and a 20-row sync batch its own read
 * each. Rows that count are new messages from someone else above the read
 * mark; the stored count only grows by them. Where there is no base to add
 * to, the room is counted from storage, which already holds these rows.
 */
export function noteUnreadArrivals(
  roomCode: string,
  rows: ReadonlyArray<{ id: string; senderId: string; lamport: number; type: string }>
): void {
  if (roomCode.startsWith("dm-")) return;
  const self = selfSenderId();
  const fresh = rows.filter(
    (m) =>
      m.type !== MessageType.Reaction &&
      m.type !== MessageType.PluginUpdate &&
      (!self || m.senderId !== self) &&
      _firstSighting(m.id)
  );
  if (!fresh.length) return;
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (!room || !_counted.has(roomCode) || _recounts.has(roomCode)) {
    void refreshUnreadCount(roomCode).catch(() => {});
    return;
  }
  const added = fresh.filter((m) => m.lamport > room.lastSeenLamport).length;
  if (!added) return;
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, (next.get(roomCode) ?? 0) + added);
  roomsStore.unreadCounts = next;
}

/** The user read the room up to what is on screen. */
export function noteRoomRead(roomCode: string): void {
  _counted.delete(roomCode);
  if (roomsStore.unreadCounts.get(roomCode) === 0) return;
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, 0);
  roomsStore.unreadCounts = next;
}

/**
 * Count a room's unread rows from storage. One at a time per room: a call
 * while one is in flight asks it for another pass instead, and settles with
 * it.
 */
export function refreshUnreadCount(roomCode: string): Promise<void> {
  // unreadCounts is the ROOM counter. DM conversations are counted separately,
  // against roomsStore.dmRooms, and anything filed here is also added to that
  // total - so a dm- code landing in this map is counted twice by every
  // consumer that sums the whole thing.
  //
  // Worth stating because it is easy to reintroduce: DM records live in the
  // same storage as rooms, so the getRoom fallback below happily resolves one.
  // The callers cannot help: a DM file, a DM plugin card and a DM history
  // repair all arrive through the room paths carrying a dm- roomCode.
  if (roomCode.startsWith("dm-")) return Promise.resolve();
  const running = _recounts.get(roomCode);
  if (running) {
    running.again = true;
    return running.done;
  }
  const run = { again: false, done: Promise.resolve() };
  _recounts.set(roomCode, run);
  run.done = (async () => {
    try {
      do {
        run.again = false;
        await _recountUnread(roomCode);
      } while (run.again);
    } finally {
      _recounts.delete(roomCode);
    }
  })();
  return run.done;
}

async function _recountUnread(roomCode: string): Promise<void> {
  // Fall back to the database when the mirror has not caught up: a message can
  // arrive for a room whose record exists but whose sidebar entry is still in
  // flight (a deep-link join), and dropping the count there left the badge
  // dark until the next full sweep.
  const room =
    roomsStore.rooms.find((r) => r.roomCode === roomCode) ??
    (await getRoom(roomCode));
  if (!room) return;
  const count = await getUnreadCount(
    roomCode,
    room.lastSeenLamport,
    selfSenderId()
  );
  // If markSeen advanced the watermark while the count was in flight, this
  // result is stale - writing it would relight the badge on a room the user
  // is reading. Drop it; the next event recomputes. A room still absent from
  // the mirror cannot have been read through it, so it keeps its count.
  const now = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (now && now.lastSeenLamport !== room.lastSeenLamport) return;
  _counted.add(roomCode);
  // Only when it changed: every consumer of the map - the sidebar, the tab
  // title, the app badge - recomputes on a new one.
  if (roomsStore.unreadCounts.get(roomCode) === count) return;
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, count);
  roomsStore.unreadCounts = next;
}

/** Seed the last-activity map from stored history on startup. */
async function _refreshAllActivity(): Promise<void> {
  const entries = await Promise.all(
    roomsStore.rooms.map(async (r) => {
      const last = await getLastMessage(r.roomCode).catch(() => undefined);
      return [r.roomCode, last?.timestamp ?? r.createdAt] as [string, number];
    })
  );
  const merged = new Map(roomsStore.lastActivity);
  for (const [roomCode, computed] of entries) {
    const current = merged.get(roomCode) ?? 0;
    merged.set(roomCode, Math.max(current, computed));
  }
  roomsStore.lastActivity = merged;
}

/**
 * Recount every room. Authoritative, not seed-only: it counts from each room's
 * persisted watermark, which is the same source markSeen writes, so a room the
 * user has just read counts zero anyway. Skipping rooms already in the map
 * meant a second sweep silently kept stale counts. Room by room through
 * refreshUnreadCount, so a recount already running for one is asked for
 * another pass rather than raced, with the same staleness rule.
 */
async function _refreshAllUnread(): Promise<void> {
  await Promise.all(roomsStore.rooms.map((r) => refreshUnreadCount(r.roomCode)));
}

export async function saveRoom(roomCode: string, name: string, guard?: () => void): Promise<void> {
  // Check the DATABASE, not the in-memory mirror: on a deep-link join the
  // mirror can still be empty while loadRooms() is in flight, and recreating
  // the record here wiped its name, watermark and member list.
  const stored = await getRoom(roomCode);
  guard?.();
  if (stored) {
    if (!roomsStore.rooms.some((r) => r.roomCode === roomCode)) {
      roomsStore.rooms = [...roomsStore.rooms, stored];
    }
    return;
  }

  const marker = await getRoomDeletionMarker(roomCode);
  guard?.();

  const room: Room = {
    roomCode,
    name,
    type: "text",
    lastSeenLamport: 0,
    // createdAt also identifies this membership generation. An intentional
    // rejoin must outrank the leave marker even within the same millisecond.
    createdAt: Math.max(Date.now(), (marker ? Math.max(marker.generation, marker.deletedAt) : 0) + 1),
    participants: [],
    participantLastSeen: {},
  };

  await putRoom(room, guard);
  guard?.();
  if (!roomsStore.rooms.some((r) => r.roomCode === roomCode)) {
    roomsStore.rooms = [...roomsStore.rooms, room];
  }
}

/**
 * Persist a room name learned from a peer (or set locally), with when it
 * was chosen (room-name.ts). Without this a name broadcast only lived in
 * transportState, so the sidebar and the next join still showed the raw
 * room code.
 */
export async function renameRoom(
  roomCode: string,
  name: string,
  nameAt: number
): Promise<void> {
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed || trimmed === roomCode) return;
  // Not in the mirror yet (a room still being opened): the stored record
  // still takes it, and the mirror picks it up from there.
  const current = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (current && current.name === trimmed && current.nameAt === nameAt) return;
  // Patch the STORED record: the mirror is refreshed rarely, and writing a
  // whole room from it rolled back participants and the seen watermark that
  // other writers had advanced since page load (evicting members days early).
  const stored = await getRoom(roomCode);
  if (!stored) return;
  const updated = { ...stored, name: trimmed, nameAt };
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) roomsStore.rooms[idx] = updated;
  await putRoom(updated);
}

/** Pin a room to the top of the sidebar, or unpin it back into its place. */
export async function toggleRoomPin(roomCode: string): Promise<void> {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (!room) return;
  const pinnedAt = room.pinnedAt == null ? Date.now() : null;
  // The mirror first, so the sidebar moves on the click, not on the write.
  roomsStore.rooms = roomsStore.rooms.map((r) => {
    if (r.roomCode !== roomCode) return r;
    const { pinnedAt: _old, ...rest } = r;
    return pinnedAt === null ? rest : { ...rest, pinnedAt };
  });
  await setRoomPinned(roomCode, pinnedAt);
}

/** This user's pinned messages in a room or DM, oldest pin first. */
export function pinnedMessagesOf(roomCode: string): string[] {
  return (
    roomsStore.rooms.find((r) => r.roomCode === roomCode)?.pinnedMessages ??
    roomsStore.dmRooms.find((r) => r.roomCode === roomCode)?.pinnedMessages ??
    []
  );
}

/** Pin a message for yourself in its room or DM, or unpin it. */
export async function toggleMessagePin(
  roomCode: string,
  messageId: string
): Promise<void> {
  const pinned = !pinnedMessagesOf(roomCode).includes(messageId);
  const apply = <T extends Room>(r: T): T => {
    if (r.roomCode !== roomCode) return r;
    const current = r.pinnedMessages ?? [];
    return {
      ...r,
      pinnedMessages: pinned
        ? [...current, messageId]
        : current.filter((id) => id !== messageId),
    };
  };
  roomsStore.rooms = roomsStore.rooms.map(apply);
  roomsStore.dmRooms = roomsStore.dmRooms.map(apply);
  await setMessagePinned(roomCode, messageId, pinned);
}

/** The unpinned rooms' order after a sidebar drag or keyboard move. */
export async function setRoomOrder(order: string[]): Promise<void> {
  const position = new Map(order.map((code, i) => [code, i]));
  roomsStore.rooms = roomsStore.rooms.map((r) =>
    position.has(r.roomCode) ? { ...r, position: position.get(r.roomCode) } : r
  );
  await setRoomPositions(order);
}

/**
 * The order used to live in localStorage (#63), outside the account: it
 * survived an account switch with the old account's room codes in it, and
 * sync and backups never saw it. Moved onto the records once, then dropped.
 * A device whose rooms already carry positions (synced in) keeps those.
 */
const LEGACY_ORDER_KEY = "awful:room-order:v1";

async function migrateLegacyRoomOrder(): Promise<void> {
  let order: string[];
  try {
    const raw = localStorage.getItem(LEGACY_ORDER_KEY);
    if (raw === null) return;
    localStorage.removeItem(LEGACY_ORDER_KEY);
    const parsed = JSON.parse(raw);
    order = Array.isArray(parsed)
      ? parsed.filter((code): code is string => typeof code === "string")
      : [];
  } catch {
    return;
  }
  if (roomsStore.rooms.some((r) => r.position != null)) return;
  const known = new Set(roomsStore.rooms.map((r) => r.roomCode));
  const mine = order.filter((code) => known.has(code));
  if (mine.length > 0) await setRoomOrder(mine);
}

/**
 * Storage/store half of room removal. On its own this leaves the transport
 * subscribed and the history behind - use removeRoomCompletely() from
 * transport.svelte for the real thing.
 */
export async function removeRoom(roomCode: string): Promise<void> {
  // Before the storage delete: an in-flight search sweep must see the drop
  // and abandon its final index write for this room.
  dropRoomCorpus(roomCode);
  const room = await getRoom(roomCode);
  if (room?.type === "text") {
    const marker = await getRoomDeletionMarker(roomCode);
    await deleteRoomProfilesForRoom(
      roomCode,
      Math.max(Date.now(), room.createdAt, marker?.generation ?? 0) + 1,
    );
  }
  await deleteMessagesForRoom(roomCode);
  await deleteRoom(roomCode);
  roomsStore.rooms = roomsStore.rooms.filter((r) => r.roomCode !== roomCode);
  _counted.delete(roomCode);
  const unread = new Map(roomsStore.unreadCounts);
  unread.delete(roomCode);
  roomsStore.unreadCounts = unread;
  const activity = new Map(roomsStore.lastActivity);
  activity.delete(roomCode);
  roomsStore.lastActivity = activity;
}
