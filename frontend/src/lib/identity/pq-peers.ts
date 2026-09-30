/**
 * Where a peer's post-quantum key is looked up.
 *
 * Two places hold one: memory, filled from profiles heard this session, and
 * the peer's profile row, so the key is still known while they are offline -
 * which is exactly when the mailbox seals for them. Both hold the signed
 * certificate rather than the bare key, and it is re-verified here on every
 * lookup: a row can come from a backup import or a device sync, and nothing
 * that came in that way should be able to choose the key a message is sealed
 * to.
 */

import { getPeerProfile } from "$lib/storage";
import { onIdentityLock } from "./lock-events";
import { verifyPqKeyCertificate, type PqKeyCertificate } from "./pq-identity";

const heard = new Map<string, PqKeyCertificate>();
// Another account unlocking next must not inherit this one's contacts.
onIdentityLock(() => heard.clear());

/** Record a certificate that already verified against this DID. */
export function rememberPeerPqKey(did: string, cert: PqKeyCertificate): void {
  heard.set(did, cert);
}

/**
 * The verified ML-KEM-768 encapsulation key for a DID, or null when there is
 * none - a peer on an older build, or one we have never heard a profile from.
 * Null is not an error: callers fall back to the classical format, which is
 * what every message used before this existed.
 */
export async function peerPqKey(did: string): Promise<Uint8Array | null> {
  const live = heard.get(did);
  if (live) {
    const key = verifyPqKeyCertificate(did, live);
    if (key) return key;
  }
  const stored = await getPeerProfile(did).catch(() => undefined);
  return stored?.pqKey ? verifyPqKeyCertificate(did, stored.pqKey) : null;
}
