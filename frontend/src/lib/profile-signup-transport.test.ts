import { expect, it, vi } from "vitest";

/**
 * Signup saves the name and the avatar through profile.svelte.ts before the
 * identity is unlocked (IdentitySetup's profile step, with the did passed in).
 * There is nobody to tell yet: no session, no relay connection. Importing the
 * transport to tell them anyway cost the setup screen the download it exists
 * not to wait for - libp2p included - and a chunk that did not arrive
 * reloaded the page mid-signup (main.ts), dropping the invitation the gate
 * holds in memory.
 */

const loaded: string[] = [];
vi.mock("$lib/identity/identity.svelte", () => ({
  identityStore: { did: null, isUnlocked: false },
}));
vi.mock("$lib/transport/transport.svelte", () => {
  loaded.push("transport.svelte");
  return { broadcastProfile: vi.fn() };
});
vi.mock("$lib/storage", () => ({
  getOwnProfile: vi.fn(), putOwnProfile: vi.fn(), updateOwnProfile: vi.fn(),
  rekeyOwnProfile: vi.fn(), pfpBlobURL: vi.fn(),
  getAllOwnRoomProfiles: vi.fn().mockResolvedValue([]),
  getOwnRoomProfile: vi.fn(), putOwnRoomProfile: vi.fn(),
}));
vi.mock("$lib/rooms.svelte", () => ({ roomsStore: { rooms: [] } }));

import { saveAvatar, saveName } from "./profile.svelte";

it("does not load the transport to save a name while the identity is still locked (signup)", async () => {
  await saveName("Alice", "did:key:z6Mkexample");
  await vi.dynamicImportSettled();
  expect(loaded).toEqual([]);
});

it("nor to save the avatar picked on the same step", async () => {
  await saveAvatar("https://example.test/alice.gif");
  await vi.dynamicImportSettled();
  expect(loaded).toEqual([]);
});
