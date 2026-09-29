import { describe, expect, it } from "vitest";
import { deriveRoomKeys, newRoomSecret, parseRoomSecret, validateStoredCapability } from "./keys";
import { createMembershipProof, newMembershipChallenge, verifyMembershipProof } from "./membership";
import { MAX_ROOM_PLAINTEXT, openRoomEnvelope, sealRoomEnvelope } from "./envelope";

describe("v2 room security core", () => {
  it("rejects missing or mismatched capabilities at the storage boundary", () => {
    const roomSecret = newRoomSecret();
    const roomCode = deriveRoomKeys(roomSecret).discoveryId;
    expect(() => validateStoredCapability({ roomCode, roomSecret })).not.toThrow();
    expect(() => validateStoredCapability({ roomCode })).toThrow();
    expect(() => validateStoredCapability({ roomCode, roomSecret: newRoomSecret() })).toThrow();
    expect(() => validateStoredCapability({ roomCode: "legacy", roomSecret })).toThrow();
    expect(() => validateStoredCapability({ roomCode: "legacy" })).not.toThrow();
  });
  it("rejects old codes and preserves canonical high-entropy invitations", () => {
    const secret = newRoomSecret();
    expect(secret).toHaveLength(46);
    expect(parseRoomSecret(secret)).toBe(secret);
    for (const invalid of ["ABCDEF", "7QK3M9AB2C", secret + "=", secret.slice(3), " " + secret]) {
      expect(() => parseRoomSecret(invalid)).toThrow();
    }
    expect(newRoomSecret()).not.toBe(secret);
  });

  it("derives stable, domain-separated values without publishing the root", () => {
    const secret = newRoomSecret();
    const keys = deriveRoomKeys(secret);
    expect(deriveRoomKeys(secret)).toEqual(keys);
    expect(keys.membershipKey).not.toEqual(keys.encryptionKey);
    expect(keys.sfuSigningSeed).not.toEqual(keys.membershipKey);
    expect(keys.discoveryId).not.toContain(secret.slice(3));
    expect(deriveRoomKeys(newRoomSecret()).discoveryId).not.toBe(keys.discoveryId);
  });

  it("binds a membership proof to room, identities, challenges and role", () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const t = {
      room: keys.discoveryId, initiator: "alice", responder: "bob",
      initiatorChallenge: newMembershipChallenge(), responderChallenge: newMembershipChallenge(),
    };
    const proof = createMembershipProof(keys, t, "initiator");
    expect(verifyMembershipProof(keys, t, "initiator", proof)).toBe(true);
    expect(verifyMembershipProof(keys, t, "responder", proof)).toBe(false);
    for (const altered of [
      { ...t, initiator: "mallory" }, { ...t, responder: "mallory" },
      { ...t, initiatorChallenge: newMembershipChallenge() },
      { ...t, responderChallenge: newMembershipChallenge() },
      { ...t, room: deriveRoomKeys(newRoomSecret()).discoveryId },
    ]) expect(verifyMembershipProof(keys, altered, "initiator", proof)).toBe(false);
    expect(verifyMembershipProof(deriveRoomKeys(newRoomSecret()), t, "initiator", proof)).toBe(false);
    expect(verifyMembershipProof(keys, t, "initiator", "not-a-proof")).toBe(false);
  });

  it("encrypts payloads with independent per-envelope keys", async () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const data = new TextEncoder().encode("private room name and history");
    const a = await sealRoomEnvelope(keys, "alice", "history", data);
    const b = await sealRoomEnvelope(keys, "alice", "history", data);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await openRoomEnvelope(keys, a)).toEqual(data);
    await expect(openRoomEnvelope(deriveRoomKeys(newRoomSecret()), a)).rejects.toThrow();
  });

  it("rejects modified headers, ciphertext and downgrades", async () => {
    const keys = deriveRoomKeys(newRoomSecret());
    const e = await sealRoomEnvelope(keys, "alice", "chat", new Uint8Array([1, 2, 3]));
    for (const altered of [
      { ...e, sender: "mallory" }, { ...e, kind: "history" },
      { ...e, version: 1 }, { ...e, salt: newMembershipChallenge() },
      { ...e, ciphertext: (e.ciphertext[0] === "A" ? "B" : "A") + e.ciphertext.slice(1) },
      { ...e, ciphertext: e.ciphertext + "=" },
      { ...e, ciphertext: "A".repeat(2 * MAX_ROOM_PLAINTEXT) },
      null, {}, { ...e, salt: "bad" },
    ]) await expect(openRoomEnvelope(keys, altered)).rejects.toThrow();
  });
});
