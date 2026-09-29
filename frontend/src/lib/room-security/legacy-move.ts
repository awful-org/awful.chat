/**
 * Moving an old (legacy) room to a secure one, without making anybody start
 * over.
 *
 * Legacy rooms went read-only at the v2 cutover. The first member to open
 * one is offered to move it: a new secure room with the same name and
 * settings, its old history shown on top, and - if they leave the switch on
 * - a DM to every other member with the invitation and why it came.
 *
 * History cannot be re-sent. v2 signatures cover the room ID, so an old
 * message replayed into the new room is, correctly, a forgery to everyone
 * else. It does not need sending: every member already holds their own copy
 * of the old room. The new room just points at it (`archiveOf`), each
 * device shows its own copy, and nothing old ever goes over the wire.
 *
 * The other members learn which old room the new one continues from the
 * new room itself: the mover's room-name announcement carries `movedFrom`,
 * inside the room's own encrypted channel. A member adopts it only for an
 * old room they hold and the announcer was a member of - see
 * adoptLegacyPredecessor.
 */
import { getRoom, putRoom, type Room } from "$lib/storage";
import { getRoomNotifyMode, setRoomNotifyMode } from "$lib/notify-prefs.svelte";
import { isLegacyArchive } from "./legacy-archive";

/** A legacy room code as it can appear in `movedFrom`: storage key shaped. */
export function isLegacyRoomCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 &&
    /^[0-9A-Za-z]+$/.test(value) && !/^(rd2_|r2_|dm-)/.test(value);
}

/** The DM each other member gets. Plain text: it has to read well anywhere. */
export function legacyMoveInviteText(oldName: string, link: string): string {
  return [
    `Sorry for the hassle! awful.chat moved to end-to-end encrypted rooms, and old rooms like "${oldName}" can't send messages anymore.`,
    `I moved "${oldName}" to a new secure room. Open this link to join it:`,
    link,
    `Your messages from the old room stay on your device and show up at the top of the new one.`,
  ].join("\n\n");
}

/**
 * Link a freshly created secure room to the legacy room it replaces, and
 * carry the local settings over. Runs after the new room exists (the join
 * created its record). Idempotent: a second call finds the link in place.
 */
export async function linkLegacyMove(oldCode: string, newCode: string): Promise<void> {
  const [oldRoom, newRoom] = await Promise.all([getRoom(oldCode), getRoom(newCode)]);
  if (!oldRoom || !newRoom) throw new Error("Room not found");
  if (!isLegacyArchive(oldCode)) throw new Error("Only an old room can be moved");
  await putRoom(carrySettings(oldRoom, newRoom));
  await putRoom({ ...oldRoom, movedTo: newCode });
  // Device-local, like the rest: how loud the old room was allowed to be.
  setRoomNotifyMode(newCode, getRoomNotifyMode(oldCode));
}

function carrySettings(oldRoom: Room, newRoom: Room): Room {
  return {
    ...newRoom,
    archiveOf: oldRoom.roomCode,
    // The room's picture and its place in the sidebar, if the new room has
    // none of its own yet.
    pfpData: newRoom.pfpData ?? oldRoom.pfpData,
    pfpURL: newRoom.pfpURL ?? oldRoom.pfpURL,
    pinnedAt: newRoom.pinnedAt ?? oldRoom.pinnedAt,
    position: newRoom.position ?? oldRoom.position,
  };
}

/**
 * Another member announced that the secure room `newCode` continues the
 * legacy room `movedFrom`. Adopt it - link our own copy of the old history
 * and hide the old room - only when:
 * - we hold that legacy room, and it has not been linked elsewhere already;
 * - the new room has no predecessor yet (the first answer wins; a later,
 *   different claim changes nothing);
 * - the announcer was a member of the old room. A member of the NEW room
 *   who never was in the old one cannot point it at someone else's history.
 * Returns whether anything changed.
 */
export async function adoptLegacyPredecessor(
  newCode: string,
  movedFrom: string,
  announcerDid: string | undefined
): Promise<boolean> {
  if (!announcerDid || !isLegacyRoomCode(movedFrom) || !newCode.startsWith("rd2_")) return false;
  const [oldRoom, newRoom] = await Promise.all([getRoom(movedFrom), getRoom(newCode)]);
  if (!oldRoom || !newRoom || newRoom.archiveOf || oldRoom.movedTo) return false;
  if (!isLegacyArchive(movedFrom)) return false;
  if (!oldRoom.participants.includes(announcerDid)) return false;
  await linkLegacyMove(movedFrom, newCode);
  return true;
}
