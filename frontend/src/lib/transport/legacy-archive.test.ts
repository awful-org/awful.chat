import { beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "$lib/types/message";

vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));
const state = vi.hoisted(() => ({ fileTransfers: new Map(), rows: [] as Attachment[], read: null as Promise<Attachment[]> | null }));
vi.mock("$lib/storage", () => ({
  getAttachmentsWithData: () => state.read ?? Promise.resolve(state.rows),
}));
vi.mock("./transport.svelte", () => ({ transportState: state }));
vi.mock("./file/webtorrent", () => ({
  WebTorrentTransport: class { constructor() { throw new Error("Archive accessed network transport"); } },
}));

const { hydrateLegacyAttachments, _hydrateAndSeedAttachments, _resumeAttachmentSeeding, _resetAttachmentHydration } = await import("./files.svelte");
const { isLegacyArchive, requireWritableRoom } = await import("$lib/room-security/legacy-archive");
const row = { roomCode: "old-room", infoHash: "hash", filename: "original.txt", mimeType: "text/plain", size: 3, data: new Uint8Array([1, 2, 3]).buffer, status: "seeding", createdAt: 1 } as Attachment;

beforeEach(() => {
  _resetAttachmentHydration();
  state.fileTransfers = new Map();
  state.rows = [row];
  state.read = null;
});

it("restores exact local bytes without constructing a network transport or retaining seeding state", async () => {
  await hydrateLegacyAttachments("old-room");
  const file = state.fileTransfers.get("hash");
  expect(file).toMatchObject({ done: true, seeding: false, seeders: 0, peers: 0 });
  expect(new Uint8Array(await (await fetch(file.blobURL)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  URL.revokeObjectURL(file.blobURL);
});

it("legacy combined hydration and explicit reseeding cannot start torrents", async () => {
  await _hydrateAndSeedAttachments("old-room");
  await _resumeAttachmentSeeding("old-room", [row]);
  expect(state.fileTransfers.get("hash").seeding).toBe(false);
});

it("does not expose foreign-room, missing, or capability-bearing bytes", async () => {
  state.rows = [{ ...row, roomCode: "another" }, { ...row, data: undefined }, { ...row, encryption: {} } as Attachment];
  await hydrateLegacyAttachments("old-room");
  expect(state.fileTransfers.size).toBe(0);
});

it("discards hydration after identity reset or a superseding conversation open", async () => {
  let finish!: (rows: Attachment[]) => void;
  state.read = new Promise(resolve => { finish = resolve; });
  const opening = hydrateLegacyAttachments("old-room");
  _resetAttachmentHydration();
  finish([row]);
  await opening;
  expect(state.fileTransfers.size).toBe(0);
  state.read = null;
  await hydrateLegacyAttachments("old-room", () => false);
  expect(state.fileTransfers.size).toBe(0);
});

it("denies legacy writes without mistaking secure IDs, invitations or DMs for archives", () => {
  expect(isLegacyArchive("old-room")).toBe(true);
  expect(() => requireWritableRoom("old-room")).toThrow("read-only");
  for (const id of [null, "rd2_id", "r2_invitation", "dm-peer"]) expect(isLegacyArchive(id)).toBe(false);
});

it("keeps legacy network admission rejected after release", async () => {
  const { joinStoredRoom } = await import("$lib/room-security/room-lifecycle");
  const network = { joinRoom: vi.fn(), joinSecureRoom: vi.fn() };
  expect(() => joinStoredRoom(network, "old-room")).toThrow("read-only");
  expect(network.joinRoom).not.toHaveBeenCalled();
  expect(network.joinSecureRoom).not.toHaveBeenCalled();
});
