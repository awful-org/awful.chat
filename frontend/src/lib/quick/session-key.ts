/**
 * The libp2p key a quick page connects under.
 *
 * Random, in memory, and NEVER device-key.ts's per-profile seed. Two nodes in
 * one browser profile is fine; two nodes sharing one peerId is the reconnect
 * loop from the 2026-09-04 and 09-06 diag packs, because the relay and every
 * peer keep one stream per peerId and the two starve each other.
 *
 * Minted once per page and reused, not generated per connect(): a relay
 * bounce rebuilds the node, and a peerId that changed with it would look to
 * everyone else like the person left and a stranger arrived - mid-call.
 */

let seed: Uint8Array | null = null;

export function quickSessionSeed(): Uint8Array {
  return (seed ??= crypto.getRandomValues(new Uint8Array(32)));
}
