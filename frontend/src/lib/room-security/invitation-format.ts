import { parseRoomSecret, type RoomSecret } from "./keys";

/** Capability links must never put their secret in a URL path or query. */
export function parseSecureInvitation(input: string): RoomSecret {
  const raw = input.trim();
  // Any case: parseRoomSecret folds a capitalised secret to its lowercase form.
  if (/^r2_/i.test(raw)) return parseRoomSecret(raw);
  if (raw.startsWith("web+awfl://")) return parseProtocolInvitation(raw);
  const url = new URL(raw, "https://room.invalid");
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/r/" || url.search) {
    throw new Error("Invalid secure room invitation");
  }
  const fragment = decodeURIComponent(url.hash.slice(1));
  return fragment.startsWith("web+awfl://")
    ? parseProtocolInvitation(fragment)
    : parseRoomSecret(fragment);
}

/**
 * The invitation in text somebody pasted: the link with no scheme, with a
 * tracking parameter, without the slash before its #, with the full stop or
 * the bracket after it, or in the middle of the message it came in.
 *
 * Bare, or in the fragment of an `/r/` address and no other: a quick call's
 * and a quick send's links (`/qc#`, `/qs#`) hold a secret of the same shape,
 * and are not rooms to join. One room only: text with two invitations in it
 * does not say which was meant. The secret has to stand on its own, so a cut
 * or lengthened one is not taken for another room. The lengths are bounded,
 * so no text makes the search slow.
 */
const IN_TEXT_RE =
  /(?:^|[\s<>([{"'*_~`|])(?:(?:[a-z][a-z0-9+.-]{0,20}:\/\/)?[^/?#\s]{0,255}\/r\/?(?:(?:\?[^#\s]{0,2048})?#|%23))?(r2_[a-z2-7]{52})(?=[.,;:!?)>\]}"'*_~`|]{0,16}(?:\s|$))/gi;

export function findInvitation(text: string): RoomSecret | null {
  const found = new Set<RoomSecret>();
  for (const [, secret] of text.matchAll(IN_TEXT_RE)) {
    try { found.add(parseRoomSecret(secret)); } catch { /* Not one after all. */ }
  }
  return found.size === 1 ? [...found][0] : null;
}

function parseProtocolInvitation(input: string): RoomSecret {
  // Not parsed as a URL: the secret is not a hostname. Its case no longer
  // matters (lowercase base32, see keys.ts), so a browser folding it is fine.
  const value = input.slice("web+awfl://".length);
  return parseRoomSecret(value.startsWith("r/#") ? value.slice(3) : value);
}

export function secureInvitationLink(origin: string, secret: RoomSecret): string {
  parseRoomSecret(secret);
  const base = new URL(origin);
  if (!/^https?:$/.test(base.protocol)) throw new Error("Invalid invitation origin");
  return `${base.origin}/r/#${secret}`;
}
