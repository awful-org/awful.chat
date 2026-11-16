/**
 * Whether a peer must not get our voice, given who is withheld and the
 * peer's identity if it is known yet.
 *
 * Fails closed: voice routinely connects before the profile exchange binds a
 * peer's identity, and once anybody at all is withheld, a peer nobody can name
 * yet might be that person. So an unknown peer gets nothing until its identity
 * binds - a second of silence for everyone else, never a second of voice for
 * the one person it was meant to be kept from.
 */
export function shouldWithholdVoice(
  withheld: ReadonlySet<string>,
  did: string | null | undefined,
): boolean {
  if (!withheld.size) return false;
  if (!did || !did.startsWith("did:")) return true;
  return withheld.has(did);
}
