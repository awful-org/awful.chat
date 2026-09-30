import type { RoomProfileFields } from "$lib/room-profile";

/** A room clear is explicit; undefined would mean inherit and undo the user's choice. */
export function roomEditFields(fields: Record<string, string | boolean | undefined>): RoomProfileFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null]));
}

/** Compare a room edit with the value when editing began, not a changing inherited main value. */
export function shouldSaveEditedValue(roomCode: string | null, entered: string, atStart: string, current: string): boolean {
  return entered !== (roomCode ? atStart : current);
}
