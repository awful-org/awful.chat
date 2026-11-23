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

export interface DmSection<T> {
  /** null for the accepted conversations, which carry no heading. */
  title: null | "Requests" | "Blocked";
  entries: T[];
}

/**
 * Accepted conversations first, then requests whatever their recency, then
 * the blocked, each in the order given. Empty sections are left out.
 */
export function dmSections<T extends DmListEntry>(entries: readonly T[]): DmSection<T>[] {
  const sections: DmSection<T>[] = [
    { title: null, entries: entries.filter((e) => !e.request && !e.blocked) },
    { title: "Requests", entries: entries.filter((e) => e.request && !e.blocked) },
    { title: "Blocked", entries: entries.filter((e) => e.blocked) },
  ];
  return sections.filter((s) => s.entries.length > 0);
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
