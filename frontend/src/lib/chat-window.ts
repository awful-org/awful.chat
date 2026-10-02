/**
 * Which messages of the open conversation are mounted: a window over the
 * rows held in memory (transportState.messages, as far as they render).
 *
 * Every row is a whole component tree, and the list used to mount every
 * message it held. Nothing bounded that: a catch-up push lands up to 640
 * rows in one go, which was a single frozen frame of seconds on a phone,
 * and a jump to an old search hit mounted everything between it and the
 * present. The window keeps at most MAX_ROWS mounted, wherever the reader
 * is, and FOLLOW_ROWS while they follow the newest messages.
 *
 * A window is null - follow the newest - or held still at a range given by
 * the rows it starts and ends at: cursors rather than indexes, because rows
 * keep arriving at both ends of the list underneath it. An end of null
 * runs through the newest row, up to MAX_ROWS from the start.
 */
import { compareMessages, type MessageCursor } from "$lib/transport/message-order";

/** Rows mounted while following the newest. */
export const FOLLOW_ROWS = 100;
/** Rows mounted at most, anywhere. */
export const MAX_ROWS = 200;
/** Rows a window grows by when the reader reaches either end of it. */
export const STEP_ROWS = 50;
/** Held rows (in memory, not necessarily mounted) worth trimming from... */
export const TRIM_AT = 400;
/** ...down to this many, the newest. Above FOLLOW_ROWS, so scrolling back a
 *  little shows held rows before it reads storage again. */
export const HOLD_ROWS = 200;

export type ChatWindow = null | {
  start: MessageCursor;
  end: MessageCursor | null;
};

/** Mounted rows: list indexes from `from` up to, not including, `to`. */
export interface WindowRange {
  from: number;
  to: number;
}

function cursorOf(row: MessageCursor): MessageCursor {
  return { lamport: row.lamport, id: row.id };
}

/** Where `cursor` sits in the list: its own index, or else the index of the
 *  first row after it (when it has been dropped from the list). */
function indexOf(list: readonly MessageCursor[], cursor: MessageCursor): number {
  const at = list.findIndex((row) => row.id === cursor.id);
  if (at >= 0) return at;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareMessages(list[mid], cursor) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function windowRange(
  list: readonly MessageCursor[],
  window: ChatWindow
): WindowRange {
  const length = list.length;
  const follow = { from: Math.max(0, length - FOLLOW_ROWS), to: length };
  if (window === null) return follow;
  const from = indexOf(list, window.start);
  let to = length;
  if (window.end !== null) {
    const end = indexOf(list, window.end);
    to = end < length && list[end].id === window.end.id ? end + 1 : end;
  }
  to = Math.max(from, Math.min(to, from + MAX_ROWS));
  // None of the window's rows are in the list any more: it was replaced
  // under it - a conversation opened again reloads its newest page - and
  // a window over rows that are gone would mount nothing at all.
  if (to === from && length > 0) return follow;
  return { from, to };
}

/** A window over rows `from` up to `to`, held still. */
function held(list: readonly MessageCursor[], from: number, to: number): ChatWindow {
  if (from >= list.length) return null;
  return {
    start: cursorOf(list[from]),
    end: to >= list.length ? null : cursorOf(list[Math.max(from, to - 1)]),
  };
}

/** The window as it stands, held: rows arriving below it no longer push
 *  the ones above out of it. */
export function hold(list: readonly MessageCursor[], range: WindowRange): ChatWindow {
  return held(list, range.from, range.to);
}

/** The reader reached the top: STEP_ROWS older rows mounted, and the
 *  newest dropped past MAX_ROWS. */
export function showOlder(list: readonly MessageCursor[], range: WindowRange): ChatWindow {
  const from = Math.max(0, range.from - STEP_ROWS);
  return held(list, from, Math.min(range.to, from + MAX_ROWS));
}

/** The reader reached the bottom of a window short of the newest:
 *  STEP_ROWS newer rows mounted, and the oldest dropped past MAX_ROWS. */
export function showNewer(list: readonly MessageCursor[], range: WindowRange): ChatWindow {
  const to = Math.min(list.length, range.to + STEP_ROWS);
  return held(list, Math.max(range.from, to - MAX_ROWS), to);
}

/** A window with the row at `index` in the middle of it, for a jump. */
export function around(list: readonly MessageCursor[], index: number): ChatWindow {
  const from = Math.max(0, Math.min(index - FOLLOW_ROWS / 2, list.length - FOLLOW_ROWS));
  return held(list, from, Math.min(list.length, from + FOLLOW_ROWS));
}

/**
 * Where to cut the held list while following the newest: the oldest row to
 * keep, or null while it is short enough to leave alone - or when the cut
 * would drop nothing. `keep` is a held row that must stay, the message
 * being replied to: the cut goes no newer than it.
 */
export function trimPoint(
  list: readonly MessageCursor[],
  keep: MessageCursor | null = null
): MessageCursor | null {
  if (list.length <= TRIM_AT) return null;
  let cut = list[list.length - HOLD_ROWS];
  if (keep && compareMessages(keep, cut) < 0) cut = keep;
  if (compareMessages(cut, list[0]) <= 0) return null;
  return cursorOf(cut);
}
