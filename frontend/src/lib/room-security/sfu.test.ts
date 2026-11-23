import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlnopad } from "@scure/base";
import { deriveRoomKeys, newRoomSecret } from "./keys";
import { roomSfuAdmission } from "./sfu";
import { verifyRoomAdmission } from "../../../../sfu/auth";

it("verifies browser-generated room capabilities with the SFU verifier", () => {
  const keys = deriveRoomKeys(newRoomSecret());
  const nonce = "ab".repeat(32);
  const proof = roomSfuAdmission(keys, nonce, "alice");
  expect(verifyRoomAdmission(nonce, proof.roomCode, "alice", proof.capability)).toBe(true);
  expect(verifyRoomAdmission("cd".repeat(32), proof.roomCode, "alice", proof.capability)).toBe(false);
  expect(verifyRoomAdmission(nonce, proof.roomCode, "mallory", proof.capability)).toBe(false);
  expect(verifyRoomAdmission(nonce, proof.roomCode, "alice", undefined)).toBe(false);
  expect(verifyRoomAdmission(nonce, keys.discoveryId, "alice", proof.capability)).toBe(false);
});

describe("an SFU room per voice channel", () => {
  const nonce = "ab".repeat(32);

  it("keeps the default channel on the room's own SFU id, so old clients still meet new ones", () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const legacyId = `rs2_${base64urlnopad.encode(ed25519.getPublicKey(keys.sfuSigningSeed))}`;
    expect(roomSfuAdmission(keys, nonce, "alice").roomCode).toBe(legacyId);
    expect(roomSfuAdmission(keys, nonce, "alice", "").roomCode).toBe(legacyId);
  });

  it("gives each channel a distinct id, the same on every member's device", () => {
    const secret = newRoomSecret();
    const a = roomSfuAdmission(deriveRoomKeys(secret), nonce, "alice", "lounge0001").roomCode;
    const b = roomSfuAdmission(deriveRoomKeys(secret), nonce, "bob", "lounge0001").roomCode;
    const other = roomSfuAdmission(deriveRoomKeys(secret), nonce, "alice", "gaming0002").roomCode;
    const dflt = roomSfuAdmission(deriveRoomKeys(secret), nonce, "alice").roomCode;
    expect(a).toBe(b);
    expect(new Set([a, other, dflt]).size).toBe(3);
    // Another room's channel of the same name is another SFU room.
    expect(roomSfuAdmission(deriveRoomKeys(newRoomSecret()), nonce, "alice", "lounge0001").roomCode).not.toBe(a);
  });

  it("answers the unchanged SFU verifier for its own id, and only its own", () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const lounge = roomSfuAdmission(keys, nonce, "alice", "lounge0001");
    const dflt = roomSfuAdmission(keys, nonce, "alice");
    expect(verifyRoomAdmission(nonce, lounge.roomCode, "alice", lounge.capability)).toBe(true);
    // A channel's capability does not open the default room, nor the reverse.
    expect(verifyRoomAdmission(nonce, dflt.roomCode, "alice", lounge.capability)).toBe(false);
    expect(verifyRoomAdmission(nonce, lounge.roomCode, "alice", dflt.capability)).toBe(false);
  });

  it("leaves the room's own seed intact after deriving a channel's", () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const before = Uint8Array.from(keys.sfuSigningSeed);
    roomSfuAdmission(keys, nonce, "alice", "lounge0001");
    expect(keys.sfuSigningSeed).toEqual(before);
  });

  it.each(["Lounge0001", "short", "a".repeat(33), "lounge-001", " lounge0001", 7, null])(
    "refuses a malformed channel id %s",
    (bad) => {
      const keys = deriveRoomKeys(newRoomSecret());
      expect(() => roomSfuAdmission(keys, nonce, "alice", bad as string)).toThrow();
    },
  );
});
