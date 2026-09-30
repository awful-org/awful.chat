import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

// The sender's policy is the part worth pinning: hybrid exactly when the
// recipient has published a PQ key, classical otherwise.
const peerKeys = new Map<string, Uint8Array>();
vi.mock("$lib/identity/pq-peers", () => ({
  peerPqKey: async (did: string) => peerKeys.get(did) ?? null,
}));
vi.mock("./transport.svelte", () => ({
  _transport: { selfId: () => "device" },
  broadcastProfile: () => {},
  deliverMailboxBatch: async () => {},
  deliverMailboxDm: async () => {},
  deliverMailboxReceipt: async () => {},
}));
vi.mock("$lib/runtime-config", () => ({ apiUrl: () => "https://relay.test" }));
const alice = (() => {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey };
})();
vi.mock("$lib/identity/identity", async (original) => {
  const real = await original<typeof import("$lib/identity/identity")>();
  return {
    ...real,
    isUnlocked: () => true,
    requireSession: () => ({ ...alice, did: real.publicKeyToDid(alice.publicKey) }),
  };
});

import { publicKeyToDid } from "$lib/identity/identity";
import { derivePqKemKeypair } from "$lib/identity/pq-identity";
import { openDmFromMailbox } from "$lib/mailbox-crypto";
import { depositDmToMailbox } from "./mailbox.svelte";

const deposits: Uint8Array[] = [];
beforeEach(() => {
  deposits.length = 0;
  peerKeys.clear();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { blob } = JSON.parse(init.body as string);
    deposits.push(Uint8Array.from(atob(blob), (c) => c.charCodeAt(0)));
    return new Response("{}", { status: 200 });
  });
});

function bob() {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, did: publicKeyToDid(ed25519.getPublicKey(privateKey)) };
}

it("seals hybrid for a recipient with a published PQ key", async () => {
  const b = bob();
  peerKeys.set(b.did, derivePqKemKeypair(b.privateKey).publicKey);
  expect(await depositDmToMailbox(b.did, new Uint8Array([1, 2, 3]))).toBe("sent");
  expect(deposits[0][0]).toBe(2);
  const opened = await openDmFromMailbox({ blob: deposits[0], selfDid: b.did, selfPrivateKey: b.privateKey });
  expect(opened.pq).toBe(true);
  expect(opened.envelope).toEqual(new Uint8Array([1, 2, 3]));
});

it("seals classical for a recipient without one, so an older build can still open it", async () => {
  const b = bob();
  expect(await depositDmToMailbox(b.did, new Uint8Array([4]))).toBe("sent");
  expect(deposits[0][0]).toBe(1);
  const opened = await openDmFromMailbox({ blob: deposits[0], selfDid: b.did, selfPrivateKey: b.privateKey });
  expect(opened.pq).toBe(false);
});

it("reports oversized for a PQ recipient instead of falling back to classical", async () => {
  const b = bob();
  peerKeys.set(b.did, derivePqKemKeypair(b.privateKey).publicKey);
  expect(await depositDmToMailbox(b.did, new Uint8Array(10_700))).toBe("oversized");
  expect(deposits).toHaveLength(0);
});
