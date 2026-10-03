import { parseSecureInvitation } from "./room-security/invitation-format";
// Not invitation-pairing.ts: reading a code must not load the pairing's
// cryptography, and an invite link is read before this device has an identity.
import { parsePairingCode, formatPairingCode } from "./room-security/pairing-code";

export type JoinInput =
  | { kind: "pairing"; code: string }
  | { kind: "room"; code: string }
  | { kind: "invalid" };

/**
 * A short link, `https://awful.chat/r/#k5t-8r5`, with or without the scheme.
 * Fragment only, like a full invitation: a live code has no business in a path
 * that reaches server logs.
 */
const SHORT_LINK_RE = /^(?:(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#\s]+)?\/r\/#([^/?#]+)$/i;

/** All invitation entry points reject public IDs and retired plaintext aliases. */
export function parseJoinInput(input: string): JoinInput {
  try { return { kind: "room", code: parseSecureInvitation(input) }; } catch { /* Try online pairing. */ }
  const link = SHORT_LINK_RE.exec(input.trim());
  const pair = parsePairingCode(link ? link[1] : input);
  return pair ? { kind: "pairing", code: formatPairingCode(pair.locator, pair.password) } : { kind: "invalid" };
}

/** Retired API kept fail-closed for callers from stale application code. */
export async function createInvite(_roomCode: string): Promise<never> {
  throw new Error("Use a full invitation link or online pairing; plaintext aliases are retired.");
}
