/**
 * The app-side hooks of the post-quantum DM upgrade, apart from the transport
 * module so they can be tested without booting libp2p. transport.svelte.ts
 * wires them to the real peer map, DM store and upgrade offer.
 */

import {
  pickPqKeyCertificate,
  verifyPqKeyCertificate,
  type PqKeyCertificate,
} from "$lib/identity/pq-identity";
import type { DmPqState } from "$lib/room-security/pq-dm";

export interface IntroductionHookDeps {
  /** The DID already bound to this device, if any. */
  boundDid(peer: string): string | undefined;
  bind(peer: string, did: string): void;
  dmExists(did: string): Promise<boolean>;
  ensureDm(did: string, state?: DmPqState): Promise<unknown>;
  replayPending(peer: string, did: string): void;
}

/**
 * An introduction proved `did` owns `peer`. Bind them and make sure the DM
 * exists - except that a DM which does not exist yet, when a post-quantum
 * upgrade is about to follow, is left for the upgrade to create under the
 * hybrid key: joining it here would put it on the classical key for the
 * moments in between. If the upgrade then fails, the next ensureDm creates it
 * classically, exactly as for a peer on an older build.
 */
export async function onIntroductionVerified(
  deps: IntroductionHookDeps,
  peer: string,
  did: string,
  pqPending: boolean
): Promise<void> {
  const previous = deps.boundDid(peer);
  if (previous && previous !== did) throw new Error("Conflicting device identity");
  deps.bind(peer, did);
  if (!pqPending || (await deps.dmExists(did))) await deps.ensureDm(did);
  deps.replayPending(peer, did);
}

/**
 * Both devices confirmed the same post-quantum key: record it and move the
 * conversation onto it - only for the DID this very introduction proved.
 */
export async function onIntroductionUpgraded(
  deps: IntroductionHookDeps,
  peer: string,
  did: string,
  state: DmPqState
): Promise<void> {
  if (deps.boundDid(peer) !== did) throw new Error("Conflicting device identity");
  await deps.ensureDm(did, state);
}

/**
 * A proven profile's post-quantum key. It only counts once it verifies
 * against the DID the connection just proved: the certificate is the DID's
 * own signature, so a profile cannot attach someone else's key, or its own
 * key to someone else. A missing or bad one is ignored, never a reason to
 * drop a key we hold - the same person's other device may simply be on an
 * older build.
 *
 * The certificate is per profile, so per DEVICE: this device can do the
 * upgrade, so if our DM with its owner is still classical, offer the
 * introduction that upgrades it (the offer checks the rest and rate-limits).
 * Never for our own DID - our other devices share our DMs, not one with us.
 */
export function acceptProfilePqKey(
  deps: {
    remember(did: string, cert: PqKeyCertificate): void;
    offerUpgrade(peer: string, did: string): Promise<void>;
  },
  peer: string,
  did: string,
  selfDid: string,
  cert: unknown
): PqKeyCertificate | undefined {
  const pqKey =
    cert !== undefined && verifyPqKeyCertificate(did, cert) ? pickPqKeyCertificate(cert) : undefined;
  if (!pqKey) return undefined;
  deps.remember(did, pqKey);
  if (did !== selfDid) deps.offerUpgrade(peer, did).catch(() => {});
  return pqKey;
}
