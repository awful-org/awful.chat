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
  /** The check after an upgrade that the other device followed; see UPGRADE_HEAL_DELAY_MS. */
  heal?: {
    schedule(run: () => void, ms: number): void;
    /** Still connected to that device at all. */
    connected(peer: string): boolean;
    /** That device is in our DM under its new (post-quantum) key. */
    meetsUnderNewKey(peer: string, did: string): Promise<boolean>;
    reintroduce(peer: string, did: string): Promise<unknown>;
    /** For the diagnostics: a split was found and is being healed. */
    note(peer: string): void;
  };
}

/**
 * How long after an upgrade to check the other device followed. The
 * introduction's last frame is what makes the second device switch; if it is
 * lost, one device is on the new key and the other on the old, and they no
 * longer meet in the DM (dm-introduction-stream.ts). The DM lobby heals that
 * too, but only after its registration delay - a minute or more. Checking
 * here, with the device we just spoke to, heals it in seconds.
 */
export const UPGRADE_HEAL_DELAY_MS = 15_000;
/** At most this many heals per device per window, so a device that keeps
 *  failing costs a couple of introductions, never a loop. */
const HEALS_PER_WINDOW = 2;
const HEAL_WINDOW_MS = 10 * 60_000;
const heals = new Map<string, number[]>();

function mayHeal(peer: string, now: number): boolean {
  const recent = (heals.get(peer) ?? []).filter((t) => now - t < HEAL_WINDOW_MS);
  if (recent.length >= HEALS_PER_WINDOW) {
    heals.set(peer, recent);
    return false;
  }
  recent.push(now);
  heals.delete(peer);
  heals.set(peer, recent);
  // Oldest first: bounded without forgetting everyone at once.
  while (heals.size > 256) heals.delete(heals.keys().next().value as string);
  return true;
}

/** Test hook: forget every heal. */
export function _resetHealsForTests(): void {
  heals.clear();
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
  const heal = deps.heal;
  if (!heal) return;
  // Whichever side switched first can be left alone on the new key if the
  // other never heard the last frame. Both sides check - the one that did
  // follow finds the other there and does nothing.
  heal.schedule(() => {
    void (async () => {
      if (!heal.connected(peer) || (await heal.meetsUnderNewKey(peer, did))) return;
      if (!mayHeal(peer, Date.now())) return;
      heal.note(peer);
      await heal.reintroduce(peer, did);
    })().catch(() => {});
  }, UPGRADE_HEAL_DELAY_MS);
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
