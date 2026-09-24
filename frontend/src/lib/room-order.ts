/**
 * Custom room order for the sidebar. Device-local, like the rest of
 * display-prefs: it says nothing about a room and rides on no wire format,
 * so it never needs to sync or survive a room's own record changing shape.
 */

import type { Room } from "./storage";

/**
 * Lay `rooms` out by `order` (a list of roomCodes). A code the room list no
 * longer has (a removed room) is skipped rather than erroring, and a room
 * `order` has never seen (freshly joined, or ordering never touched) keeps
 * its relative position from `rooms`, appended after every ordered one - so
 * an empty `order` is the identity and a partial one only moves what it
 * names.
 */
export function applyRoomOrder(rooms: Room[], order: string[]): Room[] {
  if (order.length === 0) return rooms;
  const remaining = new Map(rooms.map((room) => [room.roomCode, room] as const));
  const ordered: Room[] = [];
  for (const code of order) {
    const room = remaining.get(code);
    if (!room) continue;
    ordered.push(room);
    remaining.delete(code);
  }
  for (const room of rooms) {
    if (remaining.has(room.roomCode)) ordered.push(room);
  }
  return ordered;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** A row's box in the pre-drag layout, in the list's scroll coordinates. */
export interface RowBox {
  top: number;
  height: number;
}

/**
 * Where the row dragged from `from` lands with its center at `center`: one
 * slot past every other row whose midpoint it has crossed. Measured against
 * the pre-drag layout, so the answer does not wobble as rows slide aside.
 *
 * Symmetric by construction - the old "insert before the row under the
 * pointer" rule could only ever move a row UP: dropped on the next row down
 * it went back where it started.
 */
export function dropIndex(rows: readonly RowBox[], from: number, center: number): number {
  let index = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i !== from && center > rows[i].top + rows[i].height / 2) index++;
  }
  return index;
}

/** Top of the slot the dragged row occupies once moved from `from` to `to`. */
export function slotTop(rows: readonly RowBox[], from: number, to: number): number {
  if (to <= from) return rows[to].top;
  return rows[to].top + rows[to].height - rows[from].height;
}
