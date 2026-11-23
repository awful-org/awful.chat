/**
 * The sidebar's rail and column, as plain decisions: which column shows,
 * what a room tile reads, how the DM list is grouped, what a menu offers.
 * RoomSidebar renders these; keeping them here keeps them testable.
 */

/** Which list the rail has selected: one of the rooms, or direct messages. */
export type SidebarView = "rooms" | "dms";

export type SidebarColumn =
  | { kind: "dms" }
  | { kind: "room"; roomCode: string }
  /** The rooms view with no room open (the app's home): every room, by name. */
  | { kind: "rooms" };

export function sidebarColumn(
  view: SidebarView,
  activeRoomCode: string | null,
  roomCodes: readonly string[]
): SidebarColumn {
  if (view === "dms") return { kind: "dms" };
  if (activeRoomCode && roomCodes.includes(activeRoomCode)) {
    return { kind: "room", roomCode: activeRoomCode };
  }
  return { kind: "rooms" };
}

/** Graphemes, so an emoji or a combined letter is never cut in half. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * A room tile's letters: the first letter of each of the first two words,
 * or the first two of a single word. "awful devs" -> "AD", "bookclub" -> "BO".
 */
export function roomInitials(name: string, fallback = "?"): string {
  const words = name.trim().split(/[\s\-_./]+/).filter(Boolean);
  if (words.length === 0) return fallback.slice(0, 2).toUpperCase() || "?";
  const letters =
    words.length >= 2
      ? [graphemes(words[0])[0], graphemes(words[1])[0]]
      : graphemes(words[0]).slice(0, 2);
  return letters.join("").toUpperCase();
}

/** The count a badge shows; it never grows past three characters. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** The light pill at the rail's edge: tall when selected, a dot when unread. */
export function railPill(selected: boolean, unread: number): "selected" | "unread" | "none" {
  if (selected) return "selected";
  return unread > 0 ? "unread" : "none";
}

export function timeAgo(ts: number, now = Date.now()): string {
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface DmListEntry {
  peerId: string;
  request?: boolean;
  blocked?: boolean;
  inPhonebook?: boolean;
}

/** Which group of the DM list: also what its folded state is stored under. */
export type DmSectionKey = "messages" | "requests" | "blocked";

export const DM_SECTION_KEYS: readonly DmSectionKey[] = ["messages", "requests", "blocked"];

export interface DmSection<T> {
  key: DmSectionKey;
  /**
   * The heading. The accepted conversations carry one ("Messages") only
   * while another group is listed: alone they are the whole list, and a
   * heading over everything says nothing - nor is there anything to fold
   * them away from. Null means no heading, and no folding.
   */
  title: null | "Messages" | "Requests" | "Blocked";
  entries: T[];
}

/**
 * Accepted conversations first, then requests whatever their recency, then
 * the blocked, each in the order given. Empty sections are left out.
 */
export function dmSections<T extends DmListEntry>(entries: readonly T[]): DmSection<T>[] {
  const sections: DmSection<T>[] = [
    { key: "messages", title: null, entries: entries.filter((e) => !e.request && !e.blocked) },
    { key: "requests", title: "Requests", entries: entries.filter((e) => e.request && !e.blocked) },
    { key: "blocked", title: "Blocked", entries: entries.filter((e) => e.blocked) },
  ];
  const listed = sections.filter((s) => s.entries.length > 0);
  if (listed.length > 1 && listed[0].key === "messages") listed[0].title = "Messages";
  return listed;
}

/** A section is folded only when it has a heading to unfold it from. */
export function dmSectionFolded(
  section: DmSection<unknown>,
  folded: readonly DmSectionKey[]
): boolean {
  return section.title !== null && folded.includes(section.key);
}

/**
 * The rows a section shows. Folded, it keeps the conversation on screen
 * (if it is in there): folding a heading should not take away the row you
 * are reading, and the selection would otherwise point at nothing.
 */
export function dmSectionRows<T extends { peerId: string }>(
  section: DmSection<T>,
  folded: boolean,
  activePeerId: string | null
): T[] {
  if (!folded) return section.entries;
  return section.entries.filter((e) => e.peerId === activePeerId);
}

/**
 * What a folded heading says about what it hides: how many conversations,
 * and how many unread messages among them, so nothing is hidden in silence.
 */
export function dmSectionSummary(
  entries: readonly { peerId: string }[],
  unreadOf: (peerId: string) => number
): { count: number; unread: number } {
  let unread = 0;
  for (const e of entries) unread += Math.max(0, unreadOf(e.peerId) || 0);
  return { count: entries.length, unread };
}

/**
 * The folded sections as stored on this device: a JSON list of section keys.
 * Anything else (an old shape, a hand edit, a key a later build dropped) is
 * left out rather than trusted, and a broken value folds nothing.
 */
export function parseFoldedDmSections(raw: string | null): DmSectionKey[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return DM_SECTION_KEYS.filter((k) => value.includes(k));
}

/** Fold an open section or open a folded one; the list stays in a fixed order. */
export function toggleDmSection(folded: readonly DmSectionKey[], key: DmSectionKey): DmSectionKey[] {
  const on = !folded.includes(key);
  return DM_SECTION_KEYS.filter((k) => (k === key ? on : folded.includes(k)));
}

export type DmContextAction =
  | { type: "add"; peerId: string }
  | { type: "removePhonebook"; peerId: string }
  | { type: "removeConversation"; peerId: string }
  | { type: "block"; peerId: string }
  | { type: "unblock"; peerId: string };

/** A conversation's menu. Adding a blocked person is refused, so not offered. */
export function dmMenuActions(
  peerId: string,
  state: { blocked: boolean; inPhonebook: boolean }
): DmContextAction[] {
  return [
    ...(state.inPhonebook
      ? [{ type: "removePhonebook", peerId } as const]
      : state.blocked
        ? []
        : [{ type: "add", peerId } as const]),
    state.blocked ? { type: "unblock", peerId } : { type: "block", peerId },
    { type: "removeConversation", peerId },
  ];
}

/** `order` with `id` moved one step up (-1) or down (+1); null at an end. */
export function moveStep(order: readonly string[], id: string, step: -1 | 1): string[] | null {
  const from = order.indexOf(id);
  const to = from + step;
  if (from === -1 || to < 0 || to >= order.length) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Keep a menu of this size inside the viewport, 8px from every edge. */
export function clampMenu(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, viewport.width - size.width - 8)),
    y: Math.max(8, Math.min(y, viewport.height - size.height - 8)),
  };
}

/** Arrow-key movement through a menu's items, wrapping at the ends. */
export function menuFocusIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

// ── Touch: hold a room tile to move it ──────────────────────────────────────
//
// A finger on the rail scrolls it, so a touch cannot start a drag the way a
// mouse press does. Holding still on a tile is the signal instead: a swipe
// leaves before the hold and scrolls; a hold lifts the tile, and then moving
// drags it and letting go without moving opens its menu - the menu a long
// press opened before, kept on the same gesture.

/**
 * How long a finger rests on a tile before it lifts. Not a guess at when
 * something finishes: it is what makes a press a hold, the same order as the
 * platform's own long press, which would otherwise open the menu at once.
 */
export const HOLD_MS = 400;
/** Movement within this, before the hold, is a still finger, not a swipe. */
export const HOLD_SLOP_PX = 8;

/** A move of the finger, before the tile lifted: still waiting, or a swipe. */
export function pressMove(distance: number): "wait" | "swipe" {
  return distance > HOLD_SLOP_PX ? "swipe" : "wait";
}

/**
 * The finger came up after the tile lifted: a tile that went somewhere is
 * dropped there; one that never left its place opens its menu.
 */
export function holdRelease(moved: boolean): "drop" | "menu" {
  return moved ? "drop" : "menu";
}

// ── Room pictures ───────────────────────────────────────────────────────────

export interface RoomPicture {
  roomCode: string;
  pfpURL?: string;
  pfpData?: ArrayBuffer;
}

/**
 * The pictures the rail shows, by room: an external pfpURL as it is, a local
 * upload (pfpData) through a blob URL made once per upload and revoked when
 * the picture changes, the room goes, or the rail is done. The same choice
 * the profile picture makes (profile.svelte.ts): the URL first, else the
 * upload.
 */
export class RoomPictureUrls {
  private held = new Map<string, { data: ArrayBuffer; url: string }>();

  constructor(
    private readonly make: (data: ArrayBuffer) => string,
    private readonly revoke: (url: string) => void
  ) {}

  sync(rooms: readonly RoomPicture[]): Map<string, string> {
    const out = new Map<string, string>();
    const keep = new Set<string>();
    for (const room of rooms) {
      if (room.pfpURL) {
        out.set(room.roomCode, room.pfpURL);
        continue;
      }
      if (!room.pfpData) continue;
      let blob = this.held.get(room.roomCode);
      if (!blob || blob.data !== room.pfpData) {
        if (blob) this.revoke(blob.url);
        blob = { data: room.pfpData, url: this.make(room.pfpData) };
        this.held.set(room.roomCode, blob);
      }
      keep.add(room.roomCode);
      out.set(room.roomCode, blob.url);
    }
    for (const [code, blob] of this.held) {
      if (keep.has(code)) continue;
      this.revoke(blob.url);
      this.held.delete(code);
    }
    return out;
  }

  dispose(): void {
    for (const blob of this.held.values()) this.revoke(blob.url);
    this.held.clear();
  }
}
