/**
 * The menu your own entry opens - your card in the member list, your row
 * under a voice channel, the author of your messages - in place of the browser's: nothing answered a
 * right-click there, so it fell through. Only things the app already does: your profile card, the profile settings, your ID on the clipboard.
 * One list, so both places say the same thing in the same order.
 */
export type SelfMenuAction = "profile" | "edit" | "copyId";

export const SELF_MENU: readonly { action: SelfMenuAction; label: string }[] = [
  { action: "profile", label: "View my profile" },
  { action: "edit", label: "Edit profile" },
  { action: "copyId", label: "Copy my ID" },
];

/**
 * The profile settings to open for an edit: the room's own profile in a
 * protected room (rd2_), which can carry a different name and picture, the
 * global one everywhere else - the scope the profile card's Edit uses.
 */
export function profileScopeFor(roomCode: string | null | undefined): string | null {
  return roomCode?.startsWith("rd2_") ? roomCode : null;
}
