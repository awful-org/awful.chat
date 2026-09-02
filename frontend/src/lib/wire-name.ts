/**
 * Normalising for display strings that arrive on the wire.
 *
 * Its own module because it is pure and has two callers that must agree: the
 * transport's profile handler (a peer's nickname) and wireToMessage (the
 * sender name and reply-snapshot author stamped on every incoming chat row).
 * Importing transport.svelte.ts for it would drag libp2p into anything that
 * only wants to render a name.
 */

// Control characters (C0/C1) and bidi override/isolate characters: a wire
// name is rendered as-is in the roster and chat, and either family can hide
// or reorder text a user never typed - trojan-source-style in a nickname.
const WIRE_CONTROL_RE =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Same cap _handleRoomName already uses for a wire-supplied display string -
 * there is no dedicated client-side max on the nickname field itself, so this
 * mirrors the one precedent rather than inventing a new number.
 */
export const MAX_WIRE_NAME_LENGTH = 64;

/** Drop the characters that can lie about what the rest of the string says. */
export function stripWireControls(value: string): string {
  return value.replace(WIRE_CONTROL_RE, "");
}

/** Strip, trim and cap a wire-supplied display name. Junk becomes "". */
export function normalizeWireName(name: unknown): string {
  if (typeof name !== "string") return "";
  return stripWireControls(name).trim().slice(0, MAX_WIRE_NAME_LENGTH);
}
