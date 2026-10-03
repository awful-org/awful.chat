/** Compiled release decision for room security v2 (#94), on since it shipped.
 * Never controllable by a URL, localStorage, or relay response. */
export const ROOM_SECURITY_V2_RELEASED: boolean = true;

export function requireRoomSecurityRelease(): void {
  if (!ROOM_SECURITY_V2_RELEASED) {
    throw new Error("Secure room creation and invitations are awaiting the security-v2 release. Your saved history is retained.");
  }
}
