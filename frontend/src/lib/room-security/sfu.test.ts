import { expect, it } from "vitest";
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
