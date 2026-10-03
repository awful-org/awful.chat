/**
 * How many people are in the room on screen: the number beside its name.
 *
 * It counts the room's own roster, the same list the member sidebar draws
 * one row per entry from, so the two agree. It used to count every peer the
 * browser was connected to, in any room, plus one: the same number in every
 * room, and one that rose and fell with other rooms' members coming online.
 *
 * The roster can name someone by their DID and again by a raw peerId, and
 * ourselves under either, so each entry is reduced to one key (`toDid`) and
 * we are counted once whether we are listed or not.
 */
export function roomMemberCount(
  roomUsers: readonly string[],
  selfIds: readonly string[],
  toDid: (id: string) => string
): number {
  const self = new Set(selfIds.filter(Boolean));
  const members = new Set<string>();
  for (const id of roomUsers) {
    if (!id || self.has(id)) continue;
    const key = toDid(id) || id;
    if (!self.has(key)) members.add(key);
  }
  return members.size + 1;
}
