import { expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { sealDmForMailbox } from "$lib/mailbox-crypto";
import { DmIntroductionChallenge, sealDmIntroduction } from "./dm-introduction";
import { pairwiseRoomSecret } from "./pairwise";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

const alice = identity();
const bob = identity();
function reply(challenge: DmIntroductionChallenge, senderPeer = "alice-device") {
  return sealDmIntroduction({ identity: alice, recipientDid: bob.did,
    senderPeer, recipientPeer: "bob-device", challenge: challenge.challenge });
}

it("verifies a first-contact identity and derives the same private room on both devices", async () => {
  const challenge = new DmIntroductionChallenge("bob-device", "alice-device");
  const result = await challenge.accept(await reply(challenge), bob);
  expect(result.senderDid).toBe(alice.did);
  expect(result.secret).toBe(pairwiseRoomSecret(alice.privateKey, bob.publicKey));
});

it("rejects concurrent and repeated responses to the same challenge", async () => {
  const challenge = new DmIntroductionChallenge("bob-device", "alice-device");
  const blob = await reply(challenge);
  const first = challenge.accept(blob, bob);
  await expect(challenge.accept(blob, bob)).rejects.toThrow("ended");
  await first;
  await expect(challenge.accept(blob, bob)).rejects.toThrow("ended");
});

it("rejects a response captured from a different connection challenge", async () => {
  const old = new DmIntroductionChallenge("bob-device", "alice-device");
  const fresh = new DmIntroductionChallenge("bob-device", "alice-device");
  await expect(fresh.accept(await reply(old), bob)).rejects.toThrow("binding");
});

it("rejects relaying a signed identity proof through another device", async () => {
  const challenge = new DmIntroductionChallenge("bob-device", "mallory-device");
  await expect(challenge.accept(await reply(challenge), bob)).rejects.toThrow("binding");
});

it("does not accept ordinary signed mailbox content as an introduction", async () => {
  const challenge = new DmIntroductionChallenge("bob-device", "alice-device");
  const blob = await sealDmForMailbox({ senderDid: alice.did, senderPrivateKey: alice.privateKey,
    recipientDid: bob.did, envelope: new TextEncoder().encode("hello") });
  await expect(challenge.accept(blob!, bob)).rejects.toThrow("binding");
});

it("rejects expiry, oversized replies, and disconnect during verification", async () => {
  let now = 0;
  const expired = new DmIntroductionChallenge("bob-device", "alice-device", () => now);
  const blob = await reply(expired);
  now = 10_000;
  await expect(expired.accept(blob, bob)).rejects.toThrow("ended");
  const oversized = new DmIntroductionChallenge("bob-device", "alice-device");
  await expect(oversized.accept(new Uint8Array(16_385), bob)).rejects.toThrow("large");
  const cancelled = new DmIntroductionChallenge("bob-device", "alice-device");
  const pending = cancelled.accept(await reply(cancelled), bob);
  cancelled.cancel();
  await expect(pending).rejects.toThrow("binding");
});

it("rejects a forged identity signature and a different recipient", async () => {
  const challenge = new DmIntroductionChallenge("bob-device", "alice-device");
  const forged = await sealDmIntroduction({ identity: { ...alice, did: bob.did },
    recipientDid: bob.did, senderPeer: "alice-device", recipientPeer: "bob-device",
    challenge: challenge.challenge });
  await expect(challenge.accept(forged, bob)).rejects.toThrow();
  const wrongRecipient = new DmIntroductionChallenge("bob-device", "alice-device");
  await expect(wrongRecipient.accept(await reply(wrongRecipient), identity())).rejects.toThrow();
});
