import { expect, it } from "vitest";
import { resolveRoomProfile } from "$lib/room-profile";
import { roomEditFields, shouldSaveEditedValue } from "./profile-editor";
import type { OwnProfile } from "$lib/storage";

const main: OwnProfile = { did: "did:key:me", isMe: true, nickname: "Main", updatedAt: 1 };

it("keeps removed room fields cleared after main later gains values", () => {
  const fields = roomEditFields({ bio: undefined, tagText: undefined, color: undefined, bannerURL: undefined });
  expect(fields).toEqual({ bio: null, tagText: null, color: null, bannerURL: null });
  const later = { ...main, bio: "New bio", tagText: "TAG", color: "#112233", bannerURL: "https://example.test/banner.png" };
  const effective = resolveRoomProfile(later, fields);
  expect([effective.bio, effective.tagText, effective.color, effective.bannerURL]).toEqual([undefined, undefined, undefined, undefined]);
});

it("saves a typed room value even when main changes to match during editing", () => {
  expect(shouldSaveEditedValue("room-a", "New", "Old", "New")).toBe(true);
  expect(shouldSaveEditedValue("room-a", "Old", "Old", "New")).toBe(false);
  expect(shouldSaveEditedValue(null, "New", "Old", "New")).toBe(false);
});
