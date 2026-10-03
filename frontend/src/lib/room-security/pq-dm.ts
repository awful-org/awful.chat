/**
 * Hybrid (post-quantum) DM keys.
 *
 * The v2 DM secret (pairwise.ts) is static X25519 between the two identity
 * keys, and both identity keys are public: they are the DIDs. Anyone who
 * records a DM today and has a quantum computer later derives the secret from
 * the two DIDs and reads everything. The v3 secret here keeps that X25519
 * half and adds an ML-KEM-768 shared secret, combined in one HKDF, so it holds
 * while EITHER half does.
 *
 * Design decisions, and why:
 *
 * One direction, fixed roles. Of the two identities, the one whose ed25519 key
 * sorts first (the same order pairwise.ts sorts them in) ENCAPSULATES to the
 * other's ML-KEM key; the other DECAPSULATES. One KEM exchange is all the
 * hybrid needs, and fixing who does it means two devices never race to
 * produce two different secrets.
 *
 * Deterministic encapsulation. ML-KEM encapsulation consumes 32 random bytes
 * (FIPS 203 "m"); here they are derived from the encapsulator's identity seed
 * and the pair, instead of drawn fresh. So every device of the encapsulating
 * identity - a phone and a laptop restored from the same phrase - produces the
 * SAME ciphertext and the same shared secret, and every device of the other
 * identity decapsulates it to that secret: one conversation has exactly one v3
 * secret, whichever devices happened to set it up. Security is unchanged
 * provided m stays secret and unpredictable, and it is a PRF output keyed by
 * the seed, which a quantum attacker does not get: Shor recovers the ed25519
 * scalar from a DID, but the scalar is a SHA-512 image of the seed. The cost
 * is that the secret has no forward secrecy - neither did v2, and this is a
 * DM capability, not a ratchet.
 *
 * The ciphertext is public and has to reach the decapsulator, so an upgrade
 * needs one exchange while both are online: the DM introduction
 * (dm-introduction-stream.ts), which already binds both DIDs to the two
 * devices. It carries the ciphertext and a key confirmation from each side, and
 * each side stores the result (DmPqState) on the DM's room record. Every
 * derivation re-checks the stored state: the encapsulator recomputes the
 * ciphertext and must get the stored one; the decapsulator checks the stored
 * key is its own. The decapsulator cannot detect a wrong ciphertext by itself
 * (ML-KEM's implicit rejection just yields an unrelated secret), which is what
 * the confirmations in the introduction are for.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { base64urlnopad as b64 } from "@scure/base";
import {
  derivePqKemKeypair,
  ML_KEM_768_CIPHERTEXT_BYTES,
  ML_KEM_768_PUBLIC_KEY_BYTES,
} from "$lib/identity/pq-identity";
import { b32, parseRoomSecret, type RoomSecret } from "./keys";

const te = new TextEncoder();
const SALT = te.encode("awful/dm/v3");

/** What a DM's room record keeps once the conversation is post-quantum. */
export interface DmPqState {
  v: 1;
  /** base64url ML-KEM-768 ciphertext, from the encapsulator. */
  ct: string;
  /** base64url ML-KEM-768 key of the DECAPSULATING identity. */
  ek: string;
}

export type DmPqRole = "encapsulator" | "decapsulator";

function identities(selfPublic: Uint8Array, remote: Uint8Array): string[] {
  const sorted = [b64.encode(selfPublic), b64.encode(remote)].sort();
  if (sorted[0] === sorted[1]) throw new Error("Cannot create a pairwise room with self");
  return sorted;
}

/** Which side of the KEM exchange this identity is, against that one. */
export function dmPqRole(identitySeed: Uint8Array, remoteIdentityKey: Uint8Array): DmPqRole {
  const self = b64.encode(ed25519.getPublicKey(identitySeed));
  return identities(ed25519.getPublicKey(identitySeed), remoteIdentityKey)[0] === self
    ? "encapsulator" : "decapsulator";
}

function exact(text: unknown, length: number, what: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`Invalid ${what}`);
  const bytes = b64.decode(text);
  if (bytes.length !== length || b64.encode(bytes) !== text) throw new Error(`Invalid ${what}`);
  return bytes;
}

/** Validate a stored or received state's shape, not yet its keys. */
export function parseDmPqState(input: unknown): DmPqState {
  if (!input || typeof input !== "object") throw new Error("Invalid DM PQ state");
  const s = input as DmPqState;
  if (s.v !== 1) throw new Error("Invalid DM PQ state");
  exact(s.ct, ML_KEM_768_CIPHERTEXT_BYTES, "DM PQ ciphertext");
  exact(s.ek, ML_KEM_768_PUBLIC_KEY_BYTES, "DM PQ key");
  return { v: 1, ct: s.ct, ek: s.ek };
}

/** The encapsulation randomness: secret to the encapsulating identity. */
function encapsulationSeed(identitySeed: Uint8Array, ids: string[], ek: Uint8Array): Uint8Array {
  return hkdf(sha256, identitySeed, SALT,
    te.encode(JSON.stringify(["awful/dm/v3/encapsulation", ids, b64.encode(sha256(ek))])), 32);
}

/**
 * The encapsulator's half of an upgrade: the state to send and store, for a
 * peer whose ML-KEM key came from a VERIFIED certificate.
 */
export function dmPqEncapsulate(
  identitySeed: Uint8Array,
  remoteIdentityKey: Uint8Array,
  remoteKemKey: Uint8Array,
): DmPqState {
  if (dmPqRole(identitySeed, remoteIdentityKey) !== "encapsulator") {
    throw new Error("This identity decapsulates in this conversation");
  }
  if (remoteKemKey.length !== ML_KEM_768_PUBLIC_KEY_BYTES) throw new Error("Invalid DM PQ key");
  const ids = identities(ed25519.getPublicKey(identitySeed), remoteIdentityKey);
  const m = encapsulationSeed(identitySeed, ids, remoteKemKey);
  try {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(remoteKemKey, m);
    sharedSecret.fill(0);
    return { v: 1, ct: b64.encode(cipherText), ek: b64.encode(remoteKemKey) };
  } finally {
    m.fill(0);
  }
}

/**
 * The v3 DM secret. Throws when the state does not belong to this pair - the
 * caller must then NOT fall back to the v2 secret on its own authority: an
 * upgraded conversation that silently went classical again is the downgrade
 * this whole exercise exists to prevent.
 */
export function hybridPairwiseRoomSecret(
  identitySeed: Uint8Array,
  remoteIdentityKey: Uint8Array,
  state: DmPqState,
): RoomSecret {
  const { ct: ctText, ek: ekText } = parseDmPqState(state);
  const ct = b64.decode(ctText);
  const ek = b64.decode(ekText);
  const ids = identities(ed25519.getPublicKey(identitySeed), remoteIdentityKey);
  const role = dmPqRole(identitySeed, remoteIdentityKey);

  let kemShared: Uint8Array;
  if (role === "encapsulator") {
    const m = encapsulationSeed(identitySeed, ids, ek);
    try {
      const again = ml_kem768.encapsulate(ek, m);
      if (b64.encode(again.cipherText) !== ctText) {
        again.sharedSecret.fill(0);
        throw new Error("DM PQ state does not belong to this conversation");
      }
      kemShared = again.sharedSecret;
    } finally {
      m.fill(0);
    }
  } else {
    const own = derivePqKemKeypair(identitySeed);
    try {
      if (b64.encode(own.publicKey) !== ekText) {
        throw new Error("DM PQ state was not made for this identity");
      }
      kemShared = ml_kem768.decapsulate(ct, own.secretKey);
    } finally {
      own.secretKey.fill(0);
    }
  }

  const xPrivate = ed25519.utils.toMontgomerySecret(identitySeed);
  const xShared = x25519.getSharedSecret(xPrivate, ed25519.utils.toMontgomery(remoteIdentityKey));
  const ikm = new Uint8Array(64);
  ikm.set(xShared, 0);
  ikm.set(kemShared, 32);
  try {
    // Every public input is in the info - both identities, the KEM key and the
    // ciphertext - so no half can be swapped for another yielding this secret.
    const root = hkdf(sha256, ikm, SALT, te.encode(JSON.stringify([
      "awful/dm/v3/secret", ids, b64.encode(sha256(ek)), b64.encode(sha256(ct)),
    ])), 32);
    try { return parseRoomSecret(`r2_${b32.encode(root)}`); }
    finally { root.fill(0); }
  } finally {
    xPrivate.fill(0); xShared.fill(0); kemShared.fill(0); ikm.fill(0);
  }
}

/**
 * Key confirmation: proof that a side derived THIS secret, bound to one
 * introduction (both challenges and both devices) so it means nothing
 * anywhere else. From a key independent of every room key (own salt and
 * label), so the tag reveals nothing about them.
 */
export function dmPqConfirmation(secret: RoomSecret, role: DmPqRole, context: readonly string[]): string {
  const root = b32.decode(parseRoomSecret(secret).slice(3));
  const key = hkdf(sha256, root, SALT, te.encode("awful/dm/v3/confirmation"), 32);
  try {
    return b64.encode(hmac(sha256, key, te.encode(JSON.stringify(["awful/dm/v3/confirm", role, context]))));
  } finally {
    root.fill(0); key.fill(0);
  }
}

/** Constant-time comparison of two confirmations. */
export function confirmationsMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
