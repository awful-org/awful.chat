import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalContentV3 } from "../messaging";
import { MessageType, type WireChatMessage } from "../types/message";
import { hex, utf8 } from "../utils";
import { publicKeyToDid } from "../identity/identity";

// The real verifier, wrapped so the test can count how often it runs.
const verifySpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../messaging", async (original) => {
  const real = await original<typeof import("../messaging")>();
  return {
    ...real,
    verifySignature: async (did: string, sig: string, content: string) => {
      verifySpy.calls++;
      return real.verifySignature(did, sig, content);
    },
  };
});

import { _resetVerifiedSignatures, verifyIncoming } from "./verify-incoming";

const ROOM = "rd2_memo";
const priv = new Uint8Array(32).fill(3);
const did = publicKeyToDid(ed25519.getPublicKey(priv));

function signed(over: Partial<WireChatMessage> = {}): WireChatMessage {
  const w = {
    type: MessageType.Text,
    id: "0198c0de-0000-7000-8000-000000000001",
    senderId: did,
    senderDid: did,
    senderName: "Tester",
    timestamp: 1,
    lamport: 7,
    content: "hello",
    ...over,
  } as WireChatMessage;
  const sig = ed25519.sign(utf8(canonicalContentV3({ ...w, roomCode: ROOM } as never)), priv);
  return { ...w, sig: hex(sig), sigV: 3 } as WireChatMessage;
}

describe("verifyIncoming signature memo", () => {
  beforeEach(() => {
    _resetVerifiedSignatures();
    verifySpy.calls = 0;
  });

  it("verifies a row once however many copies of it arrive", async () => {
    const w = signed();
    for (let i = 0; i < 5; i++) {
      expect(await verifyIncoming({ ...w }, { room: ROOM })).toEqual({ ok: true });
    }
    expect(verifySpy.calls).toBe(1);
  });

  it("does not let a remembered signature vouch for different content", async () => {
    const w = signed();
    expect(await verifyIncoming(w, { room: ROOM })).toEqual({ ok: true });
    expect(await verifyIncoming({ ...w, content: "forged" }, { room: ROOM }))
      .toEqual({ ok: false, reason: "bad-signature" });
    // Nor for the same row filed under another room.
    expect(await verifyIncoming(w, { room: "rd2_other" }))
      .toEqual({ ok: false, reason: "bad-signature" });
  });

  it("checks a failed signature again every time", async () => {
    const w = { ...signed(), content: "tampered" };
    for (let i = 0; i < 3; i++) {
      expect(await verifyIncoming(w, { room: ROOM })).toMatchObject({ ok: false });
    }
    expect(verifySpy.calls).toBe(3);
  });

  it("still runs the cheap checks on a remembered row", async () => {
    const w = signed();
    expect(await verifyIncoming(w, { room: ROOM })).toEqual({ ok: true });
    expect(await verifyIncoming({ ...w, content: "x".repeat(20_000) }, { room: ROOM }))
      .toEqual({ ok: false, reason: "content-oversize" });
    expect(await verifyIncoming(w, {})).toEqual({ ok: false, reason: "no-room" });
  });
});
