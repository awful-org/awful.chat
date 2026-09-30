import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlnopad as b64 } from "@scure/base";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { derivePqKemKeypair, pqKeyCertificate } from "$lib/identity/pq-identity";
import { attachDmIntroduction } from "./dm-introduction-stream";
import { DmIntroductionChallenge, sealDmIntroduction } from "./dm-introduction";
import {
  dmPqConfirmation, dmPqEncapsulate, dmPqRole, hybridPairwiseRoomSecret, type DmPqState,
} from "./pq-dm";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}
/** Two identities where `first` has the wanted role against `second`. */
function roles(firstRole: "encapsulator" | "decapsulator") {
  for (;;) {
    const first = identity(), second = identity();
    if (dmPqRole(first.privateKey, second.publicKey) === firstRole) return { first, second };
  }
}

class Stream extends EventTarget {
  other!: Stream;
  send(data: Uint8Array) {
    for (const bytes of [data.slice(0, 2), data.slice(2, 7), data.slice(7)]) {
      queueMicrotask(() => this.other.dispatchEvent(new MessageEvent("message", { data: bytes })));
    }
    return true;
  }
  abort() {}
  onDrain() { return Promise.resolve(); }
}
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const conn = (remote: string) => ({ status: "open", remotePeer: { toString: () => remote } }) as any;

/** Both ends running this build. */
function pair(alice: UnlockedSession, bob: UnlockedSession) {
  const a = new Stream(), b = new Stream(); a.other = b; b.other = a;
  const verifiedA = vi.fn(async (_did: string, _secret: string, _pending: boolean) => {});
  const verifiedB = vi.fn(async (_did: string, _secret: string, _pending: boolean) => {});
  const upgradedA = vi.fn(async (_did: string, _state: DmPqState) => {});
  const upgradedB = vi.fn(async (_did: string, _state: DmPqState) => {});
  const responder = attachDmIntroduction({ stream: b as any, connection: conn("alice-device"),
    local: "bob-device", identity: () => bob, verified: verifiedB, upgraded: upgradedB, onClose: () => {} });
  const initiator = attachDmIntroduction({ stream: a as any, connection: conn("bob-device"),
    local: "alice-device", identity: () => alice, initiate: {}, verified: verifiedA, upgraded: upgradedA, onClose: () => {} });
  closers.push(initiator.close, responder.close);
  return { initiator, responder, verifiedA, verifiedB, upgradedA, upgradedB };
}

/** A hand-driven end, for older builds and misbehaving peers. */
function manual(localPeer: string, remotePeer: string) {
  const mine = new Stream();
  const frames: any[] = [];
  let buffer = new Uint8Array(0);
  const waiters: (() => void)[] = [];
  mine.addEventListener("message", (event) => {
    const chunk = (event as MessageEvent).data as Uint8Array;
    const next = new Uint8Array(buffer.length + chunk.length); next.set(buffer); next.set(chunk, buffer.length); buffer = next;
    while (buffer.length >= 4) {
      const n = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (buffer.length < n + 4) break;
      frames.push(JSON.parse(new TextDecoder().decode(buffer.subarray(4, n + 4))));
      buffer = buffer.slice(n + 4);
      for (const w of waiters.splice(0)) w();
    }
  });
  return {
    stream: mine,
    connection: conn(remotePeer),
    localPeer,
    async frame(index: number) {
      while (frames.length <= index) await new Promise<void>((r) => waiters.push(r));
      return frames[index];
    },
    send(value: unknown) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const frame = new Uint8Array(bytes.length + 4);
      new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4);
      mine.send(frame);
    },
  };
}
function link(device: ReturnType<typeof manual>) {
  const theirs = new Stream(); theirs.other = device.stream; device.stream.other = theirs;
  return theirs;
}

describe("post-quantum DM upgrade in the introduction", () => {
  for (const initiatorRole of ["encapsulator", "decapsulator"] as const) {
    it(`agrees on one hybrid key when the initiator is the ${initiatorRole}`, async () => {
      const { first: alice, second: bob } = roles(initiatorRole);
      const p = pair(alice, bob);
      expect(await p.initiator.ready).toBe(true);
      expect(await p.responder.ready).toBe(true);
      await vi.waitFor(() => expect(p.upgradedA).toHaveBeenCalledOnce());
      expect(p.upgradedB).toHaveBeenCalledOnce();
      const [didSeenByA, stateA] = p.upgradedA.mock.calls[0];
      const [didSeenByB, stateB] = p.upgradedB.mock.calls[0];
      expect(didSeenByA).toBe(bob.did);
      expect(didSeenByB).toBe(alice.did);
      expect(stateA).toEqual(stateB);
      expect(hybridPairwiseRoomSecret(alice.privateKey, bob.publicKey, stateA))
        .toBe(hybridPairwiseRoomSecret(bob.privateKey, alice.publicKey, stateB));
      // The identity binding is published as before, first, and says an
      // upgrade is coming.
      expect(p.verifiedA).toHaveBeenCalledWith(bob.did, expect.any(String), true);
      expect(p.verifiedB).toHaveBeenCalledWith(alice.did, expect.any(String), true);
      expect(p.verifiedA.mock.invocationCallOrder[0]).toBeLessThan(p.upgradedA.mock.invocationCallOrder[0]);
      expect(p.verifiedB.mock.invocationCallOrder[0]).toBeLessThan(p.upgradedB.mock.invocationCallOrder[0]);
    });
  }

  it("stays classical with an older initiator, and it still completes", async () => {
    const alice = identity(), bob = identity();
    const old = manual("alice-device", "bob-device");
    const upgraded = vi.fn(), verified = vi.fn(async () => {});
    const responder = attachDmIntroduction({ stream: link(old) as any, connection: conn("alice-device"),
      local: "bob-device", identity: () => bob, verified, upgraded, onClose: () => {} });
    closers.push(responder.close);
    const mine = new DmIntroductionChallenge("alice-device", "bob-device");
    old.send({ did: alice.did, challenge: mine.challenge }); // no certificate: an old build
    const reply = await old.frame(0);
    // An old build compares transcripts byte for byte: this must open WITHOUT
    // accepting the PQ form.
    const opened = await mine.accept(b64.decode(reply.proof), alice);
    expect(opened.senderDid).toBe(bob.did);
    expect(opened.pq).toBeUndefined();
    old.send({ proof: b64.encode(await sealDmIntroduction({ identity: alice, recipientDid: bob.did,
      senderPeer: "alice-device", recipientPeer: "bob-device", challenge: reply.challenge })) });
    const done = await old.frame(1);
    expect(done).toEqual({ done: true });
    expect(await responder.ready).toBe(true);
    expect(verified).toHaveBeenCalledWith(alice.did, expect.any(String), false);
    expect(upgraded).not.toHaveBeenCalled();
  });

  it("stays classical with an older responder, and it still completes", async () => {
    const alice = identity(), bob = identity();
    const old = manual("bob-device", "alice-device");
    const upgraded = vi.fn(), verified = vi.fn(async () => {});
    const initiator = attachDmIntroduction({ stream: link(old) as any, connection: conn("bob-device"),
      local: "alice-device", identity: () => alice, initiate: {}, verified, upgraded, onClose: () => {} });
    closers.push(initiator.close);
    const hello = await old.frame(0);
    expect(hello.pq).toBeDefined(); // advertised, and an old build ignores it
    const mine = new DmIntroductionChallenge("bob-device", "alice-device");
    old.send({ proof: b64.encode(await sealDmIntroduction({ identity: bob, recipientDid: alice.did,
      senderPeer: "bob-device", recipientPeer: "alice-device", challenge: hello.challenge })),
      challenge: mine.challenge });
    const finish = await old.frame(1);
    const opened = await mine.accept(b64.decode(finish.proof), bob); // plain form only
    expect(opened.senderDid).toBe(alice.did);
    old.send({ done: true });
    expect(await initiator.ready).toBe(true);
    expect(upgraded).not.toHaveBeenCalled();
  });

  it("does not upgrade on a key confirmation that does not match, but still binds", async () => {
    // Bob encapsulates but confirms a different secret than the one his
    // ciphertext yields - a bug or a meddling peer. Alice must refuse.
    const { first: bob, second: alice } = roles("encapsulator");
    const peer = manual("bob-device", "alice-device");
    const upgraded = vi.fn(), verified = vi.fn(async () => {});
    const initiator = attachDmIntroduction({ stream: link(peer) as any, connection: conn("bob-device"),
      local: "alice-device", identity: () => alice, initiate: {}, verified, upgraded, onClose: () => {} });
    closers.push(initiator.close);
    const hello = await peer.frame(0);
    const mine = new DmIntroductionChallenge("bob-device", "alice-device");
    const state = dmPqEncapsulate(bob.privateKey, alice.publicKey, derivePqKemKeypair(alice.privateKey).publicKey);
    // The right secret, confirmed for some other introduction.
    const badConfirm = dmPqConfirmation(
      hybridPairwiseRoomSecret(bob.privateKey, alice.publicKey, state), "encapsulator", ["some", "other", "intro", "!"]);
    peer.send({ proof: b64.encode(await sealDmIntroduction({ identity: bob, recipientDid: alice.did,
      senderPeer: "bob-device", recipientPeer: "alice-device", challenge: hello.challenge,
      pq: { ct: state.ct, confirm: badConfirm } })), challenge: mine.challenge, pq: pqKeyCertificate(bob) });
    const finish = await peer.frame(1);
    const opened = await mine.accept(b64.decode(finish.proof), bob, { acceptPq: true });
    // Answered in the PQ form, with no confirmation: a refusal.
    expect(opened.pq).toEqual({});
    peer.send({ done: true, pq: true });
    expect(await initiator.ready).toBe(true);
    expect(verified).toHaveBeenCalled();
    expect(upgraded).not.toHaveBeenCalled();
  });

  it("does not upgrade when the responder never confirms adopting the key", async () => {
    const { first: alice, second: bob } = roles("decapsulator");
    const peer = manual("bob-device", "alice-device");
    const upgraded = vi.fn(), verified = vi.fn(async () => {});
    const initiator = attachDmIntroduction({ stream: link(peer) as any, connection: conn("bob-device"),
      local: "alice-device", identity: () => alice, initiate: {}, verified, upgraded, onClose: () => {} });
    closers.push(initiator.close);
    const hello = await peer.frame(0);
    const mine = new DmIntroductionChallenge("bob-device", "alice-device");
    const state = dmPqEncapsulate(bob.privateKey, alice.publicKey, derivePqKemKeypair(alice.privateKey).publicKey);
    const secret = hybridPairwiseRoomSecret(bob.privateKey, alice.publicKey, state);
    const context = [hello.challenge, mine.challenge, "alice-device", "bob-device"];
    peer.send({ proof: b64.encode(await sealDmIntroduction({ identity: bob, recipientDid: alice.did,
      senderPeer: "bob-device", recipientPeer: "alice-device", challenge: hello.challenge,
      pq: { ct: state.ct, confirm: dmPqConfirmation(secret, "encapsulator", context) } })),
      challenge: mine.challenge, pq: pqKeyCertificate(bob) });
    const finish = await peer.frame(1);
    const opened = await mine.accept(b64.decode(finish.proof), bob, { acceptPq: true });
    // Alice confirmed the right key...
    expect(opened.pq?.confirm).toBe(dmPqConfirmation(secret, "decapsulator", context));
    // ...but Bob's "done" does not say he adopted it.
    peer.send({ done: true });
    expect(await initiator.ready).toBe(true);
    expect(upgraded).not.toHaveBeenCalled();
  });

  it("ignores a certificate that is not the claimed DID's own", async () => {
    const alice = identity(), bob = identity(), mallory = identity();
    const peer = manual("alice-device", "bob-device");
    const upgraded = vi.fn();
    const responder = attachDmIntroduction({ stream: link(peer) as any, connection: conn("alice-device"),
      local: "bob-device", identity: () => bob, verified: async () => {}, upgraded, onClose: () => {} });
    closers.push(responder.close);
    const mine = new DmIntroductionChallenge("alice-device", "bob-device");
    // Alice's hello carrying Mallory's certificate: no PQ part may follow,
    // or Bob would be encapsulating to a key Alice does not hold.
    peer.send({ did: alice.did, challenge: mine.challenge, pq: pqKeyCertificate(mallory) });
    const reply = await peer.frame(0);
    const opened = await mine.accept(b64.decode(reply.proof), alice);
    expect(opened.pq).toBeUndefined();
    expect(upgraded).not.toHaveBeenCalled();
  });

  it("refuses the PQ form from a peer that was never offered it", async () => {
    const alice = identity(), bob = identity();
    const mine = new DmIntroductionChallenge("bob-device", "alice-device");
    const blob = await sealDmIntroduction({ identity: alice, recipientDid: bob.did,
      senderPeer: "alice-device", recipientPeer: "bob-device", challenge: mine.challenge, pq: {} });
    await expect(mine.accept(blob, bob)).rejects.toThrow("binding");
    const offered = new DmIntroductionChallenge("bob-device", "alice-device");
    const ok = await offered.accept(await sealDmIntroduction({ identity: alice, recipientDid: bob.did,
      senderPeer: "alice-device", recipientPeer: "bob-device", challenge: offered.challenge, pq: {} }), bob, { acceptPq: true });
    expect(ok.pq).toEqual({});
  });

  it("refuses a malformed PQ part", async () => {
    const alice = identity(), bob = identity();
    for (const pq of [{ ct: "short" }, { confirm: "x".repeat(43) + "=" }, { ct: b64.encode(new Uint8Array(1087)) }]) {
      const challenge = new DmIntroductionChallenge("bob-device", "alice-device");
      const blob = await sealDmIntroduction({ identity: alice, recipientDid: bob.did,
        senderPeer: "alice-device", recipientPeer: "bob-device", challenge: challenge.challenge, pq });
      await expect(challenge.accept(blob, bob, { acceptPq: true })).rejects.toThrow("binding");
    }
  });

  it("seals the proofs post-quantum between two current builds", async () => {
    const alice = identity(), bob = identity();
    const peer = manual("alice-device", "bob-device");
    const responder = attachDmIntroduction({ stream: link(peer) as any, connection: conn("alice-device"),
      local: "bob-device", identity: () => bob, verified: async () => {}, onClose: () => {} });
    closers.push(responder.close);
    const mine = new DmIntroductionChallenge("alice-device", "bob-device");
    peer.send({ did: alice.did, challenge: mine.challenge, pq: pqKeyCertificate(alice) });
    const reply = await peer.frame(0);
    expect(b64.decode(reply.proof)[0]).toBe(2); // the hybrid mailbox format
  });
});
