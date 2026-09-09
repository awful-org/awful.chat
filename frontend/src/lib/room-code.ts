/**
 * Room codes.
 *
 * The code IS the membership secret: it names the gossipsub topic, keys the
 * relay's rendezvous, and is the SFU's join key. There is no roster and no
 * second factor, so anyone holding it reads the room's plaintext chat and can
 * consume its camera and screen streams.
 *
 * It used to be 3 random bytes - 24 bits, 16.7 million codes. Guessing is
 * online only (you have to reach the relay or the SFU to test one), but with R
 * rooms live the expected cost of hitting SOME room is 2^24/R, which is a few
 * hundred thousand tries on a busy instance: hours, not centuries.
 *
 * 64 bits takes that to 2^64. At a wildly generous 10,000 guesses per second
 * against the network, exhausting a millionth of that space still takes
 * centuries, and there is no offline oracle to speed it up. 128 bits would buy
 * nothing further and doubles a string people sometimes read aloud.
 *
 * Alphabet: Crockford base32 - 13 characters for 65 bits, no O/0 or I/1/L
 * confusion, case-insensitive on input. Shown as XXXX-XXXX-XXXX-X. The wire
 * form is the bare uppercase string; the relay, the SFU and the client all
 * treat a code as an opaque string, so the earlier 16-char hex codes (and the
 * 6-char ones before them) keep working unchanged, and keep their entropy -
 * a room cannot be re-keyed without becoming a different room.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROOM_CODE_LEN = 13;
const ROOM_CODE_RE = new RegExp(`^[${ALPHABET}]{${ROOM_CODE_LEN}}$`);

export function newRoomCode(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(ROOM_CODE_LEN)),
    (b) => ALPHABET[b & 31]
  ).join("");
}

/**
 * What a person typed or pasted, as the wire form. Only a base32 code is
 * touched (separators dropped, uppercased, look-alikes folded); anything
 * else - a legacy hex code, a short invite - is returned trimmed, so the
 * legacy lowercase hex is never mangled.
 */
export function normalizeRoomCode(input: string): string {
  const trimmed = input.trim();
  const folded = trimmed
    .replace(/[-\s]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return ROOM_CODE_RE.test(folded) ? folded : trimmed;
}

/**
 * Quick codes: /qs and /qc.
 *
 * 10 characters, 50 bits, shown as XXX-XXXX-XXX - the shape of a Google Meet
 * code, and for the same reason. A room is permanent and its code is worth
 * grinding for; a quick call or a file hand-off is alive for hours at the
 * outside, and after that the code names nothing at all.
 *
 * The arithmetic, at a wildly generous 10,000 guesses per second sustained
 * against the relay's rendezvous (there is no offline oracle - a guess has to
 * be registered with the relay to test it), over a four-hour session:
 *
 *	one session:            1.4e8 tries / 2^50 = 0.00000013
 *	1,000 live sessions:    1.4e8 * 1000 / 2^50 = 0.00013
 *
 * So one chance in eight thousand that a sustained four-hour attack lands on
 * ANY live session across a busy instance. Eight characters (40 bits) is
 * where that stops holding - it puts the same figure at 13%, which is why
 * this is not shorter still.
 *
 * Deliberately a different LENGTH from a room code rather than a different
 * alphabet, so one look tells them apart and neither parser can be fed the
 * other's input by accident.
 */
const QUICK_CODE_LEN = 10;
const QUICK_CODE_RE = new RegExp(`^[${ALPHABET}]{${QUICK_CODE_LEN}}$`);

export function newQuickCode(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(QUICK_CODE_LEN)),
    (b) => ALPHABET[b & 31]
  ).join("");
}

/** Fold what a person typed or pasted into the wire form, or "" if it cannot be one. */
export function normalizeQuickCode(input: string): string {
  const folded = input
    .trim()
    .replace(/[-\s]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return QUICK_CODE_RE.test(folded) ? folded : "";
}

export function isQuickCode(input: string): boolean {
  return normalizeQuickCode(input) !== "";
}

/** For display: `7QK3M9AB2C` -> `7QK-3M9A-B2C`. */
export function formatQuickCode(code: string): string {
  if (!QUICK_CODE_RE.test(code)) return code;
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}

/** For display: `6BMB3GST2JRJZ` -> `6BMB-3GST-2JRJ-Z`; other codes as is. */
export function formatRoomCode(code: string): string {
  if (!ROOM_CODE_RE.test(code)) return code;
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
}
