import { beforeEach, expect, it, vi } from "vitest";

vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:test:me" } }));
vi.mock("$lib/transport/transport.svelte", () => ({ broadcastProfile: vi.fn() }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: vi.fn(), putOwnProfile: vi.fn(), updateOwnProfile: vi.fn(),
  rekeyOwnProfile: vi.fn(), pfpBlobURL: vi.fn(),
}));

import { getOwnProfile, updateOwnProfile } from "$lib/storage";
import { loadProfile, profileStore, saveBanner, saveName } from "./profile.svelte";
import { broadcastProfile } from "$lib/transport/transport.svelte";
import { validateProfileMeta } from "./profile-meta";

beforeEach(() => vi.clearAllMocks());

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
  expect(broadcastProfile).not.toHaveBeenCalled();
  finishWrite();
  await saving;
  expect(broadcastProfile).toHaveBeenCalledOnce();
});

it("does not announce a failed name write and allows a subsequent save", async () => {
  vi.mocked(getOwnProfile).mockResolvedValue({
    did: "did:test:me", isMe: true, nickname: "Old name", updatedAt: 1,
  });
  vi.mocked(updateOwnProfile).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(saveName("New name")).rejects.toThrow("Storage unavailable");
  expect(broadcastProfile).not.toHaveBeenCalled();
  await saveName("New name");
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
