import { describe, expect, it } from "vitest";
import { hasRoomOverrides, resolveRoomProfile, type RoomProfileFields } from "./room-profile";
import type { OwnProfile } from "./storage";

const main: OwnProfile = {
  did: "did:key:alice", isMe: true, nickname: "Alice", color: "#112233",
  bio: "Main bio", tagText: "MAIN", pfpURL: "https://example.test/main.png",
  updatedAt: 1,
};

describe("room profile inheritance", () => {
  it("inherits every main field until a room field is changed", () => {
    expect(resolveRoomProfile(main)).toEqual(main);
    expect(resolveRoomProfile({ ...main, color: "#aabbcc" }, { nickname: "Room Alice" }))
      .toMatchObject({ nickname: "Room Alice", color: "#aabbcc", bio: "Main bio" });
  });

  it("preserves explicit clears while other main fields change", () => {
    const edits: RoomProfileFields = { bio: null, pfpURL: null, tagText: "ROOM" };
    const effective = resolveRoomProfile({ ...main, color: "#aabbcc", bio: "Changed" }, edits);
    expect(effective.bio).toBeUndefined();
    expect(effective.pfpURL).toBeUndefined();
    expect(effective.tagText).toBe("ROOM");
    expect(effective.color).toBe("#aabbcc");
    expect(hasRoomOverrides(edits)).toBe(true);
  });

  it("clears and replaces binary-backed main images in a room", () => {
    const binaryMain: OwnProfile = {
      ...main, pfpURL: undefined, bannerURL: undefined,
      pfpData: new Uint8Array([1]).buffer,
      bannerData: new Uint8Array([2]).buffer,
    };
    const cleared = resolveRoomProfile(binaryMain, { pfpURL: null, bannerURL: null });
    expect(cleared.pfpURL).toBeUndefined();
    expect(cleared.pfpData).toBeUndefined();
    expect(cleared.bannerURL).toBeUndefined();
    expect(cleared.bannerData).toBeUndefined();

    const changed = resolveRoomProfile(binaryMain, {
      pfpURL: "https://example.test/room.png",
      bannerURL: "https://example.test/room-banner.png",
    });
    expect(changed.pfpURL).toBe("https://example.test/room.png");
    expect(changed.pfpData).toBeUndefined();
    expect(changed.bannerURL).toBe("https://example.test/room-banner.png");
    expect(changed.bannerData).toBeUndefined();
  });

  it("reset returns the current main profile", () => {
    expect(resolveRoomProfile({ ...main, nickname: "New main" }, {})).toEqual({ ...main, nickname: "New main" });
    expect(hasRoomOverrides({})).toBe(false);
  });
});
