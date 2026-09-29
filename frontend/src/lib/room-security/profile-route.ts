/** undefined: legacy session; null: no authorized profile destination yet.
 * Once any v2 room is joined, a peer must share a verified room. A relay's
 * discovery list is never sufficient to disclose a profile.
 */
export function profileDeliveryRoom(
  rooms: readonly string[],
  peer: string,
  members: (room: string) => readonly string[],
): string | null | undefined {
  const secure = (room: string) => room.startsWith("rd2_") || room.startsWith("dm-");
  if (!rooms.some(secure)) return undefined;
  return rooms.find((room) => secure(room) && members(room).includes(peer)) ?? null;
}
