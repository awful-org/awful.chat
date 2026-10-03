import { ROOM_SECURITY_V2_RELEASED } from "./invitation-release";

/** Legacy IDs remain storage keys only after cutover, never capabilities. */
export function isLegacyArchive(roomCode: string | null): boolean {
  return ROOM_SECURITY_V2_RELEASED && !!roomCode &&
    !/^(rd2_|r2_|dm-)/.test(roomCode);
}

export function requireWritableRoom(roomCode: string | null): void {
  if (isLegacyArchive(roomCode)) {
    throw new Error("Legacy rooms are read-only. Create a secure room to continue.");
  }
}
