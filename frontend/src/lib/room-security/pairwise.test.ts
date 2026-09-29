import { expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { pairwiseRoomSecret } from "./pairwise";

it("derives the same capability for both authenticated identities but not an outsider", () => {
  const alice = new Uint8Array(32).fill(1);
  const bob = new Uint8Array(32).fill(2);
  const outsider = new Uint8Array(32).fill(3);
  expect(pairwiseRoomSecret(alice, ed25519.getPublicKey(bob)))
    .toBe(pairwiseRoomSecret(bob, ed25519.getPublicKey(alice)));
  expect(pairwiseRoomSecret(outsider, ed25519.getPublicKey(bob)))
    .not.toBe(pairwiseRoomSecret(alice, ed25519.getPublicKey(bob)));
  expect(() => pairwiseRoomSecret(alice, ed25519.getPublicKey(alice))).toThrow();
});
