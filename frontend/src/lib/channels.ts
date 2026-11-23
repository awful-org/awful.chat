/**
 * Channels: Discord-like text and voice channels inside one room.
 *
 * A channel is not a room of its own. The room keeps its one transport topic,
 * its one membership and its one history sync; a chat message just carries
 * the id of the channel it was written in, and a message with no id belongs
 * to the room's original chat. So a room where nobody ever made a channel
 * behaves exactly as it did before channels existed, and an older build keeps
 * working in that original chat.
 *
 * The list of channels is shared by every member and every member may edit
 * it (rooms have no roles). It is kept the way room names are (room-name.ts):
 * each entry carries when it was last changed, the newest change to an entry
 * wins everywhere, and a member who hears an older list answers with theirs.
 * A delete is a change like any other - the entry stays, marked deleted, so a
 * member who was away cannot bring the channel back by announcing their copy.
 *
 * Pure on purpose: the transport, storage, backup merge and the UI all need
 * the same rule, and only a module with no app around it can be tested alone.
 */
import { stripWireControls } from "./wire-name";

export type ChannelKind = "text" | "voice";

export interface Channel {
  /**
   * Random, see isChannelId. The empty id is the room's original chat or
   * call; an entry with the empty id only ever renames or moves that one
   * (see DEFAULT_CHANNEL_NAMES), it never creates or deletes anything.
   */
  id: string;
  kind: ChannelKind;
  name: string;
  /**
   * Sort key among the room's channels of the same kind, lowest first. An
   * original with no entry is at 0, which is before everything else: channels
   * are made at 1 and up, and at the same position the empty id sorts first.
   */
  position: number;
  /** When this entry last changed, ms since the epoch. The newest wins. */
  updatedAt: number;
  /** A tombstone: the channel was deleted at updatedAt. */
  deleted?: true;
}

/**
 * The room's original chat. Every message from before channels, and every
 * message an older build sends, is in it. It always exists, so it is never a
 * list entry of its own.
 */
export const DEFAULT_TEXT_CHANNEL = "";
/** The room's original call, the one older builds join. */
export const DEFAULT_VOICE_CHANNEL = "";

/**
 * What the original chat and call are called until a member renames them. An
 * entry with the empty id and that kind holds their name and their position;
 * the original channels cannot be deleted. Until somebody moves one, it is
 * first.
 */
export const DEFAULT_CHANNEL_NAMES: Readonly<Record<ChannelKind, string>> = {
  text: "general",
  voice: "voice",
};

/** Channels a room may have, not counting the two original ones. */
export const MAX_CHANNELS = 50;
/**
 * Deleted entries kept. They have to outlive the copies members who were
 * away still hold, but a room that churns through channels must not grow its
 * list without bound; past this the oldest deletes are forgotten, and a
 * member who has been away through more than this many deletes could bring
 * one of those channels back.
 */
export const MAX_CHANNEL_TOMBSTONES = 100;
/** Entries one announcement may carry: every channel plus every tombstone. */
export const MAX_CHANNEL_ENTRIES = MAX_CHANNELS + MAX_CHANNEL_TOMBSTONES + 2;
export const MAX_CHANNEL_NAME = 32;
/** Positions are small integers; anything past this is a broken sender. */
const MAX_POSITION = 1_000_000;
/**
 * A change stamped this far past our clock is a broken clock, not a newer
 * change - it would win every comparison for as long as that clock is wrong.
 * The same allowance room names get.
 */
export const MAX_CHANNEL_FUTURE_MS = 60 * 60 * 1000;

const CHANNEL_ID_RE = /^[a-z0-9]{8,32}$/;
/** Base32 in lowercase: 32 symbols, so 5 random bits each, no modulo bias. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 16;

/** A fresh channel id: 80 random bits, in the shape isChannelId accepts. */
export function newChannelId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

/**
 * Whether a value is a channel id a message or a list entry may carry. The
 * empty id is NOT one: a message in the original chat carries no id at all,
 * so an empty string on the wire is malformed rather than a second spelling
 * of the default.
 */
export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_RE.test(value);
}

/** The channel a message is in, the original chat for one with none. */
export function messageChannel(msg: { channel?: string }): string {
  return msg.channel ?? DEFAULT_TEXT_CHANNEL;
}

/**
 * A channel name as members typed or announced it: control and bidi
 * characters out (the wire-name rule), runs of whitespace collapsed, trimmed,
 * and cut to MAX_CHANNEL_NAME characters. Null when nothing is left.
 */
export function sanitizeChannelName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = stripWireControls(raw).replace(/\s+/g, " ").trim();
  // By code point, so a cut never splits an emoji into half a surrogate pair.
  const capped = Array.from(clean).slice(0, MAX_CHANNEL_NAME).join("").trim();
  return capped || null;
}

/** What identifies an entry: its id, or for an original, its kind. */
export function channelKey(c: Pick<Channel, "id" | "kind">): string {
  return c.id === "" ? `\u0000${c.kind}` : c.id;
}

/**
 * One entry from the wire or a backup, checked field by field, or null.
 * Untrusted input: nothing about it is taken on faith, and the result holds
 * only the fields of a Channel, whatever else the sender put in.
 */
export function parseChannelEntry(raw: unknown): Channel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "text" && r.kind !== "voice") return null;
  if (r.id !== "" && !isChannelId(r.id)) return null;
  const name = sanitizeChannelName(r.name);
  if (!name) return null;
  if (typeof r.position !== "number" || !Number.isFinite(r.position)) return null;
  if (typeof r.updatedAt !== "number" || !Number.isSafeInteger(r.updatedAt) || r.updatedAt <= 0) {
    return null;
  }
  if (r.deleted !== undefined && r.deleted !== true) return null;
  // The originals always exist: a "delete" of one is not a thing to store.
  if (r.id === "" && r.deleted === true) return null;
  const entry: Channel = {
    id: r.id as string,
    kind: r.kind,
    name,
    position: Math.min(MAX_POSITION, Math.max(0, Math.round(r.position))),
    updatedAt: r.updatedAt,
  };
  if (r.deleted === true) entry.deleted = true;
  return entry;
}

/** A list from the wire or a backup: the valid entries of it, capped. */
export function parseChannelList(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) return [];
  const out: Channel[] = [];
  // Only so many are looked at: an honest list is never longer than this.
  for (const item of raw.slice(0, MAX_CHANNEL_ENTRIES * 2)) {
    const entry = parseChannelEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}

/** Everything about an entry but its stamp, for a tie at the same stamp. */
function entryContent(c: Channel): string {
  return JSON.stringify([c.kind, c.name, c.position, c.deleted === true ? 1 : 0]);
}

/**
 * Whether `a` beats `b` for the same entry: the newer change wins, and two
 * changes stamped at the same instant are settled by one rule every member
 * applies alike, so they all end up holding the same entry.
 */
export function entryBeats(a: Channel, b: Channel): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return entryContent(a) > entryContent(b);
}

function sameEntry(a: Channel, b: Channel): boolean {
  return (
    a.id === b.id &&
    a.updatedAt === b.updatedAt &&
    entryContent(a) === entryContent(b)
  );
}

function byPositionThenId(a: Channel, b: Channel): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One entry per key, the caps applied, in a fixed order - so two members
 * holding the same entries store the same list, and a comparison of two
 * lists is a comparison of arrays.
 *
 * Past MAX_CHANNELS live channels, the ones that sort last are left out:
 * every member applies the same rule to the same entries, so they agree on
 * which. Past MAX_CHANNEL_TOMBSTONES, the oldest deletes are forgotten.
 */
export function normalizeChannelList(list: readonly Channel[]): Channel[] {
  const byKey = new Map<string, Channel>();
  for (const c of list) {
    const key = channelKey(c);
    const held = byKey.get(key);
    if (!held || entryBeats(c, held)) byKey.set(key, c);
  }
  const originals: Channel[] = [];
  const live: Channel[] = [];
  const dead: Channel[] = [];
  for (const c of byKey.values()) {
    if (c.id === "") originals.push(c);
    else if (c.deleted) dead.push(c);
    else live.push(c);
  }
  live.sort(byPositionThenId);
  dead.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const kept = [
    ...originals,
    ...live.slice(0, MAX_CHANNELS),
    ...dead.slice(0, MAX_CHANNEL_TOMBSTONES),
  ];
  return kept.sort((a, b) => (channelKey(a) < channelKey(b) ? -1 : 1));
}

/** Whether two normalized lists hold exactly the same entries. */
export function sameChannelList(a: readonly Channel[], b: readonly Channel[]): boolean {
  return a.length === b.length && a.every((c, i) => sameEntry(c, b[i]));
}

export interface ChannelMerge {
  /** Our list with theirs folded in, normalized. */
  merged: Channel[];
  /** Whether that differs from what we held. */
  changed: boolean;
  /**
   * Whether the announcer is behind: we hold an entry they lack, or a newer
   * one. They are answered with our list, the way an older room name is.
   */
  behind: boolean;
}

/**
 * Fold an announced list into ours. Per entry, the newer change wins; an
 * entry stamped more than MAX_CHANNEL_FUTURE_MS past our clock is left out.
 *
 * `behind` is judged against everything they sent, the entries we refused
 * included: a member whose clock runs fast would otherwise be answered with
 * our older copy of that entry on every announcement, and answer back.
 */
export function mergeChannelLists(
  ours: readonly Channel[],
  theirs: readonly Channel[],
  now = Date.now()
): ChannelMerge {
  const held = normalizeChannelList(ours);
  const candidates = theirs.filter((c) => c.updatedAt <= now + MAX_CHANNEL_FUTURE_MS);
  const merged = normalizeChannelList([...held, ...candidates]);
  const theirsByKey = new Map<string, Channel>();
  for (const c of theirs) {
    const key = channelKey(c);
    const at = theirsByKey.get(key);
    if (!at || entryBeats(c, at)) theirsByKey.set(key, c);
  }
  const behind = merged.some((c) => {
    const at = theirsByKey.get(channelKey(c));
    return !at || entryBeats(c, at);
  });
  return { merged, changed: !sameChannelList(held, merged), behind };
}

/** The stamp for a change made now: after the entry it replaces, whatever the clocks say. */
export function nextChannelStamp(previous: Channel | undefined, now = Date.now()): number {
  return Math.max(now, (previous?.updatedAt ?? 0) + 1);
}

function findEntry(list: readonly Channel[], kind: ChannelKind, id: string): Channel | undefined {
  const key = channelKey({ id, kind });
  return list.find((c) => channelKey(c) === key);
}

/**
 * The channels a member can see, by position, deleted ones left out. The
 * original is always among them, under its current name and at the place it
 * was moved to - first, until somebody moves it. Of one kind, or of both with
 * every text channel first.
 */
export function liveChannels(list: readonly Channel[], kind?: ChannelKind): Channel[] {
  const kinds: ChannelKind[] = kind ? [kind] : ["text", "voice"];
  const out: Channel[] = [];
  for (const k of kinds) {
    const others = list.filter((c) => c.kind === k && c.id !== "" && !c.deleted);
    out.push(...[originalChannel(list, k), ...others].sort(byPositionThenId));
  }
  return out;
}

/** The original of a kind: its entry where one was made, else what it starts as. */
function originalChannel(list: readonly Channel[], kind: ChannelKind): Channel {
  const entry = findEntry(list, kind, "");
  return {
    id: "",
    kind,
    name: entry?.name ?? DEFAULT_CHANNEL_NAMES[kind],
    position: entry?.position ?? 0,
    updatedAt: entry?.updatedAt ?? 0,
  };
}

/**
 * The live channel with this id, or undefined for one that is deleted or not
 * in the list (yet). The empty id is always the original of `kind`.
 */
export function findLiveChannel(
  list: readonly Channel[],
  id: string,
  kind: ChannelKind = "text"
): Channel | undefined {
  if (id === "") return originalChannel(list, kind);
  const c = list.find((e) => e.id === id);
  return c && !c.deleted && c.kind === kind ? c : undefined;
}

/** A new channel, or why not. */
export function createChannelEntry(
  list: readonly Channel[],
  kind: ChannelKind,
  rawName: string,
  now = Date.now(),
  id = newChannelId()
): Channel {
  const name = sanitizeChannelName(rawName);
  if (!name) throw new Error("A channel needs a name");
  const live = list.filter((c) => c.id !== "" && !c.deleted);
  if (live.length >= MAX_CHANNELS) throw new Error(`A room can have at most ${MAX_CHANNELS} channels`);
  // Last of its kind, the original counted wherever it was moved to.
  const position = Math.max(...liveChannels(list, kind).map((c) => c.position)) + 1;
  return { id, kind, name, position: Math.min(position, MAX_POSITION), updatedAt: now };
}

/** The entry that renames a channel where it is (the empty id renames the original). */
export function renameChannelEntry(
  list: readonly Channel[],
  kind: ChannelKind,
  id: string,
  rawName: string,
  now = Date.now()
): Channel {
  const name = sanitizeChannelName(rawName);
  if (!name) throw new Error("A channel needs a name");
  const held = findEntry(list, kind, id);
  if (id !== "" && (!held || held.deleted)) throw new Error("No such channel");
  return {
    id,
    kind,
    name,
    position: held?.position ?? 0,
    updatedAt: nextChannelStamp(held, now),
  };
}

/** The tombstone that deletes a channel. The originals cannot be deleted. */
export function deleteChannelEntry(
  list: readonly Channel[],
  kind: ChannelKind,
  id: string,
  now = Date.now()
): Channel {
  if (id === "") throw new Error("The original channel cannot be deleted");
  const held = findEntry(list, kind, id);
  if (!held || held.deleted) throw new Error("No such channel");
  return { ...held, deleted: true, updatedAt: nextChannelStamp(held, now) };
}

/**
 * The entries that put a kind's channels in the given order, the original
 * (the empty id) among them at any place. Ids not in the list are ignored,
 * live channels missing from `order` keep their place after the ones named -
 * except the original, which stays at the place it holds - and only entries
 * whose position moves are restamped. Moving the original past another
 * channel is what makes it an entry; in front it needs none.
 */
export function reorderChannelEntries(
  list: readonly Channel[],
  kind: ChannelKind,
  order: readonly string[],
  now = Date.now()
): Channel[] {
  const live = liveChannels(list, kind);
  const named = order
    .map((id) => live.find((c) => c.id === id))
    .filter((c): c is Channel => !!c);
  const unique = [...new Set(named)];
  const rest = live.filter((c) => !unique.includes(c));
  const next = [...unique, ...rest];
  if (!order.includes("")) {
    const at = live.findIndex((c) => c.id === "");
    const [original] = next.splice(next.findIndex((c) => c.id === ""), 1);
    next.splice(at, 0, original);
  }
  const out: Channel[] = [];
  next.forEach((c, position) => {
    if (c.position !== position) {
      out.push({ ...c, position, updatedAt: nextChannelStamp(c, now) });
    }
  });
  return out;
}
