import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  sealDmForMailbox,
  openDmFromMailbox,
  mailboxIdForDid,
} from "./mailbox-crypto";
import { publicKeyToDid } from "./identity/identity";

function identity() {
  const priv = ed25519.utils.randomSecretKey() as Uint8Array<ArrayBuffer>;
  const pub = ed25519.getPublicKey(priv);
  return { priv, did: publicKeyToDid(pub) };
}

describe("mailbox sealed box", () => {
  it("round-trips and authenticates the sender", async () => {
    const alice = identity();
    const bob = identity();
    const envelope = new TextEncoder().encode(
      JSON.stringify({ id: "m1", text: "hi from the past", ts: 1 })
    );

    const blob = await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope,
    });
    expect(blob).not.toBeNull();
    // Ciphertext only: neither the text nor the sender's did is readable.
    const raw = new TextDecoder().decode(blob!);
    expect(raw).not.toContain("hi from the past");
    expect(raw).not.toContain(alice.did.slice(9, 20));

    const opened = await openDmFromMailbox({
      blob: blob!,
      selfDid: bob.did,
      selfPrivateKey: bob.priv,
    });
    expect(opened.senderDid).toBe(alice.did);
    expect(new TextDecoder().decode(opened.envelope)).toContain(
      "hi from the past"
    );
  });

  it("a blob sealed for someone else does not open", async () => {
    const alice = identity();
    const bob = identity();
    const eve = identity();
    const blob = await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope: new Uint8Array([1, 2, 3]),
    });
    await expect(
      openDmFromMailbox({
        blob: blob!,
        selfDid: eve.did,
        selfPrivateKey: eve.priv,
      })
    ).rejects.toThrow();
  });

  it("a tampered blob is rejected", async () => {
    const alice = identity();
    const bob = identity();
    const blob = (await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope: new Uint8Array([9, 9, 9]),
    }))!;
    blob[blob.length - 1] ^= 0xff;
    await expect(
      openDmFromMailbox({
        blob,
        selfDid: bob.did,
        selfPrivateKey: bob.priv,
      })
    ).rejects.toThrow();
  });

  it("oversized envelopes refuse to seal (P2P retry covers them)", async () => {
    const alice = identity();
    const bob = identity();
    const blob = await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope: new Uint8Array(64 * 1024),
    });
    expect(blob).toBeNull();
  });

  it("carries the kind, and defaults to chat for blobs without one", async () => {
    const alice = identity();
    const bob = identity();
    const envelope = new Uint8Array([9, 9, 9]);

    for (const kind of ["chat", "batch", "receipt"] as const) {
      const blob = await sealDmForMailbox({
        senderDid: alice.did,
        senderPrivateKey: alice.priv,
        recipientDid: bob.did,
        envelope,
        kind,
      });
      const opened = await openDmFromMailbox({
        blob: blob!,
        selfDid: bob.did,
        selfPrivateKey: bob.priv,
      });
      expect(opened.kind).toBe(kind);
    }

    // A blob from before kinds existed is sealed exactly like an explicit
    // "chat" one, and reads back as chat.
    const legacy = await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope,
    });
    const opened = await openDmFromMailbox({
      blob: legacy!,
      selfDid: bob.did,
      selfPrivateKey: bob.priv,
    });
    expect(opened.kind).toBe("chat");
  });

  it("mailbox ids are stable hex hashes, not the did", async () => {
    const a = identity();
    const id1 = await mailboxIdForDid(a.did);
    const id2 = await mailboxIdForDid(a.did);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(id1).not.toContain("did");
  });
});
