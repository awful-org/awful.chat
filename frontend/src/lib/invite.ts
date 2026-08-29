/**
 * Short invite codes.
 *
 * A room code is 64 bits and stays that way: it is the room's only secret.
 * A short code is a 6-character alias the relay keeps for five minutes and
 * resolves back to the real code - something you can read across a table.
 * Guessing one means hitting a 30-bit space inside a 5-minute window through
 * an endpoint the relay rate-limits per IP, which is nothing like guessing a
 * room. See relay/invite.go.
 *
 * Alphabet is Crockford base32: no O/0 or I/1/L confusion, case-insensitive.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_CODE_RE = new RegExp(`^[${ALPHABET}]{6}$`);

function apiBase(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ||
    "https://awful.frav.in"
  );
}

/** Uppercase, fold the look-alikes, drop separators. Not a validator. */
export function normalizeShortCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/**
 * Whether typed input could be a short code. A legacy 6-character hex room
 * code passes this too - resolve it, and on a miss join it literally.
 */
export function looksLikeShortCode(input: string): boolean {
  return SHORT_CODE_RE.test(normalizeShortCode(input));
}

/** For display: `7QK3M9` -> `7QK3-M9`. */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Ask the relay for a 5-minute alias of `roomCode`. Throws on failure. */
export async function createInvite(
  roomCode: string
): Promise<{ code: string; ttl: number }> {
  const res = await fetch(`${apiBase()}/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode }),
  });
  if (!res.ok) throw new Error(`invite: relay answered ${res.status}`);
  return (await res.json()) as { code: string; ttl: number };
}

/** The room behind a short code, or null when unknown or expired. */
export async function resolveInvite(input: string): Promise<string | null> {
  const code = normalizeShortCode(input);
  const res = await fetch(`${apiBase()}/invite/${code}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`invite: relay answered ${res.status}`);
  const body = (await res.json()) as { roomCode?: string };
  return typeof body.roomCode === "string" && body.roomCode ? body.roomCode : null;
}
