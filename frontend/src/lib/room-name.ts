/**
 * Room names: the newest one wins, everywhere.
 *
 * A name travels with `nameAt`, when it was chosen. Every member keeps the
 * newest name they have seen, and answers an older one with theirs, so a
 * device that missed a rename catches up the next time it talks to anyone
 * who did not. Before this, a name was taken from whoever spoke last: a
 * member who had been offline re-announced their old name on opening the
 * room and renamed it back for everyone, and one who joined from a bare
 * link announced the placeholder "Room" over the real name.
 */

/** Just the parts of a stored room that name it. */
export interface NamedRoom {
  roomCode: string;
  name: string;
  /**
   * When the name was chosen, ms since the epoch. 0 marks a placeholder
   * nobody chose ("Room", from a bare invite link). Absent on a name from
   * before timestamps, which counts as chosen at LEGACY_NAME_AT.
   */
  nameAt?: number;
}

/** A name that nobody chose: never announced, and any real name replaces it. */
export const PLACEHOLDER_NAME_AT = 0;
/** A name from before timestamps: chosen, but older than any rename since. */
export const LEGACY_NAME_AT = 1;
/**
 * A claim this far past our clock is a broken clock, not a newer name - it
 * would win every comparison for as long as that clock is wrong.
 */
const MAX_FUTURE_MS = 60 * 60 * 1000;

/** Whether the room's name was chosen by someone, and so worth announcing. */
export function isChosenName(room: NamedRoom): boolean {
  return room.nameAt !== PLACEHOLDER_NAME_AT && !!room.name && room.name !== room.roomCode;
}

/** When the room's current name was chosen, for comparing. */
export function nameStamp(room: NamedRoom): number {
  return isChosenName(room) ? (room.nameAt ?? LEGACY_NAME_AT) : PLACEHOLDER_NAME_AT;
}

/**
 * What to do with a name another member announced for a room we hold:
 * take it, keep ours as it is, or keep ours and answer with it because the
 * announcer is behind.
 */
export function judgeRoomName(
  stored: NamedRoom,
  name: string,
  /** Absent from a client older than timestamps. */
  nameAt: number | undefined,
  now = Date.now()
): "take" | "keep" | "answer" {
  const theirs = nameAt ?? LEGACY_NAME_AT;
  if (!Number.isFinite(theirs) || theirs < LEGACY_NAME_AT || theirs > now + MAX_FUTURE_MS) return "keep";
  if (!isChosenName(stored)) return "take";
  const ours = nameStamp(stored);
  if (theirs > ours) return "take";
  if (theirs < ours) return "answer";
  if (name === stored.name) return "keep";
  // Chosen at the same instant: one rule every member applies alike, so
  // they all end up on the same name.
  return name > stored.name ? "take" : "answer";
}

/** The stamp for a rename made now: after the name it replaces, whatever the clocks say. */
export function nextNameStamp(room: NamedRoom | undefined, now = Date.now()): number {
  return Math.max(now, (room ? nameStamp(room) : 0) + 1);
}
