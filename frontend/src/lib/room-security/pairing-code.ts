/**
 * A short code's shape: reading one and writing one out.
 *
 * Kept apart from the pairing itself (invitation-pairing.ts, which says why
 * the code is this short) so that whatever only reads a code - a pasted
 * link, or an invite link opened before this device has an identity - does
 * not bring the pairing's cryptography with it.
 *
 * Lowercase Crockford base32: no i, l, o or u to confuse, and typed input
 * folds those to 1 and 0, in any case.
 */
export const PAIRING_LOCATOR_LENGTH = 2;
export const PAIRING_PASSWORD_LENGTH = 4;

export function parsePairingCode(input: string): { locator: string; password: string } | null {
  const raw = input.trim().toLowerCase().replace(/[-\s]/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
  const length = PAIRING_LOCATOR_LENGTH + PAIRING_PASSWORD_LENGTH;
  if (raw.length !== length || !/^[0-9a-hjkmnp-tv-z]+$/.test(raw)) return null;
  return { locator: raw.slice(0, PAIRING_LOCATOR_LENGTH), password: raw.slice(PAIRING_LOCATOR_LENGTH) };
}
/** Shown as two groups of three - "k5t-8r5" - whatever the split. */
export function formatPairingCode(locator: string, password: string): string {
  const code = locator + password;
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
