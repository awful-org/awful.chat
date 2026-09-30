import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid } from "$lib/identity/identity";
import { pqKeyCertificate } from "$lib/identity/pq-identity";
import type { DmPqState } from "$lib/room-security/pq-dm";
import {
  acceptProfilePqKey,
  onIntroductionUpgraded,
  onIntroductionVerified,
  type IntroductionHookDeps,
} from "./dm-pq-hooks";

function deps(opts: { bound?: string; exists?: boolean } = {}) {
  const calls: string[] = [];
  const d: IntroductionHookDeps = {
    boundDid: () => opts.bound,
    bind: (peer, did) => calls.push(`bind ${peer} ${did}`),
    dmExists: async () => opts.exists ?? false,
    ensureDm: async (did, state) => calls.push(state ? `ensure ${did} pq` : `ensure ${did}`),
    replayPending: (peer, did) => calls.push(`replay ${peer} ${did}`),
  };
  return { d, calls };
}

const STATE = { v: 1, ct: "c", ek: "e" } as DmPqState;

describe("onIntroductionVerified", () => {
  it("binds and creates the DM, as before, when no upgrade follows", async () => {
    const { d, calls } = deps();
    await onIntroductionVerified(d, "peer", "did:a", false);
    expect(calls).toEqual(["bind peer did:a", "ensure did:a", "replay peer did:a"]);
  });

  it("leaves a DM that does not exist yet for the upgrade to create post-quantum", async () => {
    const { d, calls } = deps({ exists: false });
    await onIntroductionVerified(d, "peer", "did:a", true);
    expect(calls).toEqual(["bind peer did:a", "replay peer did:a"]);
  });

  it("still joins a DM that exists, upgrade or not", async () => {
    const { d, calls } = deps({ exists: true });
    await onIntroductionVerified(d, "peer", "did:a", true);
    expect(calls).toEqual(["bind peer did:a", "ensure did:a", "replay peer did:a"]);
  });

  it("refuses a device already bound to another identity, touching nothing", async () => {
    const { d, calls } = deps({ bound: "did:other" });
    await expect(onIntroductionVerified(d, "peer", "did:a", false)).rejects.toThrow("Conflicting");
    expect(calls).toEqual([]);
  });
});

describe("onIntroductionUpgraded", () => {
  it("records the state only for the DID this introduction proved", async () => {
    const ok = deps({ bound: "did:a" });
    await onIntroductionUpgraded(ok.d, "peer", "did:a", STATE);
    expect(ok.calls).toEqual(["ensure did:a pq"]);

    const other = deps({ bound: "did:b" });
    await expect(onIntroductionUpgraded(other.d, "peer", "did:a", STATE)).rejects.toThrow("Conflicting");
    const unbound = deps();
    await expect(onIntroductionUpgraded(unbound.d, "peer", "did:a", STATE)).rejects.toThrow("Conflicting");
    expect([...other.calls, ...unbound.calls]).toEqual([]);
  });
});

describe("acceptProfilePqKey", () => {
  const seed = (n: number) => new Uint8Array(32).fill(n);
  const identity = (n: number) => ({ did: publicKeyToDid(ed25519.getPublicKey(seed(n))), privateKey: seed(n) });
  const alice = identity(1);
  const bob = identity(2);

  function hooks() {
    const remember = vi.fn();
    const offerUpgrade = vi.fn(async () => {});
    return { remember, offerUpgrade };
  }

  it("keeps a verified key and offers the DM upgrade to that device", () => {
    const h = hooks();
    const cert = pqKeyCertificate(alice);
    expect(acceptProfilePqKey(h, "peerA", alice.did, bob.did, cert)).toEqual(cert);
    expect(h.remember).toHaveBeenCalledWith(alice.did, cert);
    expect(h.offerUpgrade).toHaveBeenCalledWith("peerA", alice.did);
  });

  it("ignores a key signed for someone else, or missing, and offers nothing", () => {
    const h = hooks();
    expect(acceptProfilePqKey(h, "peerA", alice.did, bob.did, pqKeyCertificate(bob))).toBeUndefined();
    expect(acceptProfilePqKey(h, "peerA", alice.did, bob.did, undefined)).toBeUndefined();
    expect(acceptProfilePqKey(h, "peerA", alice.did, bob.did, { alg: "ml-kem-768", key: "x", sig: "y" })).toBeUndefined();
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.offerUpgrade).not.toHaveBeenCalled();
  });

  it("keeps extra fields out of what it stores", () => {
    const h = hooks();
    const cert = { ...pqKeyCertificate(alice), extra: "junk" };
    expect(acceptProfilePqKey(h, "peerA", alice.did, bob.did, cert)).toEqual(pqKeyCertificate(alice));
  });

  it("remembers our own other device's key but never offers ourselves a DM", () => {
    const h = hooks();
    acceptProfilePqKey(h, "myOtherDevice", alice.did, alice.did, pqKeyCertificate(alice));
    expect(h.remember).toHaveBeenCalledOnce();
    expect(h.offerUpgrade).not.toHaveBeenCalled();
  });

  it("never lets a failed offer escape", async () => {
    const h = { remember: vi.fn(), offerUpgrade: vi.fn(async () => { throw new Error("offline"); }) };
    expect(() => acceptProfilePqKey(h, "peerA", alice.did, bob.did, pqKeyCertificate(alice))).not.toThrow();
    await Promise.resolve();
  });
});
