import { beforeEach, describe, expect, it, vi } from "vitest";
const release = vi.hoisted(() => ({ enabled: true }));
vi.mock("./invitation-release", () => ({
  get ROOM_SECURITY_V2_RELEASED() { return release.enabled; },
}));
import type { Room } from "$lib/storage";
import { deriveRoomKeys, newRoomSecret } from "./keys";
import { joinStoredRoom } from "./room-lifecycle";

const secret = newRoomSecret();
const code = deriveRoomKeys(secret).discoveryId;
const record: Room = { roomCode: code, roomSecret: secret, name: "Private", type: "text",
  createdAt: 0, lastSeenLamport: 0, participants: [] };
const fake = () => ({ joinRoom: vi.fn(), joinSecureRoom: vi.fn(() => code) });

describe("stored-room transport lifecycle", () => {
  beforeEach(() => { release.enabled = true; });
  it("reopens using the secret without registering it through the legacy API", () => {
    const transport = fake();
    joinStoredRoom(transport, code, record);
    expect(transport.joinSecureRoom).toHaveBeenCalledWith(secret);
    expect(transport.joinRoom).not.toHaveBeenCalled();
  });

  it("rejects missing and mismatched capabilities without network effects", () => {
    for (const saved of [undefined, { ...record, roomSecret: undefined },
      { ...record, roomSecret: newRoomSecret() }, { ...record, roomCode: "other" }]) {
      const transport = fake();
      expect(() => joinStoredRoom(transport, code, saved)).toThrow();
      expect(transport.joinRoom).not.toHaveBeenCalled();
      expect(transport.joinSecureRoom).not.toHaveBeenCalled();
    }
  });

  it("never registers an invitation secret or a mislabeled capability record", () => {
    const transport = fake();
    expect(() => joinStoredRoom(transport, secret)).toThrow();
    expect(() => joinStoredRoom(transport, "legacy", { ...record, roomCode: "legacy" })).toThrow();
    expect(transport.joinRoom).not.toHaveBeenCalled();
  });

  it("keeps pre-cutover legacy operation explicit", () => {
    release.enabled = false; // Legacy-only compatibility, never the released policy.
    const transport = fake();
    joinStoredRoom(transport, "legacy");
    expect(transport.joinRoom).toHaveBeenCalledWith("legacy");
    expect(transport.joinSecureRoom).not.toHaveBeenCalled();
  });

  it("rejects legacy reopen after release without any network registration", () => {
    const transport = fake();
    expect(() => joinStoredRoom(transport, "legacy")).toThrow("read-only");
    expect(transport.joinRoom).not.toHaveBeenCalled();
    expect(transport.joinSecureRoom).not.toHaveBeenCalled();
  });
});
