import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  sealDmForMailbox,
  openDmFromMailbox,
  mailboxIdForDid,
} from "./mailbox-crypto";
import { publicKeyToDid } from "./identity/identity";
import { derivePqKemKeypair } from "./identity/pq-identity";

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

describe("hybrid (post-quantum) mailbox format", () => {
  const pqKeyOf = (who: { priv: Uint8Array }) =>
    derivePqKemKeypair(who.priv).publicKey;
  const HEADER = 1 + 32 + 1088 + 12;

  async function sealHybrid(
    from: ReturnType<typeof identity>,
    toDid: string,
    pqKey: Uint8Array,
    envelope = new TextEncoder().encode("after the quantum computer"),
    kind?: "chat" | "batch" | "receipt"
  ) {
    return sealDmForMailbox({
      senderDid: from.did,
      senderPrivateKey: from.priv,
      recipientDid: toDid,
      envelope,
      kind,
      recipientPqKey: pqKey,
    });
  }

  it("round-trips, authenticates the sender and says it was hybrid", async () => {
    const alice = identity();
    const bob = identity();
    const blob = (await sealHybrid(alice, bob.did, pqKeyOf(bob)))!;
    expect(blob[0]).toBe(2);
    expect(new TextDecoder().decode(blob)).not.toContain("quantum");
    const opened = await openDmFromMailbox({
      blob,
      selfDid: bob.did,
      selfPrivateKey: bob.priv,
    });
    expect(opened.pq).toBe(true);
    expect(opened.senderDid).toBe(alice.did);
    expect(new TextDecoder().decode(opened.envelope)).toBe(
      "after the quantum computer"
    );
  });

  it("still opens v1 blobs, which older builds keep sending", async () => {
    const alice = identity();
    const bob = identity();
    const blob = (await sealDmForMailbox({
      senderDid: alice.did,
      senderPrivateKey: alice.priv,
      recipientDid: bob.did,
      envelope: new Uint8Array([4, 2]),
    }))!;
    expect(blob[0]).toBe(1);
    const opened = await openDmFromMailbox({
      blob,
      selfDid: bob.did,
      selfPrivateKey: bob.priv,
    });
    expect(opened.pq).toBe(false);
    expect(opened.envelope).toEqual(new Uint8Array([4, 2]));
  });

  it("carries the kind like v1 does", async () => {
    const alice = identity();
    const bob = identity();
    for (const kind of ["chat", "batch", "receipt"] as const) {
      const blob = await sealHybrid(alice, bob.did, pqKeyOf(bob), new Uint8Array([1]), kind);
      const opened = await openDmFromMailbox({
        blob: blob!,
        selfDid: bob.did,
        selfPrivateKey: bob.priv,
      });
      expect(opened.kind).toBe(kind);
    }
  });

  it("does not open for anyone else", async () => {
    const alice = identity();
    const bob = identity();
    const eve = identity();
    const blob = (await sealHybrid(alice, bob.did, pqKeyOf(bob)))!;
    await expect(
      openDmFromMailbox({ blob, selfDid: eve.did, selfPrivateKey: eve.priv })
    ).rejects.toThrow();
  });

  it("needs BOTH halves: the X25519 key alone or the ML-KEM key alone opens nothing", async () => {
    const alice = identity();
    const bob = identity();
    const eve = identity();
    // Right X25519 recipient, somebody else's ML-KEM key.
    const wrongKem = (await sealHybrid(alice, bob.did, pqKeyOf(eve)))!;
    await expect(
      openDmFromMailbox({ blob: wrongKem, selfDid: bob.did, selfPrivateKey: bob.priv })
    ).rejects.toThrow();
    // Right ML-KEM key, somebody else's X25519 recipient: neither the holder
    // of the KEM key nor the holder of the X25519 key can open it.
    const wrongX = (await sealHybrid(alice, eve.did, pqKeyOf(bob)))!;
    await expect(
      openDmFromMailbox({ blob: wrongX, selfDid: bob.did, selfPrivateKey: bob.priv })
    ).rejects.toThrow();
    await expect(
      openDmFromMailbox({ blob: wrongX, selfDid: eve.did, selfPrivateKey: eve.priv })
    ).rejects.toThrow();
  });

  it("rejects tampering anywhere in the blob, including a downgraded version byte", async () => {
    const alice = identity();
    const bob = identity();
    const blob = (await sealHybrid(alice, bob.did, pqKeyOf(bob)))!;
    const positions = {
      version: 0,
      ephemeral: 5,
      kemCiphertext: 33 + 500,
      iv: HEADER - 3,
      ciphertext: HEADER + 20,
      tag: blob.length - 1,
    };
    for (const [where, at] of Object.entries(positions)) {
      const copy = new Uint8Array(blob);
      copy[at] ^= where === "version" ? 3 : 0x40; // 2 -> 1 for the version
      await expect(
        openDmFromMailbox({ blob: copy, selfDid: bob.did, selfPrivateKey: bob.priv }),
        where
      ).rejects.toThrow();
    }
    await expect(
      openDmFromMailbox({
        blob: blob.subarray(0, HEADER + 10),
        selfDid: bob.did,
        selfPrivateKey: bob.priv,
      })
    ).rejects.toThrow();
  });

  it("pads to fixed sizes under the relay's 16 KiB cap, and refuses rather than downgrades", async () => {
    const alice = identity();
    const bob = identity();
    const small = (await sealHybrid(alice, bob.did, pqKeyOf(bob), new Uint8Array(10)))!;
    expect(small.length).toBe(HEADER + 1024 + 16);
    // The largest hybrid bucket still fits the relay.
    const large = (await sealHybrid(alice, bob.did, pqKeyOf(bob), new Uint8Array(10_000)))!;
    expect(large.length).toBe(HEADER + 14 * 1024 + 16);
    expect(large.length).toBeLessThanOrEqual(16 * 1024);
    // Fits v1's 15 KiB bucket but not v2's: no blob at all, never a v1 one.
    const between = new Uint8Array(10_700);
    expect(
      await sealDmForMailbox({
        senderDid: alice.did,
        senderPrivateKey: alice.priv,
        recipientDid: bob.did,
        envelope: between,
      })
    ).not.toBeNull();
    expect(await sealHybrid(alice, bob.did, pqKeyOf(bob), between)).toBeNull();
  });

  it("refuses a PQ key of the wrong size instead of sealing to it", async () => {
    const alice = identity();
    const bob = identity();
    await expect(
      sealHybrid(alice, bob.did, new Uint8Array(800))
    ).rejects.toThrow();
  });
});
