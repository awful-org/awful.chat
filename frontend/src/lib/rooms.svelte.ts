import {
  deleteMessagesForRoom,
  getAllRooms,
  getDMRooms,
  putRoom,
  deleteRoom,
  deleteRoomProfilesForRoom,
  getRoomDeletionMarker,
  getChannelUnreadCounts,
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
import { blockedDids, isBlockedDid, loadBlocks } from "./blocks.svelte";
import { findLiveChannel, liveChannels, type Channel, type ChannelKind } from "./channels";
import { currentChannelOf, forgetCurrentChannel } from "./channel-view.svelte";

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
  /**
   * Conversations with someone soft-blocked: kept out of dmRooms (no joins,
   * no unread, no search), but still listed, greyed, so the block can be
   * found and lifted where the conversation was.
   */
  blockedDmRooms: DMRoom[];
  phonebook: PhonebookEntry[];
  loading: boolean;
  unreadCounts: Map<string, number>;
  /**
   * roomCode -> channel id -> unread, for rooms counted since load: "" is
   * the original chat. unreadCounts is always the sum of a room's entries
   * here, so the sidebar's room total and a channel list's badges agree.
   */
  channelUnread: Map<string, Map<string, number>>;
  /** roomCode -> timestamp of the newest message from anyone. */
  lastActivity: Map<string, number>;
}

export const roomsStore = $state<RoomsStore>({
  rooms: [],
  dmRooms: [],
  blockedDmRooms: [],
  phonebook: [],
  loading: false,
  unreadCounts: new Map(),
  channelUnread: new Map(),
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
    await loadDmLists();
    roomsStore.phonebook = await getPhonebookEntries();
    await _refreshAllUnread();
    await _refreshAllActivity();
  } finally {
    roomsStore.loading = false;
  }
}

/**
 * The DMs the list shows: a soft-blocked person's conversation is set aside,
 * not deleted. The block list is read first - on unlock this runs beside
 * connect(), and filtering against a list not read yet showed a blocked
 * person's conversation until something refreshed it.
 */
async function loadDmLists(): Promise<void> {
  await loadBlocks().catch(() => {});
  const rooms = await getDMRooms();
  // Both lists from the one read, set together, so a conversation is never
  // in both or in neither between two refreshes.
  roomsStore.dmRooms = rooms.filter((r) => !isBlockedDid(r.participantDid));
  roomsStore.blockedDmRooms = rooms.filter((r) => isBlockedDid(r.participantDid));
}

export async function refreshPhonebook(): Promise<void> {
  roomsStore.phonebook = await getPhonebookEntries();
}

export async function refreshDmRooms(): Promise<void> {
  await loadDmLists();
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
  rows: ReadonlyArray<{ id: string; senderId: string; lamport: number; type: string; channel?: string }>
): void {
  if (roomCode.startsWith("dm-")) return;
  const self = selfSenderId();
  const fresh = rows.filter(
    (m) =>
      m.type !== MessageType.Reaction &&
      m.type !== MessageType.PluginUpdate &&
      (!self || m.senderId !== self) &&
      // Soft-blocked: folded in the view and silent, so not unread either.
      !isBlockedDid(m.senderId) &&
      _firstSighting(m.id)
  );
  if (!fresh.length) return;
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (!room || !_counted.has(roomCode) || _recounts.has(roomCode)) {
    void refreshUnreadCount(roomCode).catch(() => {});
    return;
  }
  // Each against its own channel's mark. A row in a channel the list does
  // not hold (deleted, or not heard of yet) is in no count, the same rule
  // the recount applies (storage.ts getChannelUnreadCounts).
  const live = new Set(liveChannels(room.channels ?? [], "text").map((c) => c.id));
  const byChannel = new Map<string, number>();
  for (const m of fresh) {
    const channel = m.channel ?? "";
    if (!live.has(channel)) continue;
    const mark = channel ? room.channelSeen?.[channel] ?? 0 : room.lastSeenLamport;
    if (m.lamport > mark) byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1);
  }
  if (!byChannel.size) return;
  const breakdown = new Map(roomsStore.channelUnread.get(roomCode) ?? []);
  let added = 0;
  for (const [channel, n] of byChannel) {
    breakdown.set(channel, (breakdown.get(channel) ?? 0) + n);
    added += n;
  }
  _setBreakdown(roomCode, breakdown, (roomsStore.unreadCounts.get(roomCode) ?? 0) + added);
}

/** Put a room's per-channel counts and its total in place together. */
function _setBreakdown(roomCode: string, breakdown: Map<string, number>, total: number): void {
  const channels = new Map(roomsStore.channelUnread);
  channels.set(roomCode, breakdown);
  roomsStore.channelUnread = channels;
  if (roomsStore.unreadCounts.get(roomCode) === total) return;
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, total);
  roomsStore.unreadCounts = next;
}

/**
 * The user read a channel of the room (the original chat by default) up to
 * what is on screen. The room's total keeps every other channel's count.
 */
export function noteRoomRead(roomCode: string, channel = ""): void {
  _counted.delete(roomCode);
  const held = roomsStore.channelUnread.get(roomCode);
  if (!held) {
    // Never counted per channel: what the room total was is all there is,
    // and in a room without channels it is all the original chat's.
    if (roomsStore.unreadCounts.get(roomCode) === 0) return;
    const next = new Map(roomsStore.unreadCounts);
    next.set(roomCode, 0);
    roomsStore.unreadCounts = next;
    return;
  }
  if ((held.get(channel) ?? 0) === 0 && roomsStore.unreadCounts.has(roomCode)) return;
  const breakdown = new Map(held);
  breakdown.set(channel, 0);
  let total = 0;
  for (const n of breakdown.values()) total += n;
  _setBreakdown(roomCode, breakdown, total);
}

/** Unread messages in one channel of a room ("" is the original chat). */
export function channelUnreadCount(roomCode: string, channel: string): number {
  return roomsStore.channelUnread.get(roomCode)?.get(channel) ?? 0;
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
  // Every live text channel, each against its own mark; the original chat
  // against lastSeenLamport. A room without channels is one read of the
  // rows above lastSeenLamport, counted as it always was.
  const channels: Record<string, number> = {};
  for (const c of liveChannels(room.channels ?? [], "text")) {
    if (c.id) channels[c.id] = room.channelSeen?.[c.id] ?? 0;
  }
  const counts = await getChannelUnreadCounts(
    roomCode,
    { base: room.lastSeenLamport, channels },
    selfSenderId(),
    blockedDids()
  );
  // If markSeen advanced a mark while the count was in flight, this result
  // is stale - writing it would relight the badge on a channel the user is
  // reading. Drop it; the next event recomputes. A room still absent from
  // the mirror cannot have been read through it, so it keeps its count.
  // The list too: a channel made or deleted meanwhile is counted next time.
  const now = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (now && _marksMoved(room, now)) return;
  _counted.add(roomCode);
  let count = 0;
  for (const n of counts.values()) count += n;
  // Only when it changed: every consumer of the map - the sidebar, the tab
  // title, the app badge - recomputes on a new one.
  const held = roomsStore.channelUnread.get(roomCode);
  if (held && held.size === counts.size && [...counts].every(([c, n]) => held.get(c) === n) &&
      roomsStore.unreadCounts.get(roomCode) === count) return;
  _setBreakdown(roomCode, counts, count);
}

/** Whether a room's read marks or channel list differ between two copies of it. */
function _marksMoved(before: Room, after: Room): boolean {
  if (after.lastSeenLamport !== before.lastSeenLamport) return true;
  if (JSON.stringify(after.channels ?? []) !== JSON.stringify(before.channels ?? [])) return true;
  const a = before.channelSeen ?? {};
  const b = after.channelSeen ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return true;
  return false;
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

/** Recount every room: who counts changed (a block, or one lifted). */
export function refreshAllUnreadCounts(): Promise<void> {
  return _refreshAllUnread();
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

/**
 * This user's pinned messages in a room or DM, oldest pin first: those of
 * one channel, the one open in the room unless another is named. A DM has
 * only its one chat.
 */
export function pinnedMessagesOf(roomCode: string, channel = currentChannelOf(roomCode)): string[] {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (room) return (channel ? room.channelPins?.[channel] : room.pinnedMessages) ?? [];
  return roomsStore.dmRooms.find((r) => r.roomCode === roomCode)?.pinnedMessages ?? [];
}

/**
 * Pin a message for yourself in its room or DM, or unpin it. Filed under
 * the channel the message is in - the one open, unless another is named.
 */
export async function toggleMessagePin(
  roomCode: string,
  messageId: string,
  channel = currentChannelOf(roomCode)
): Promise<void> {
  if (roomCode.startsWith("dm-")) channel = "";
  const pinned = !pinnedMessagesOf(roomCode, channel).includes(messageId);
  const toggle = (current: string[]) =>
    pinned ? [...current, messageId] : current.filter((id) => id !== messageId);
  const apply = <T extends Room>(r: T): T => {
    if (r.roomCode !== roomCode) return r;
    if (!channel) return { ...r, pinnedMessages: toggle(r.pinnedMessages ?? []) };
    return {
      ...r,
      channelPins: { ...(r.channelPins ?? {}), [channel]: toggle(r.channelPins?.[channel] ?? []) },
    };
  };
  roomsStore.rooms = roomsStore.rooms.map(apply);
  roomsStore.dmRooms = roomsStore.dmRooms.map(apply);
  await setMessagePinned(roomCode, messageId, pinned, channel);
}

// ── channels (channels.ts) ───────────────────────────────────────────────────

/**
 * A room's channels as the UI lists them: live ones only, the original
 * first, then by position. Of one kind, or every text channel then every
 * voice channel. Reactive: it reads the sidebar's mirror of the rooms.
 */
export function roomChannels(roomCode: string, kind?: ChannelKind): Channel[] {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  return liveChannels(room?.channels ?? [], kind);
}

/** The live channel with this id in a room, or undefined (deleted, unknown). */
export function roomChannel(roomCode: string, id: string, kind: ChannelKind = "text"): Channel | undefined {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  return findLiveChannel(room?.channels ?? [], id, kind);
}

/**
 * Put a room's merged channel list in the mirror (storage already holds it).
 * Its unread counts are counted again: a channel that came or went changes
 * which rows count.
 */
export function noteRoomChannels(roomCode: string, channels: Channel[]): void {
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx === -1) return;
  roomsStore.rooms[idx] = { ...roomsStore.rooms[idx], channels };
  void refreshUnreadCount(roomCode).catch(() => {});
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
  forgetCurrentChannel(roomCode);
  const unread = new Map(roomsStore.unreadCounts);
  unread.delete(roomCode);
  roomsStore.unreadCounts = unread;
  const channels = new Map(roomsStore.channelUnread);
  channels.delete(roomCode);
  roomsStore.channelUnread = channels;
  const activity = new Map(roomsStore.lastActivity);
  activity.delete(roomCode);
  roomsStore.lastActivity = activity;
}
