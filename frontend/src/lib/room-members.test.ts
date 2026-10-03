import { describe, expect, it } from "vitest";
import { roomMemberCount } from "./room-members";

const toDid = (id: string) => ({ "12D3-bob": "did:bob", "12D3-me": "did:me" })[id] ?? id;

describe("roomMemberCount", () => {
  it("counts the room's roster, not who else is connected", () => {
    expect(roomMemberCount(["did:me", "did:bob", "did:ana"], ["did:me", "12D3-me"], toDid)).toBe(3);
    expect(roomMemberCount(["did:me", "did:cy"], ["did:me", "12D3-me"], toDid)).toBe(2);
  });

  it("counts a person listed by DID and by peerId once", () => {
    expect(roomMemberCount(["did:bob", "12D3-bob"], ["did:me"], toDid)).toBe(2);
  });

  it("counts us once, listed or not, under either id", () => {
    expect(roomMemberCount([], ["did:me", "12D3-me"], toDid)).toBe(1);
    expect(roomMemberCount(["12D3-me", "did:me"], ["did:me", "12D3-me"], toDid)).toBe(1);
  });

  it("ignores empty entries and empty self ids", () => {
    expect(roomMemberCount(["", "did:bob"], ["", "did:me"], toDid)).toBe(2);
  });
});
