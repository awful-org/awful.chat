import {
  deleteMessagesForRoom,
  getAllRooms,
  getDMRooms,
  putRoom,
  deleteRoom,
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

export async function refreshUnreadCount(roomCode: string): Promise<void> {
  // unreadCounts is the ROOM counter. DM conversations are counted separately,
  // against roomsStore.dmRooms, and anything filed here is also added to that
  // total - so a dm- code landing in this map is counted twice by every
  // consumer that sums the whole thing.
  //
  // Worth stating because it is easy to reintroduce: DM records live in the
  // same storage as rooms, so the getRoom fallback below happily resolves one.
  // The callers cannot help: a DM file, a DM plugin card and a DM history
  // repair all arrive through the room paths carrying a dm- roomCode.
  if (roomCode.startsWith("dm-")) return;
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
 * meant a second sweep silently kept stale counts.
 */
async function _refreshAllUnread(): Promise<void> {
  const before = roomsStore.rooms.map((r) => r.lastSeenLamport);
  const counts = await Promise.all(
    roomsStore.rooms.map((r) =>
      getUnreadCount(r.roomCode, r.lastSeenLamport, selfSenderId())
    )
  );
  const merged = new Map(roomsStore.unreadCounts);
  roomsStore.rooms.forEach((room, i) => {
    // Same staleness rule as refreshUnreadCount: if markSeen moved the
    // watermark while the sweep was in flight, this count would relight the
    // badge on a room being read.
    if (room.lastSeenLamport !== before[i]) return;
    merged.set(room.roomCode, counts[i]);
  });
  roomsStore.unreadCounts = merged;
}

export async function saveRoom(roomCode: string, name: string): Promise<void> {
  // Check the DATABASE, not the in-memory mirror: on a deep-link join the
  // mirror can still be empty while loadRooms() is in flight, and recreating
  // the record here wiped its name, watermark and member list.
  const stored = await getRoom(roomCode);
  if (stored) {
    if (!roomsStore.rooms.some((r) => r.roomCode === roomCode)) {
      roomsStore.rooms = [...roomsStore.rooms, stored];
    }
    return;
  }

  const room: Room = {
    roomCode,
    name,
    type: "text",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: [],
    participantLastSeen: {},
  };

  await putRoom(room);
  if (!roomsStore.rooms.some((r) => r.roomCode === roomCode)) {
    roomsStore.rooms = [...roomsStore.rooms, room];
  }
}

/**
 * Persist a room name learned from a peer (or set locally).
 * Without this a name broadcast only lived in transportState, so the sidebar
 * and the next join still showed the raw room code.
 */
export async function renameRoom(
  roomCode: string,
  name: string
): Promise<void> {
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed || trimmed === roomCode) return;
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx === -1) return;
  if (roomsStore.rooms[idx].name === trimmed) return;
  // Patch the STORED record: the mirror is refreshed rarely, and writing a
  // whole room from it rolled back participants and the seen watermark that
  // other writers had advanced since page load (evicting members days early).
  const stored = await getRoom(roomCode);
  if (!stored) return;
  const updated = { ...stored, name: trimmed };
  roomsStore.rooms[idx] = updated;
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
  await deleteMessagesForRoom(roomCode);
  await deleteRoom(roomCode);
  roomsStore.rooms = roomsStore.rooms.filter((r) => r.roomCode !== roomCode);
  const unread = new Map(roomsStore.unreadCounts);
  unread.delete(roomCode);
  roomsStore.unreadCounts = unread;
  const activity = new Map(roomsStore.lastActivity);
  activity.delete(roomCode);
  roomsStore.lastActivity = activity;
}
