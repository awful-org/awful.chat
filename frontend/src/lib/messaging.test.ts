import { beforeAll, describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalContent,
  canonicalContentV2,
  canonicalContentV3,
  computeSharedSecret,
  encryptForRecipient,
  signMessage,
  verifyMessage,
  verifyPeerBinding,
  verifySignature,
} from "./messaging";
import {
  createIdentity,
  deriveKeypairFromMnemonic,
  generateMnemonic,
  publicKeyToDid,
  didToPublicKey,
  requireSession,
} from "./identity/identity";
import { MessageType, type Message } from "./types/message";
import { hex, unhex, utf8 } from "./utils";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "0198c0de-0000-7000-8000-000000000001",
    roomCode: "test-room",
    senderId: "sender",
    senderName: "Tester",
    timestamp: 1234567890,
    lamport: 7,
    type: MessageType.Text,
    content: "hello world",
    attachments: [],
    ...overrides,
  };
}

beforeAll(async () => {
  // Creates + unlocks a real identity backed by fake-indexeddb
  await createIdentity("correct horse battery staple");
});

describe("sign / verify", () => {
  it("signs and verifies a message round-trip", async () => {
    const signed = signMessage(makeMessage());
    expect(signed.sig).toBeTruthy();
    expect(signed.senderDid).toBe(requireSession().did);
    expect(await verifyMessage(signed)).toBe(true);
  });

  it("rejects tampered content", async () => {
    const signed = signMessage(makeMessage());
    const tampered = { ...signed, content: "evil" };
    expect(await verifyMessage(tampered)).toBe(false);
  });

  it("rejects a signature from a different identity", async () => {
    const signed = signMessage(makeMessage());
    const other = deriveKeypairFromMnemonic(generateMnemonic());
    const forged = { ...signed, senderDid: publicKeyToDid(other.publicKey) };
    expect(await verifyMessage(forged)).toBe(false);
  });

  it("rejects messages without sig or did", async () => {
    expect(await verifyMessage(makeMessage())).toBe(false);
  });

  it("returns false (not throw) on garbage input", async () => {
    expect(await verifySignature("did:key:zzz", "nothex", "content")).toBe(
      false
    );
  });

  it("excludes timestamp from the canonical form", () => {
    const a = makeMessage({ timestamp: 1 });
    const b = makeMessage({ timestamp: 999 });
    expect(canonicalContent(a)).toBe(canonicalContent(b));
  });

  it("covers type and roomCode in v3 signatures", async () => {
    const signed = signMessage(makeMessage());
    expect(signed.sigV).toBe(3);
    expect(await verifyMessage(signed)).toBe(true);
    // A relaying peer flipping the type (Text -> PluginUpdate) or replaying
    // the message into another room must break the signature.
    expect(
      await verifyMessage({ ...signed, type: MessageType.PluginUpdate })
    ).toBe(false);
    expect(await verifyMessage({ ...signed, roomCode: "other-room" })).toBe(
      false
    );
  });

  it("still verifies v2 signatures (pre-v3 history)", async () => {
    const msg = makeMessage();
    const session = requireSession();
    const sig = hex(
      ed25519.sign(utf8(canonicalContentV2(msg)), session.privateKey)
    );
    const v2 = { ...msg, senderDid: session.did, sig, sigV: 2 };
    expect(await verifyMessage(v2)).toBe(true);
    // v2 never covered type/room - documents exactly what v3 closes.
    expect(
      await verifyMessage({ ...v2, type: MessageType.PluginUpdate })
    ).toBe(true);
    expect(await verifyMessage({ ...v2, content: "evil" })).toBe(false);
  });

  it("covers reaction fields in signatures", async () => {
    const signed = signMessage(
      makeMessage({
        type: MessageType.Reaction,
        content: "",
        reactionTo: "target-1",
        reactionEmoji: "👍",
        reactionOp: "add",
      })
    );
    expect(await verifyMessage(signed)).toBe(true);
    expect(await verifyMessage({ ...signed, reactionEmoji: "💀" })).toBe(false);
    expect(await verifyMessage({ ...signed, reactionOp: "remove" })).toBe(
      false
    );
    expect(await verifyMessage({ ...signed, reactionTo: "other" })).toBe(false);
  });

  it("covers file meta (infoHash) in signatures", async () => {
    const meta = {
      files: [
        { filename: "a.png", mimeType: "image/png", size: 10, infoHash: "aa" },
      ],
    };
    const signed = signMessage(makeMessage({ meta }));
    expect(await verifyMessage(signed)).toBe(true);
    const swapped = {
      ...signed,
      meta: { files: [{ ...meta.files[0], infoHash: "bb" }] },
    };
    expect(await verifyMessage(swapped)).toBe(false);
  });

  // @noble/curves verifies in ZIP215 mode by default, which accepts
  // small-order public keys. Under the cofactored equation an all-zero
  // signature then verifies over ANY message for a did:key that names a
  // torsion point, with no private key involved. verifySignature must pass
  // zip215:false so these are rejected.
  describe("small-order did:key forgery (ZIP215)", () => {
    // The two cheapest torsion points: the neutral element (y = 1) and a
    // canonical order-8 point.
    const SMALL_ORDER_KEYS: Record<string, Uint8Array> = {
      "identity point": Uint8Array.from([1, ...new Array(31).fill(0)]),
      "order-8 point": unhex(
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"
      ),
    };

    for (const [name, publicKey] of Object.entries(SMALL_ORDER_KEYS)) {
      it(`rejects a keyless forgery from a ${name} did`, async () => {
        const did = publicKeyToDid(publicKey);
        // R := A keeps R + [k]A inside the small-order subgroup, S := 0 makes
        // [8]S*B the identity, so the cofactored check passes for every msg.
        const forgedSig = new Uint8Array(64);
        forgedSig.set(publicKey, 0);
        const sig = hex(forgedSig);

        expect(await verifySignature(did, sig, "anything at all")).toBe(false);
        expect(
          await verifySignature(did, sig, "a completely different string")
        ).toBe(false);

        const forgedMsg = {
          ...makeMessage({ senderId: did, content: "I never wrote this" }),
          senderDid: did,
          sig,
          sigV: 3,
        };
        expect(await verifyMessage(forgedMsg)).toBe(false);

        // Same forgery aimed at the peerId<->did binding, which is what ties
        // a noise-authenticated connection to an identity.
        expect(await verifyPeerBinding(did, "12D3KooWvictim", sig)).toBe(false);
      });
    }

    it("still accepts a real signature from a real keypair", async () => {
      // Guards against "fixed" by making verify reject everything.
      const kp = deriveKeypairFromMnemonic(generateMnemonic());
      const msg = makeMessage();
      const sig = hex(
        ed25519.sign(utf8(canonicalContentV3(msg)), kp.privateKey)
      );
      expect(
        await verifySignature(
          publicKeyToDid(kp.publicKey),
          sig,
          canonicalContentV3(msg)
        )
      ).toBe(true);
    });
  });

  it("still verifies legacy v1 signatures (no sigV)", async () => {
    const msg = makeMessage();
    const session = requireSession();
    const sig = hex(
      ed25519.sign(utf8(canonicalContent(msg)), session.privateKey)
    );
    const legacy = { ...msg, senderDid: session.did, sig };
    expect(await verifyMessage(legacy)).toBe(true);
    expect(await verifyMessage({ ...legacy, content: "evil" })).toBe(false);
  });
});

describe("DM encryption", () => {
  it("shared secret is hashed, not raw ECDH output", () => {
    const other = deriveKeypairFromMnemonic(generateMnemonic());
    const secret = computeSharedSecret(other.publicKey);
    const session = requireSession();
    const raw = x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(session.privateKey),
      ed25519.utils.toMontgomery(other.publicKey)
    );
    expect(hex(secret)).not.toBe(hex(raw));
    expect(secret.length).toBe(32);
  });

  it("encrypts so the recipient's derived secret decrypts it", async () => {
    const recipient = deriveKeypairFromMnemonic(generateMnemonic());
    const recipientDid = publicKeyToDid(recipient.publicKey);
    const { iv, ct } = await encryptForRecipient("secret text", recipientDid);

    // Recipient side: same derivation from their private + our public key
    const session = requireSession();
    const raw = x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(recipient.privateKey),
      ed25519.utils.toMontgomery(didToPublicKey(publicKeyToDid(session.publicKey)))
    );
    const secret = sha256.create().update(utf8("awful-dm-v1")).update(raw).digest();

    const aesKey = await crypto.subtle.importKey(
      "raw",
      secret as Uint8Array<ArrayBuffer>,
      "AES-GCM",
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(iv) },
      aesKey,
      unhex(ct)
    );
    expect(new TextDecoder().decode(plaintext)).toBe("secret text");
  });
});

describe("did:key codec", () => {
  it("round-trips a public key", () => {
    const { publicKey } = deriveKeypairFromMnemonic(generateMnemonic());
    const did = publicKeyToDid(publicKey);
    expect(did.startsWith("did:key:")).toBe(true);
    expect(hex(didToPublicKey(did))).toBe(hex(publicKey));
  });

  it("throws on invalid did", () => {
    expect(() => didToPublicKey("not-a-did")).toThrow();
  });
});
