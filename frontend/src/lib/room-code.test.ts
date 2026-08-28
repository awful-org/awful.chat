import { describe, expect, it } from "vitest";
import { newRoomCode } from "./room-code";

describe("newRoomCode", () => {
  it("carries 64 bits, not the 24 it used to", () => {
    // 8 bytes as hex. The old code was 6 characters / 16.7M possibilities,
    // which is enumerable against a live instance in hours.
    expect(newRoomCode()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newRoomCode()));
    expect(seen.size).toBe(500);
  });

  it("stays plain lowercase hex, which is what every layer assumes", () => {
    // The relay (validRoom), the SFU (isValidId) and the gossipsub topic name
    // all take the code as an opaque string; the SFU rejects bytes < 0x20
    // (control characters) and 0x7f (DEL), but spaces (0x20) are accepted by
    // the relay. Room codes are never generated with spaces, so this is moot
    // in practice.
    for (let i = 0; i < 50; i++) {
      expect(newRoomCode()).toMatch(/^[0-9a-f]+$/);
    }
  });
});
