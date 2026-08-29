import type { DMRoom, PhonebookEntry, Room } from "./storage";

/**
 * A display name for a DM room, for surfaces that only hold a room code.
 *
 * A DM room usually has no stored `name`, so anything listing rooms by name
 * falls back to the code and shows "dm-" plus 40 hex characters, which tells
 * the reader nothing about who it is.
 *
 * The sources are tried in the same order `resolveDmDisplayName` in
 * dm.svelte.ts uses, because they fail in different situations and the union
 * is what makes this reliable: the live name map is populated once a peer has
 * been seen this session; the phonebook nickname survives a reload even when
 * no profile was ever cached, which is exactly the case a DM from a stranger
 * hits. Checking only one of them is why this returned a truncated code.
 */
export function resolveDmRoomDisplayName(
  roomCode: string,
  rooms: Array<Room | DMRoom>,
  phonebook: PhonebookEntry[],
  peerNames: Map<string, string>
): string {
  if (!roomCode.startsWith("dm-")) return roomCode;

  // The room may be filed under either list depending on how it was created,
  // so search what the caller gave us rather than assuming dmRooms.
  const room = rooms.find((r) => r.roomCode === roomCode) as
    | DMRoom
    | undefined;
  const did = room?.participantDid;

  if (did) {
    const live = peerNames.get(did);
    if (live) return live;

    const entry = phonebook.find((e) => e.did === did || e.peerId === did);
    if (entry?.nickname) return entry.nickname;
  }

  // Nothing resolved. A truncated code is still better than 40 hex
  // characters, and it stays stable so the row does not jump around.
  return roomCode.slice(0, 12);
}
