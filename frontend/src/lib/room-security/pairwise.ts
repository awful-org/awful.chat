import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad as b64 } from "@scure/base";
import { b32, parseRoomSecret, type RoomSecret } from "./keys";

/** Existing local database reference; never a network discovery capability. */
export function pairwiseLocalId(selfDid: string, peerDid: string): string {
  const hash = sha256(new TextEncoder().encode([selfDid, peerDid].sort().join("|")));
  return "dm-" + Array.from(hash.subarray(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pairwise capability, NOT a hash of public DIDs. Callers must obtain the
 * remote identity key from a verified DID and retain normal sender signatures.
 * Static ECDH provides no forward secrecy; this is a distinct DM domain. */
export function pairwiseRoomSecret(identitySeed: Uint8Array, remoteIdentityKey: Uint8Array): RoomSecret {
  const selfPublic = ed25519.getPublicKey(identitySeed);
  const identities = [b64.encode(selfPublic), b64.encode(remoteIdentityKey)].sort();
  if (identities[0] === identities[1]) throw new Error("Cannot create a pairwise room with self");
  const privateKey = ed25519.utils.toMontgomerySecret(identitySeed);
  const shared = x25519.getSharedSecret(privateKey, ed25519.utils.toMontgomery(remoteIdentityKey));
  try {
    const root = hkdf(sha256, shared, new TextEncoder().encode("awful/dm/v2"),
      new TextEncoder().encode(JSON.stringify(identities)), 32);
    try { return parseRoomSecret(`r2_${b32.encode(root)}`); }
    finally { root.fill(0); }
  } finally { privateKey.fill(0); shared.fill(0); }
}
