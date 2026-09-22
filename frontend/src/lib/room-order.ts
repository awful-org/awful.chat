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

/**
 * The explicit order after dragging `fromCode`'s row to sit just before
 * `toCode`'s. `order` need not already name every room - the displayed
 * order (whatever `applyRoomOrder` would show right now) is what actually
 * gets rearranged, so a first drag captures the pre-existing layout instead
 * of silently reshuffling the rooms `order` had never named.
 */
export function moveRoomBefore(
  rooms: Room[],
  order: string[],
  fromCode: string,
  toCode: string
): string[] {
  const effective = applyRoomOrder(rooms, order).map((room) => room.roomCode);
  const from = effective.indexOf(fromCode);
  if (from === -1 || !effective.includes(toCode) || fromCode === toCode) {
    return effective;
  }
  const next = [...effective];
  const [moved] = next.splice(from, 1);
  next.splice(next.indexOf(toCode), 0, moved);
  return next;
}
