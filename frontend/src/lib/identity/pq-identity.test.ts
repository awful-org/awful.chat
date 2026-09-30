import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { base64urlnopad as b64 } from "@scure/base";
import { deriveKeypairFromMnemonic, publicKeyToDid } from "./identity";
import {
  derivePqKemKeypair,
  ML_KEM_768_PUBLIC_KEY_BYTES,
  pickPqKeyCertificate,
  pqKeyCertificate,
  verifyPqKeyCertificate,
  type PqKeyCertificate,
} from "./pq-identity";

function identity() {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, did: publicKeyToDid(ed25519.getPublicKey(privateKey)) };
}

describe("PQ identity keys", () => {
  it("derive deterministically from the identity seed, so a restore needs nothing new", () => {
    const mnemonic =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const first = derivePqKemKeypair(deriveKeypairFromMnemonic(mnemonic).privateKey);
    const again = derivePqKemKeypair(deriveKeypairFromMnemonic(mnemonic).privateKey);
    expect(first.publicKey).toEqual(again.publicKey);
    expect(first.secretKey).toEqual(again.secretKey);
    expect(first.publicKey.length).toBe(ML_KEM_768_PUBLIC_KEY_BYTES);
    // Pinned: a change to the labels would silently re-key every account.
    expect(b64.encode(first.publicKey).slice(0, 24)).toMatchInlineSnapshot(`"McJzFESd2UAauwSc3Potp3Ih"`);
  });

  it("are separate keys per identity and actually agree on a secret", () => {
    const a = derivePqKemKeypair(new Uint8Array(32).fill(1));
    const b = derivePqKemKeypair(new Uint8Array(32).fill(2));
    expect(a.publicKey).not.toEqual(b.publicKey);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(a.publicKey);
    expect(ml_kem768.decapsulate(cipherText, a.secretKey)).toEqual(sharedSecret);
    expect(ml_kem768.decapsulate(cipherText, b.secretKey)).not.toEqual(sharedSecret);
  });

  it("refuses a seed of the wrong length", () => {
    expect(() => derivePqKemKeypair(new Uint8Array(31))).toThrow();
  });
});

describe("PQ key certificates", () => {
  it("verify for the DID that signed them and yield its key", () => {
    const alice = identity();
    const cert = pqKeyCertificate(alice);
    expect(verifyPqKeyCertificate(alice.did, cert)).toEqual(
      derivePqKemKeypair(alice.privateKey).publicKey
    );
    // Survives the wire.
    expect(verifyPqKeyCertificate(alice.did, JSON.parse(JSON.stringify(cert)))).not.toBeNull();
  });

  it("do not verify for another DID, which is what stops key substitution", () => {
    const alice = identity();
    const bob = identity();
    expect(verifyPqKeyCertificate(bob.did, pqKeyCertificate(alice))).toBeNull();
    // Nor does Bob's signature over Alice's key make it Alice's.
    const bobCert = pqKeyCertificate(bob);
    expect(
      verifyPqKeyCertificate(alice.did, { ...bobCert, key: pqKeyCertificate(alice).key })
    ).toBeNull();
  });

  it("reject tampering with the key, the signature or the algorithm", () => {
    const alice = identity();
    const cert = pqKeyCertificate(alice);
    const key = b64.decode(cert.key);
    key[100] ^= 1;
    expect(verifyPqKeyCertificate(alice.did, { ...cert, key: b64.encode(key) })).toBeNull();
    const sig = b64.decode(cert.sig);
    sig[3] ^= 1;
    expect(verifyPqKeyCertificate(alice.did, { ...cert, sig: b64.encode(sig) })).toBeNull();
    expect(verifyPqKeyCertificate(alice.did, { ...cert, alg: "ml-kem-512" })).toBeNull();
  });

  it("reject malformed input without throwing", () => {
    const alice = identity();
    const cert = pqKeyCertificate(alice);
    for (const bad of [
      undefined, null, "x", 7, {}, { ...cert, key: undefined }, { ...cert, sig: 12 },
      { ...cert, key: cert.key.slice(1) }, { ...cert, key: cert.key + "A" },
      { ...cert, key: cert.key.replace(/.$/, "=") },
    ]) {
      expect(verifyPqKeyCertificate(alice.did, bad)).toBeNull();
    }
    expect(verifyPqKeyCertificate("not a did", cert)).toBeNull();
  });

  it("refuse a signed key that ML-KEM would refuse to encapsulate to", () => {
    const alice = identity();
    const bad = derivePqKemKeypair(alice.privateKey).publicKey;
    bad[0] = 0xff;
    bad[1] = 0x0f; // first coefficient 4095 >= q
    expect(() => ml_kem768.encapsulate(bad)).toThrow();
    const key = b64.encode(bad);
    const sig = b64.encode(ed25519.sign(
      new TextEncoder().encode(JSON.stringify(["awful/pq-identity-cert/v1", alice.did, "ml-kem-768", key])),
      alice.privateKey,
    ));
    const cert: PqKeyCertificate = { alg: "ml-kem-768", key, sig };
    expect(verifyPqKeyCertificate(alice.did, cert)).toBeNull();
  });

  it("are computed once per identity", () => {
    const alice = identity();
    expect(pqKeyCertificate(alice)).toBe(pqKeyCertificate(alice));
  });

  it("refuse to certify a seed that is not the DID's", () => {
    const alice = identity();
    expect(() => pqKeyCertificate({ did: alice.did, privateKey: identity().privateKey })).toThrow();
  });

  it("are stored and forwarded with only their own fields", () => {
    const alice = identity();
    const cert = pqKeyCertificate(alice);
    expect(pickPqKeyCertificate({ ...cert, extra: "x" })).toEqual(cert);
    expect(pickPqKeyCertificate(null)).toBeUndefined();
  });
});
