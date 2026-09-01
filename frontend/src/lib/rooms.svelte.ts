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
  type DMRoom,
  type PhonebookEntry,
  type Room,
} from "./storage";
import { identityStore } from "./identity/identity.svelte";
import { normalizeAvatarUrl, normalizeRoomEmoji } from "./utils";
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
    await _applyPendingMeta(roomCode);
    return;
  }

  // Seed ourselves as a member. joinRoom's own addRoomParticipant(self) call
  // runs BEFORE this record exists - AppView creates it only once the join has
  // resolved - and _patchRoom is a no-op on a missing row, so on a FIRST join
  // our membership was never written down and only a second join repaired it.
  const self = selfSenderId();
  const now = Date.now();
  const room: Room = {
    roomCode,
    name,
    type: "text",
    lastSeenLamport: 0,
    createdAt: now,
    participants: self ? [self] : [],
    participantLastSeen: self ? { [self]: now } : {},
  };

  await putRoom(room);
  if (!roomsStore.rooms.some((r) => r.roomCode === roomCode)) {
    roomsStore.rooms = [...roomsStore.rooms, room];
  }
  // A peer's answer to our join can land before this record existed.
  await _applyPendingMeta(roomCode);
}

async function _applyPendingMeta(roomCode: string): Promise<void> {
  const pending = _pendingMeta.get(roomCode);
  if (!pending) return;
  _pendingMeta.delete(roomCode);
  if (pending.name) await renameRoom(roomCode, pending.name);
  if (pending.icon) await setRoomIcon(roomCode, pending.icon);
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
  // A peer that joined from a bare invite link has no name yet and sends the
  // room code as a placeholder; accepting it would blank the real name.
  if (!trimmed || trimmed === roomCode) return;
  // Storage is the authority, not the mirror. A peer answers a join with the
  // room's name the instant it sees the announcement, which routinely beats the
  // joiner's own saveRoom(); keying off the mirror dropped that name for good -
  // the header took it from transportState and looked right, while the sidebar
  // and every later reload kept showing the raw room code.
  const stored = await getRoom(roomCode);
  if (!stored) {
    _remember(roomCode, { name: trimmed });
    return;
  }
  if (stored.name === trimmed) return;
  // Patch the STORED record: the mirror is refreshed rarely, and writing a
  // whole room from it rolled back participants and the seen watermark that
  // other writers had advanced since page load (evicting members days early).
  const updated = { ...stored, name: trimmed };
  await putRoom(updated);
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) roomsStore.rooms[idx] = updated;
}

/**
 * A room's icon: one emoji, or one image/GIF URL. Both fields optional so the
 * wire and the pickers can share the shape; `null` at a call site means "no
 * icon". A url wins over an emoji when a caller somehow supplies both.
 */
export interface RoomIcon {
  emoji?: string | null;
  url?: string | null;
}

/**
 * Persist a room icon, set locally or learned from a peer.
 *
 * The two forms are mutually exclusive, as they are for a profile avatar: a
 * room shows a glyph or a picture, so setting one clears the other. Without
 * that an old emoji kept rendering underneath a newly picked GIF.
 */
export async function setRoomIcon(
  roomCode: string,
  icon: RoomIcon | null
): Promise<void> {
  const url = normalizeAvatarUrl(icon?.url);
  const emoji = url ? undefined : normalizeRoomEmoji(icon?.emoji);
  // Storage is the authority, not the mirror. A peer answers a join with the
  // room's icon the instant it sees the announcement, which routinely beats the
  // joiner's own saveRoom(); keying off the mirror dropped that icon and left
  // the room bare until something happened to resend. Hold it instead, and let
  // saveRoom apply it the moment the record exists.
  const stored = await getRoom(roomCode);
  if (!stored) {
    // Only something worth replaying. A clear for a room we do not have, and
    // junk that failed sanitizing, both mean "no icon" - which is already true.
    if (emoji || url) _remember(roomCode, { icon: { emoji, url } });
    return;
  }
  if (stored.emoji === emoji && stored.pfpURL === url) return;
  // Patch the STORED record for the same reason renameRoom does: the mirror is
  // refreshed rarely, and writing a whole room from it rolls back participants
  // and the seen watermark that other writers have advanced since page load.
  //
  // pfpData is the legacy byte form; an icon is always carried as a URL, so it
  // has to go too or a stale upload would outrank the new icon on render.
  const updated = { ...stored, emoji, pfpURL: url, pfpData: undefined };
  await putRoom(updated);
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) roomsStore.rooms[idx] = updated;
}

/**
 * Room metadata that arrived for a room this device has not created yet,
 * replayed by saveRoom.
 *
 * Both halves need this. A peer answers a join announcement the instant it sees
 * one, and that answer routinely beats the joiner's own record being written -
 * so without holding it, a room kept the raw code for a name and no icon at
 * all, permanently, because nothing resends either.
 *
 * Bounded: an unknown room code costs one entry, and a peer must not be able to
 * make us hold metadata without limit.
 */
interface PendingMeta {
  name?: string;
  icon?: RoomIcon;
}
const MAX_PENDING_META = 16;
const _pendingMeta = new Map<string, PendingMeta>();

function _remember(roomCode: string, patch: PendingMeta): void {
  const held = _pendingMeta.get(roomCode);
  if (!held && _pendingMeta.size >= MAX_PENDING_META) return;
  _pendingMeta.set(roomCode, { ...held, ...patch });
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
  // Held metadata for this room is stale now; a rejoin gets it fresh.
  _pendingMeta.delete(roomCode);
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
