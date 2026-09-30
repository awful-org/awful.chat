import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { base64urlnopad as b64 } from "@scure/base";
import { derivePqKemKeypair } from "$lib/identity/pq-identity";
import { pairwiseRoomSecret } from "./pairwise";
import {
  confirmationsMatch,
  dmPqConfirmation,
  dmPqEncapsulate,
  dmPqRole,
  hybridPairwiseRoomSecret,
  parseDmPqState,
  type DmPqState,
} from "./pq-dm";
import { deriveRoomKeys } from "./keys";

function pair() {
  const one = crypto.getRandomValues(new Uint8Array(32));
  const two = crypto.getRandomValues(new Uint8Array(32));
  const e = dmPqRole(one, ed25519.getPublicKey(two)) === "encapsulator";
  const enc = e ? one : two, dec = e ? two : one;
  return {
    enc, dec,
    encPub: ed25519.getPublicKey(enc), decPub: ed25519.getPublicKey(dec),
    decKem: derivePqKemKeypair(dec).publicKey,
  };
}

describe("DM PQ roles", () => {
  it("give each pair exactly one encapsulator, the same from both ends", () => {
    const p = pair();
    expect(dmPqRole(p.enc, p.decPub)).toBe("encapsulator");
    expect(dmPqRole(p.dec, p.encPub)).toBe("decapsulator");
    expect(() => dmPqRole(p.enc, p.encPub)).toThrow();
  });

  it("refuse to encapsulate from the decapsulating side", () => {
    const p = pair();
    expect(() => dmPqEncapsulate(p.dec, p.encPub, derivePqKemKeypair(p.enc).publicKey)).toThrow();
  });
});

describe("hybrid DM secret", () => {
  it("is the same on both sides, and on every device of each identity", () => {
    const p = pair();
    const state = dmPqEncapsulate(p.enc, p.decPub, p.decKem);
    // A second device of the encapsulator, restored from the same seed,
    // produces the identical ciphertext - one conversation, one secret.
    expect(dmPqEncapsulate(new Uint8Array(p.enc), p.decPub, p.decKem)).toEqual(state);
    const atEnc = hybridPairwiseRoomSecret(p.enc, p.decPub, state);
    const atDec = hybridPairwiseRoomSecret(p.dec, p.encPub, state);
    expect(atEnc).toBe(atDec);
    expect(atEnc).toMatch(/^r2_[a-z2-7]{52}$/);
  });

  it("is not the classical secret, nor its rendezvous point", () => {
    const p = pair();
    const hybrid = hybridPairwiseRoomSecret(p.enc, p.decPub, dmPqEncapsulate(p.enc, p.decPub, p.decKem));
    const classical = pairwiseRoomSecret(p.enc, p.decPub);
    expect(hybrid).not.toBe(classical);
    expect(deriveRoomKeys(hybrid).discoveryId).not.toBe(deriveRoomKeys(classical).discoveryId);
  });

  it("differs per pair", () => {
    const p = pair(), q = pair();
    const a = hybridPairwiseRoomSecret(p.enc, p.decPub, dmPqEncapsulate(p.enc, p.decPub, p.decKem));
    const b = hybridPairwiseRoomSecret(q.enc, q.decPub, dmPqEncapsulate(q.enc, q.decPub, q.decKem));
    expect(a).not.toBe(b);
  });

  it("cannot be derived from public values plus the X25519 half: the KEM secret is needed", () => {
    const p = pair();
    const state = dmPqEncapsulate(p.enc, p.decPub, p.decKem);
    const real = hybridPairwiseRoomSecret(p.dec, p.encPub, state);
    // An attacker who can break X25519 knows the classical half and the
    // public ciphertext; decapsulating with any key but the recipient's gives
    // a different KEM secret (implicit rejection), hence another secret.
    const other = derivePqKemKeypair(crypto.getRandomValues(new Uint8Array(32)));
    const wrong = ml_kem768.decapsulate(b64.decode(state.ct), other.secretKey);
    const right = ml_kem768.decapsulate(b64.decode(state.ct), derivePqKemKeypair(p.dec).secretKey);
    expect(wrong).not.toEqual(right);
    expect(real).not.toBe(pairwiseRoomSecret(p.dec, p.encPub));
  });

  it("refuses a state for another conversation instead of deriving something", () => {
    const p = pair(), q = pair();
    const state = dmPqEncapsulate(p.enc, p.decPub, p.decKem);
    // The other pair's encapsulator recomputes and gets another ciphertext.
    expect(() => hybridPairwiseRoomSecret(q.enc, q.decPub, state)).toThrow();
    // A decapsulator refuses a state made for somebody else's key.
    expect(() => hybridPairwiseRoomSecret(q.dec, q.encPub, state)).toThrow();
  });

  it("refuses a tampered ciphertext at the encapsulator, and diverges at the decapsulator", () => {
    const p = pair();
    const state = dmPqEncapsulate(p.enc, p.decPub, p.decKem);
    const ct = b64.decode(state.ct);
    ct[10] ^= 1;
    const tampered: DmPqState = { ...state, ct: b64.encode(ct) };
    expect(() => hybridPairwiseRoomSecret(p.enc, p.decPub, tampered)).toThrow();
    // ML-KEM's implicit rejection: no error, just a secret nobody else has.
    // This is why the introduction confirms keys before storing a state.
    expect(hybridPairwiseRoomSecret(p.dec, p.encPub, tampered))
      .not.toBe(hybridPairwiseRoomSecret(p.dec, p.encPub, state));
  });

  it("validates the stored shape strictly", () => {
    const p = pair();
    const state = dmPqEncapsulate(p.enc, p.decPub, p.decKem);
    expect(parseDmPqState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    for (const bad of [
      null, {}, { ...state, v: 2 }, { ...state, ct: state.ct.slice(2) }, { ...state, ek: "" },
      { ...state, ct: state.ct + "A" }, { ...state, ek: 5 },
    ]) {
      expect(() => parseDmPqState(bad)).toThrow();
    }
  });
});

describe("DM PQ key confirmation", () => {
  it("matches only for the same secret, role and introduction", () => {
    const p = pair();
    const secret = hybridPairwiseRoomSecret(p.enc, p.decPub, dmPqEncapsulate(p.enc, p.decPub, p.decKem));
    const ctx = ["c1", "c2", "peer-a", "peer-b"];
    const tag = dmPqConfirmation(secret, "encapsulator", ctx);
    expect(confirmationsMatch(tag, dmPqConfirmation(secret, "encapsulator", ctx))).toBe(true);
    expect(confirmationsMatch(tag, dmPqConfirmation(secret, "decapsulator", ctx))).toBe(false);
    expect(confirmationsMatch(tag, dmPqConfirmation(secret, "encapsulator", ["c1", "c3", "peer-a", "peer-b"]))).toBe(false);
    expect(confirmationsMatch(tag, dmPqConfirmation(pairwiseRoomSecret(p.enc, p.decPub), "encapsulator", ctx))).toBe(false);
    expect(confirmationsMatch(tag, undefined)).toBe(false);
    expect(confirmationsMatch(tag, tag.slice(1))).toBe(false);
  });
});
