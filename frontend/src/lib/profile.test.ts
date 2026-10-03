import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:test:me", isUnlocked: true } }));
vi.mock("$lib/transport/transport.svelte", () => ({ broadcastProfile: vi.fn() }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: vi.fn(), putOwnProfile: vi.fn(), updateOwnProfile: vi.fn(),
  rekeyOwnProfile: vi.fn(), pfpBlobURL: vi.fn(),
  getAllOwnRoomProfiles: vi.fn().mockResolvedValue([]),
  getOwnRoomProfile: vi.fn(), putOwnRoomProfile: vi.fn(),
}));
vi.mock("$lib/rooms.svelte", () => ({ roomsStore: { rooms: [
  { roomCode: "room-a", type: "text", createdAt: 1 },
  { roomCode: "room-b", type: "text", createdAt: 2 },
] } }));

import { getOwnProfile, getOwnRoomProfile, putOwnRoomProfile, updateOwnProfile } from "$lib/storage";
import { getScopedProfile, hasScopedOverrides, loadProfile, profileStore, resetScopedProfile, roomProfileStore, saveBanner, saveName, saveScopedFields } from "./profile.svelte";
import { broadcastProfile } from "$lib/transport/transport.svelte";
import { validateProfileMeta } from "./profile-meta";

beforeEach(() => vi.clearAllMocks());
// The broadcast imports the transport when it runs (profile.svelte.ts): let
// one still on its way land in the test that caused it, not the next.
afterEach(() => vi.dynamicImportSettled());

it("keeps edits in their selected room and inherits later main edits", async () => {
  roomProfileStore.records = new Map();
  profileStore.nickname = "Main";
  profileStore.bio = "First";
  vi.mocked(getOwnRoomProfile).mockResolvedValue(undefined);
  await saveScopedFields("room-a", { nickname: "Room A", bio: null });
  expect(getScopedProfile("room-a")).toMatchObject({ nickname: "Room A", bio: undefined });
  expect(getScopedProfile("room-b")).toMatchObject({ nickname: "Main", bio: "First" });
  expect(profileStore.nickname).toBe("Main");
  profileStore.bio = "Second";
  expect(getScopedProfile("room-a").bio).toBeUndefined();
  expect(getScopedProfile("room-b").bio).toBe("Second");
});

it("serializes room writes, exposes only persisted values, and resets to main", async () => {
  roomProfileStore.records = new Map();
  vi.mocked(getOwnRoomProfile).mockResolvedValue(undefined);
  let finish!: () => void;
  vi.mocked(putOwnRoomProfile).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = saveScopedFields("room-a", { nickname: "One" });
  await vi.waitFor(() => expect(putOwnRoomProfile).toHaveBeenCalledTimes(1));
  expect(getScopedProfile("room-a").nickname).toBe("Main");
  finish();
  await first;
  vi.mocked(getOwnRoomProfile).mockResolvedValueOnce(roomProfileStore.records.get("room-a"));
  await saveScopedFields("room-a", { bio: "Room bio" });
  expect(vi.mocked(putOwnRoomProfile).mock.calls[1][0].fields).toEqual({ nickname: "One", bio: "Room bio" });
  vi.mocked(getOwnRoomProfile).mockResolvedValueOnce(roomProfileStore.records.get("room-a"));
  await resetScopedProfile("room-a");
  expect(hasScopedOverrides("room-a")).toBe(false);
  expect(getScopedProfile("room-a").nickname).toBe("Main");
});

it("does not display or announce a failed room write", async () => {
  roomProfileStore.records = new Map();
  vi.mocked(getOwnRoomProfile).mockResolvedValue(undefined);
  vi.mocked(putOwnRoomProfile).mockRejectedValueOnce(new Error("disk failed"));
  await expect(saveScopedFields("room-a", { nickname: "Lost" })).rejects.toThrow("disk failed");
  expect(getScopedProfile("room-a").nickname).toBe("Main");
  await vi.dynamicImportSettled();
  expect(broadcastProfile).not.toHaveBeenCalled();
});

it("clearing a room image removes its older binary override and records its reset", async () => {
  const old = {
    roomCode: "room-a", did: "did:test:me", generation: 1,
    fields: { pfpData: new Uint8Array([0x47, 0x49, 0x46]).buffer, bannerData: new Uint8Array([0x47, 0x49, 0x46]).buffer },
  };
  roomProfileStore.records = new Map([["room-a", old]]);
  vi.mocked(getOwnRoomProfile).mockResolvedValue(old);
  profileStore.avatarUrl = "https://example.test/main.png";
  await saveScopedFields("room-a", { pfpURL: null, bannerURL: null });
  const saved = vi.mocked(putOwnRoomProfile).mock.lastCall![0];
  expect(saved.fields).toEqual({ pfpURL: null, bannerURL: null });
  expect(saved.fieldEdits?.pfpData?.reset).toBe(true);
  expect(saved.fieldEdits?.bannerData?.reset).toBe(true);
  expect(getScopedProfile("room-a").avatarUrl).toBeUndefined();
  expect(getScopedProfile("room-a").bannerUrl).toBeUndefined();
});

it("broadcasts a changed name only after the profile write completes", async () => {
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Old name", updatedAt: 1,
  });
  let finishWrite!: () => void;
  vi.mocked(updateOwnProfile).mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishWrite = resolve;
  }));
  const saving = saveName("New name");
  expect(profileStore.nickname).toBe("New name");
  await vi.waitFor(() => expect(updateOwnProfile).toHaveBeenCalledWith({ nickname: "New name" }));
  await vi.dynamicImportSettled();
  expect(broadcastProfile).not.toHaveBeenCalled();
  finishWrite();
  await saving;
  await vi.dynamicImportSettled();
  expect(broadcastProfile).toHaveBeenCalledOnce();
});

it("does not announce a failed name write and allows a subsequent save", async () => {
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Old name", updatedAt: 1,
  });
  vi.mocked(updateOwnProfile).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(saveName("New name")).rejects.toThrow("Storage unavailable");
  await vi.dynamicImportSettled();
  expect(broadcastProfile).not.toHaveBeenCalled();
  await saveName("New name");
  await vi.dynamicImportSettled();
  expect(broadcastProfile).toHaveBeenCalledOnce();
});

it("loads a restored binary banner into a displayable and transferable URL", async () => {
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Me", updatedAt: 1,
    bannerData: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer,
  });
  await loadProfile();
  expect(profileStore.bannerUrl).toBe("data:image/gif;base64,R0lGODlh");
  expect(validateProfileMeta({ bannerUrl: profileStore.bannerUrl }).bannerUrl).toBe(profileStore.bannerUrl);
  await saveBanner(profileStore.bannerUrl);
  expect(updateOwnProfile).toHaveBeenCalledWith({
    bannerURL: "data:image/gif;base64,R0lGODlh", bannerData: undefined,
  });
});

it("prefers a saved banner URL and clears the preview when the banner is removed", async () => {
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Me", updatedAt: 1,
    bannerURL: "https://example.com/banner.gif", bannerData: new ArrayBuffer(4),
  });
  await loadProfile();
  expect(profileStore.bannerUrl).toBe("https://example.com/banner.gif");
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Me", updatedAt: 2,
  });
  await loadProfile();
  expect(profileStore.bannerUrl).toBeUndefined();
});
