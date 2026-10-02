// From the review: a room open's hydration and the render-time auto-download
// (MsgRender -> requestFileDownload -> ensureDownload -> the local restore
// handed to setLocalFileLookup) both decrypted the same stored file when they
// overlapped, and both copies stayed referenced.
import { beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "$lib/types/message";

let rows: Attachment[] = [];
vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachment: async () => undefined,
  getAttachmentsByInfoHash: async (hash: string) => rows.filter((r) => r.infoHash === hash),
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async () => rows,
  putAttachment: async () => {},
  updateAttachmentStatus: async () => {},
  updateAttachmentData: async () => {},
}));
const transportState = { fileTransfers: new Map<string, { blobURL?: string }>() };
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState,
  _transport: {},
}));

const decrypts: string[] = [];
let release!: () => void;
let gate = new Promise<void>((r) => (release = r));
const files = {
  restore: null as ((infoHash: string) => Promise<boolean>) | null,
  on() {},
  setLocalFileLookup(_fn: unknown, restore: (infoHash: string) => Promise<boolean>) { this.restore = restore; },
  seedFiles: async () => [],
  getTransfer: () => undefined,
  persistableCiphertext: async () => undefined,
  // A real decrypt takes time (~10 MB/s measured on desktop for the old path).
  restoreEncryptedFile: vi.fn(async (row: Attachment) => {
    decrypts.push(row.id);
    await gate;
    return true;
  }),
  seedStoredFile: vi.fn(async () => true),
};
const { initFiles, _hydrateAndSeedAttachments, _resetAttachmentHydration } = await import("./files.svelte");
initFiles(files as never);

beforeEach(() => {
  _resetAttachmentHydration();
  decrypts.length = 0;
  gate = new Promise<void>((r) => (release = r));
  rows = [{
    id: "pic", roomCode: "rd2_room", messageId: "m-pic", infoHash: "h-pic", filename: "pic.png",
    mimeType: "image/png", size: 8, status: "seeding", createdAt: 1, encryption: {} as never,
  }];
});

it("decrypts a visible stored picture once when the room open and its render-time auto-download overlap", async () => {
  // Room open starts the background hydration...
  const hydration = _hydrateAndSeedAttachments("rd2_room");
  await new Promise((r) => setTimeout(r, 0));
  // ...and the row renders: MsgRender's auto-download asks for the picture,
  // which ensureDownload answers with the local restore.
  const shown = files.restore!("h-pic");
  release();
  await Promise.all([hydration, shown]);
  expect(decrypts).toEqual(["pic"]);
});
