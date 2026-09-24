/**
 * The sidebar's room order. It lives ON the room records (pinnedAt,
 * position), so it is wiped with the account, deleted with the room, and
 * carried by device sync and backups like everything else about the room.
 */

import type { Room } from "./storage";

/**
 * Pinned rooms first, oldest pin on top; then rooms a drag has placed, by
 * position; then rooms never placed (freshly joined, or never dragged) in
 * the order they came in. Array.sort is stable, so ties keep that order too.
 */
export function sortRooms(rooms: Room[]): Room[] {
  const pinned = rooms
    .filter((r) => r.pinnedAt != null)
    .sort((a, b) => a.pinnedAt! - b.pinnedAt!);
  const placed = rooms
    .filter((r) => r.pinnedAt == null && r.position != null)
    .sort((a, b) => a.position! - b.position!);
  const unplaced = rooms.filter((r) => r.pinnedAt == null && r.position == null);
  return [...pinned, ...placed, ...unplaced];
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
