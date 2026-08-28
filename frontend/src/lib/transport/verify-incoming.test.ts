import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyIncoming } from "./verify-incoming";
import { canonicalContentV3, canonicalContentV2 } from "../messaging";
import { MessageType, type WireChatMessage } from "../types/message";
import { hex, utf8 } from "../utils";
import { publicKeyToDid } from "../identity/identity";

/** A throwaway identity: private key plus the did:key it publishes as. */
function identity(seedByte: number) {
  const priv = new Uint8Array(32).fill(seedByte);
  const did = publicKeyToDid(ed25519.getPublicKey(priv));
  return { priv, did };
}

const ROOM = "a1b2c3";

function wire(over: Partial<WireChatMessage> = {}): WireChatMessage {
  return {
    type: MessageType.Text,
    id: "0198c0de-0000-7000-8000-000000000001",
    senderId: "unset",
    senderName: "Tester",
    timestamp: 1_700_000_000_000,
    lamport: 7,
    content: "hello",
    ...over,
  } as WireChatMessage;
}

/** Sign `w` as v3 with `key`, leaving senderId/senderDid exactly as given. */
function signV3(w: WireChatMessage, priv: Uint8Array, room = ROOM) {
  const sig = ed25519.sign(
    utf8(canonicalContentV3({ ...w, roomCode: room } as never)),
    priv
  );
  return { ...w, sig: hex(sig), sigV: 3 } as WireChatMessage;
}

describe("verifyIncoming", () => {
  const alice = identity(1);
  const mallory = identity(2);

  it("accepts a message properly signed by its claimed sender", async () => {
    const w = signV3(
      wire({ senderId: alice.did, senderDid: alice.did }),
      alice.priv
    );
    expect(await verifyIncoming(w, { room: ROOM })).toBe(true);
  });

  it("rejects a signature over a DIFFERENT room (v3 binds the room)", async () => {
    const w = signV3(
      wire({ senderId: alice.did, senderDid: alice.did }),
      alice.priv,
      "other-room"
    );
    expect(await verifyIncoming(w, { room: ROOM })).toBe(false);
  });

  it("rejects a flipped type on a valid signature (v3 binds the type)", async () => {
    const w = signV3(
      wire({ senderId: alice.did, senderDid: alice.did }),
      alice.priv
    );
    const flipped = {
      ...w,
      type: MessageType.PluginUpdate,
    } as WireChatMessage;
    expect(await verifyIncoming(flipped, { room: ROOM })).toBe(false);
  });

  // The forgery this module exists for: a senderId that is NOT in did:key
  // form used to skip the binding check entirely, so Mallory could sign a
  // message that every client attributed to Alice.
  it("rejects a peerId-form senderId signed by somebody else's key", async () => {
    const alicePeerId = "12D3KooWAliceLooksLikeThisInTheMesh";
    const w = signV3(
      wire({ senderId: alicePeerId, senderDid: mallory.did }),
      mallory.priv
    );
    expect(await verifyIncoming(w, { room: ROOM })).toBe(false);
  });

  it("rejects any mismatch between senderDid and senderId", async () => {
    const w = signV3(
      wire({ senderId: alice.did, senderDid: mallory.did }),
      mallory.priv
    );
    expect(await verifyIncoming(w, { room: ROOM })).toBe(false);
  });

  it("rejects every signature version but 3", async () => {
    const base = wire({ senderId: alice.did, senderDid: alice.did });
    for (const sigV of [undefined, 1, 2, 4, 99]) {
      const w = { ...base, sig: "00".repeat(64), sigV } as WireChatMessage;
      expect(await verifyIncoming(w, { room: ROOM })).toBe(false);
    }
  });

  // The 2026-08-28 sunset. v2 signs neither the type nor the room, so a
  // VALID v2 signature was still a working cross-room replay - and since
  // storage puts by the globally unique id, the replay MOVED the receiver's
  // original into the attacker's room rather than copying it.
  it("rejects a genuinely valid v2 signature (the sunset)", async () => {
    const w = wire({ senderId: alice.did, senderDid: alice.did });
    const sig = ed25519.sign(utf8(canonicalContentV2(w as never)), alice.priv);
    const signed = { ...w, sig: hex(sig), sigV: 2 } as WireChatMessage;
    expect(await verifyIncoming(signed, { room: ROOM })).toBe(false);
  });

  it("needs an authenticated room for v3 - never trusts the wire for it", async () => {
    const w = signV3(
      wire({ senderId: alice.did, senderDid: alice.did }),
      alice.priv
    );
    expect(await verifyIncoming(w, {})).toBe(false);
  });

  describe("unsigned rows", () => {
    const unsigned = wire({ senderId: alice.did, senderDid: alice.did });

    it("are rejected by default", async () => {
      expect(await verifyIncoming(unsigned, { room: ROOM })).toBe(false);
    });

    it("are allowed only where the caller opts in (DM sync)", async () => {
      expect(
        await verifyIncoming(unsigned, { room: ROOM, allowUnsigned: true })
      ).toBe(true);
    });
  });
});
