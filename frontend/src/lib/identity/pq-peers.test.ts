import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

const rows = new Map<string, unknown>();
vi.mock("$lib/storage", () => ({
  getPeerProfile: async (did: string) => rows.get(did),
}));

import { publicKeyToDid } from "./identity";
import { notifyIdentityLock } from "./lock-events";
import { derivePqKemKeypair, pqKeyCertificate } from "./pq-identity";
import { peerPqKey, rememberPeerPqKey } from "./pq-peers";

function identity() {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, did: publicKeyToDid(ed25519.getPublicKey(privateKey)) };
}

beforeEach(() => { rows.clear(); notifyIdentityLock(); });

it("finds a key heard live, and one stored while the peer is offline", async () => {
  const alice = identity(), bob = identity();
  rememberPeerPqKey(alice.did, pqKeyCertificate(alice));
  rows.set(bob.did, { did: bob.did, pqKey: pqKeyCertificate(bob) });
  expect(await peerPqKey(alice.did)).toEqual(derivePqKemKeypair(alice.privateKey).publicKey);
  expect(await peerPqKey(bob.did)).toEqual(derivePqKemKeypair(bob.privateKey).publicKey);
});

it("has no key for a peer that never published one, which is an older build", async () => {
  const alice = identity();
  rows.set(alice.did, { did: alice.did });
  expect(await peerPqKey(alice.did)).toBeNull();
  expect(await peerPqKey(identity().did)).toBeNull();
});

it("re-verifies a stored certificate, so an imported row cannot choose the key", async () => {
  const alice = identity(), mallory = identity();
  // Mallory's own valid certificate, filed under Alice's DID.
  rows.set(alice.did, { did: alice.did, pqKey: pqKeyCertificate(mallory) });
  expect(await peerPqKey(alice.did)).toBeNull();
});

it("forgets live keys when the identity locks", async () => {
  const alice = identity();
  rememberPeerPqKey(alice.did, pqKeyCertificate(alice));
  notifyIdentityLock();
  expect(await peerPqKey(alice.did)).toBeNull();
});
