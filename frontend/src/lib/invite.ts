import { parseSecureInvitation } from "./room-security/invitation-format";
import { parsePairingCode, formatPairingCode } from "./room-security/invitation-pairing";

export type JoinInput =
  | { kind: "pairing"; code: string }
  | { kind: "room"; code: string }
  | { kind: "invalid" };

/** All invitation entry points reject public IDs and retired plaintext aliases. */
export function parseJoinInput(input: string): JoinInput {
  try { return { kind: "room", code: parseSecureInvitation(input) }; } catch { /* Try online pairing. */ }
  const pair = parsePairingCode(input);
  return pair ? { kind: "pairing", code: formatPairingCode(pair.locator, pair.password) } : { kind: "invalid" };
}

/** Retired API kept fail-closed for callers from stale application code. */
export async function createInvite(_roomCode: string): Promise<never> {
  throw new Error("Use a full invitation link or online pairing; plaintext aliases are retired.");
}
