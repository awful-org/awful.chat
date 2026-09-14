import { apiUrl } from "$lib/runtime-config";
import { parseRoomCode } from "./palette/query";
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
const LEGACY_SIX_HEX_RE = /^[0-9a-f]{6}$/i;

// No hardcoded origin here. An unset apiUrl means this instance did not say
// where its relay is, and pointing at awful.frav.in instead would send a
// self-hoster's users - and the urls they open - to a stranger's server
// without either party knowing. Empty resolves same-origin, which 404s: the
// feature is off, and it is off HERE.
function apiBase(): string {
  return apiUrl();
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

export type JoinInput =
  | { kind: "short"; code: string; legacySixHex: boolean }
  | { kind: "room"; code: string }
  | { kind: "invalid" };

/** Parse every join entry path identically, including both historical links. */
export function parseJoinInput(input: string): JoinInput {
  let raw = input.trim();
  if (!raw) return { kind: "invalid" };
  if (/^(https?:\/\/|\/r\/|web\+awfl:\/\/)/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch { return { kind: "invalid" }; }
    const code = parseRoomCode(raw);
    return code ? { kind: "room", code } : { kind: "invalid" };
  }
  const short = normalizeShortCode(raw);
  if (SHORT_CODE_RE.test(short)) {
    return { kind: "short", code: short, legacySixHex: LEGACY_SIX_HEX_RE.test(raw.replace(/[-\s]/g, "")) };
  }
  if (/[/?#]/.test(raw)) return { kind: "invalid" };
  const code = parseRoomCode(raw);
  return code ? { kind: "room", code } : { kind: "invalid" };
}

/** For display: `7QK3M9` -> `7QK3-M9`. */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Ask the relay for a 5-minute alias of `roomCode`. Throws on failure. */
export async function createInvite(
  roomCode: string
): Promise<{ code: string; ttl: number; expiresAt: number }> {
  const started = Date.now();
  const res = await fetch(`${apiBase()}/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`invite: relay answered ${res.status}`);
  const body = (await res.json()) as { code: string; ttl: number };
  if (!SHORT_CODE_RE.test(body.code) || !Number.isFinite(body.ttl) || body.ttl <= 0 || body.ttl > 300) throw new Error("Invalid invite response");
  return { ...body, expiresAt: started + body.ttl * 1000 };
}

/** The room behind a short code, or null when unknown or expired. */
export async function resolveInvite(input: string): Promise<string | null> {
  const code = normalizeShortCode(input);
  const res = await fetch(`${apiBase()}/invite/${code}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (res.status === 429) throw new Error("Too many short-code requests. Wait a minute or use the full invite link.");
  if (!res.ok) throw new Error(`Invite lookup failed (${res.status}). Try the full invite link.`);
  const body = (await res.json()) as { roomCode?: string };
  return typeof body.roomCode === "string" && body.roomCode ? body.roomCode : null;
}
