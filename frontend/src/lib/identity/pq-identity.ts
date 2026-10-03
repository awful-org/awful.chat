/**
 * Post-quantum identity keys: an ML-KEM-768 keypair beside the ed25519 one.
 *
 * Why it exists: every key agreement the app did with a person's identity was
 * X25519 against their ed25519 key, and that key is public - it IS the did:key.
 * A recording of today's traffic plus a large enough quantum computer later
 * recovers the X25519 secrets from the DIDs alone. ML-KEM gives each identity
 * a key agreement that survives that, and the hybrid formats built on it
 * (mailbox-crypto.ts, room-security/pq-dm.ts) combine it with X25519 so they
 * are never weaker than what they replace.
 *
 * Derivation: from the same 32-byte identity seed the ed25519 key is, through
 * a domain-separated HKDF. A restored or synced account therefore gets the
 * same PQ keys with nothing new to back up, and the key never has to be
 * stored - it is re-derived where it is needed and wiped after. A quantum
 * attacker who recovers the ed25519 SCALAR from the public key still does not
 * have the seed (the scalar is a SHA-512 image of it), so this derivation is
 * as out of reach as the at-rest storage key, which comes from the seed too.
 *
 * Publishing: the encapsulation key travels as a certificate - the DID's own
 * ed25519 signature over it - so it is self-certifying: it can come in a
 * profile, a DM introduction or a stored row and be re-verified wherever it is
 * used, without trusting the path it arrived by. That signature is classical,
 * which is deliberate rather than overlooked: forging it needs a quantum
 * computer at the moment the key is used (an active attack), while the threat
 * this closes is a recording being decrypted later, for which the signature
 * only has to hold today.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { base64urlnopad as b64 } from "@scure/base";
import { didToPublicKey } from "./identity";

export const ML_KEM_768_PUBLIC_KEY_BYTES = 1184;
export const ML_KEM_768_CIPHERTEXT_BYTES = 1088;
export const PQ_KEM_ALG = "ml-kem-768";

const te = new TextEncoder();
const SEED_SALT = te.encode("awful/pq-identity");
// Versioned: a future parameter change gets a new label, and with it a new
// key, rather than silently reinterpreting this one.
const KEM_SEED_INFO = te.encode("awful/pq-identity/ml-kem-768/v1");
const CERT_DOMAIN = "awful/pq-identity-cert/v1";

/** The published form: the encapsulation key and the DID's signature over it. */
export interface PqKeyCertificate {
  alg: typeof PQ_KEM_ALG;
  /** base64url (no padding) ML-KEM-768 encapsulation key. */
  key: string;
  /** base64url (no padding) ed25519 signature by the DID over the statement. */
  sig: string;
}

/**
 * The ML-KEM-768 keypair for an identity seed. The caller owns `secretKey`
 * and must wipe it (fill(0)) as soon as it is done - it is never cached.
 */
export function derivePqKemKeypair(identitySeed: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  if (identitySeed.length !== 32) throw new Error("Invalid identity seed");
  // FIPS 203 keygen takes d || z, 64 bytes; both come from the one HKDF
  // output, which is what "deterministic from the seed" requires.
  const kemSeed = hkdf(sha256, identitySeed, SEED_SALT, KEM_SEED_INFO, 64);
  try {
    return ml_kem768.keygen(kemSeed);
  } finally {
    kemSeed.fill(0);
  }
}

function statement(did: string, key: string): Uint8Array {
  return te.encode(JSON.stringify([CERT_DOMAIN, did, PQ_KEM_ALG, key]));
}

// Public data only, and a pure function of the DID: one entry per identity
// this device has unlocked this page, so the profile path does not pay for a
// keygen and a signature on every send.
const ownCertificates = new Map<string, PqKeyCertificate>();

/** This identity's certificate. `privateKey` is the ed25519 identity seed. */
export function pqKeyCertificate(identity: {
  did: string;
  privateKey: Uint8Array;
}): PqKeyCertificate {
  const cached = ownCertificates.get(identity.did);
  if (cached) return cached;
  const { publicKey, secretKey } = derivePqKemKeypair(identity.privateKey);
  secretKey.fill(0);
  const key = b64.encode(publicKey);
  const sig = b64.encode(ed25519.sign(statement(identity.did, key), identity.privateKey));
  const cert: PqKeyCertificate = { alg: PQ_KEM_ALG, key, sig };
  // Never cache a certificate that does not verify: a seed that does not
  // belong to this DID (a caller bug) must not poison every later send.
  if (!verifyPqKeyCertificate(identity.did, cert)) throw new Error("Identity seed does not match its DID");
  ownCertificates.set(identity.did, cert);
  return cert;
}

/** Decode base64url only in its canonical form, so one value has one encoding. */
function canonical(text: unknown, length: number): Uint8Array | null {
  if (typeof text !== "string" || text.length !== Math.ceil((length * 4) / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bytes = b64.decode(text);
    return bytes.length === length && b64.encode(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * FIPS 203 7.2 encapsulation-key check: every packed 12-bit coefficient of t
 * must already be reduced mod q. Encapsulating to a key that fails it throws,
 * so it is refused where keys enter rather than where a message is sealed.
 */
function wellFormedKemKey(key: Uint8Array): boolean {
  const packed = ML_KEM_768_PUBLIC_KEY_BYTES - 32; // t, then the 32-byte rho
  for (let i = 0; i < packed; i += 3) {
    const a = key[i] | ((key[i + 1] & 0x0f) << 8);
    const b = (key[i + 1] >> 4) | (key[i + 2] << 4);
    if (a >= 3329 || b >= 3329) return false;
  }
  return true;
}

/**
 * The verified encapsulation key, or null for anything else - a missing,
 * malformed, re-encoded or forged certificate, or one for another DID. Never
 * throws: callers treat null as "this peer has no PQ key", which is what an
 * older build looks like too.
 */
export function verifyPqKeyCertificate(did: string, cert: unknown): Uint8Array | null {
  try {
    if (!cert || typeof cert !== "object") return null;
    const c = cert as Partial<PqKeyCertificate>;
    if (c.alg !== PQ_KEM_ALG) return null;
    const key = canonical(c.key, ML_KEM_768_PUBLIC_KEY_BYTES);
    const sig = canonical(c.sig, 64);
    if (!key || !sig || !wellFormedKemKey(key)) return null;
    // zip215:false for the reason messaging.ts gives: a did:key naming a
    // small-order point would otherwise "sign" any key anyone likes.
    const ok = ed25519.verify(sig, statement(did, c.key as string), didToPublicKey(did), { zip215: false });
    return ok ? key : null;
  } catch {
    return null;
  }
}

/** Only the three fields, so a stored or forwarded copy carries nothing else. */
export function pickPqKeyCertificate(cert: unknown): PqKeyCertificate | undefined {
  if (!cert || typeof cert !== "object") return undefined;
  const { alg, key, sig } = cert as PqKeyCertificate;
  return { alg, key, sig };
}
