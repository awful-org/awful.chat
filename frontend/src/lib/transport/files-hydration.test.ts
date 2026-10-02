import { beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "$lib/types/message";

const calls: string[] = [];
let rows: Attachment[] = [];
const withBytes = new Map<string, Attachment>();
/** infoHashes this device's durable ciphertext store holds. */
let durable = new Set<string>();

vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachment: async (id: string) => {
    calls.push(`row-bytes:${id}`);
    return withBytes.get(id);
  },
  getAttachmentsByInfoHash: async (hash: string, opts?: { skipBytes?: boolean }) => {
    calls.push(`by-hash:${opts?.skipBytes ? "meta" : "bytes"}`);
    return rows.filter((r) => r.infoHash === hash);
  },
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async (_room: string, opts?: { skipBytes?: boolean }) => {
    calls.push(`room:${opts?.skipBytes ? "meta" : "bytes"}`);
    return rows;
  },
  putAttachment: async () => {},
  updateAttachmentStatus: async () => { calls.push("write-status"); },
  updateAttachmentData: async () => { calls.push("write-data"); },
}));
const transportState = { fileTransfers: new Map<string, { blobURL?: string }>() };
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState,
  _transport: {},
}));

const broken = new Set<string>();
const files = {
  handlers: {} as Record<string, (...args: unknown[]) => void>,
  lookup: null as ((infoHash: string) => Promise<File | null>) | null,
  on(event: string, handler: (...args: unknown[]) => void) { this.handlers[event] = handler; },
  setLocalFileLookup(fn: (infoHash: string) => Promise<File | null>) { this.lookup = fn; },
  seedFiles: async () => [],
  getTransfer: () => undefined,
  persistableCiphertext: vi.fn(async () => undefined),
  restoreEncryptedFile: vi.fn(async (row: Attachment, data?: ArrayBuffer) => {
    calls.push(`show:${row.id}:${data ? "row" : "store"}`);
    if (broken.has(row.id)) throw new Error("authentication failed");
    return !!data || durable.has(row.infoHash);
  }),
  seedStoredFile: vi.fn(async (row: Attachment, data?: ArrayBuffer) => {
    calls.push(`serve:${row.id}:${data ? "row" : "store"}`);
    return !!data || durable.has(row.infoHash);
  }),
};
const { initFiles, _hydrateAndSeedAttachments, _resetAttachmentHydration } = await import("./files.svelte");
initFiles(files as never);

const row = (id: string, createdAt: number): Attachment => ({
  id, roomCode: "rd2_room", messageId: `m-${id}`, infoHash: `h-${id}`, filename: `${id}.png`,
  mimeType: "image/png", size: 8, status: "seeding", createdAt, encryption: {} as never,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetAttachmentHydration();
  calls.length = 0;
  broken.clear();
  transportState.fileTransfers = new Map();
  rows = [row("old", 1), row("new", 3), row("mid", 2)];
  durable = new Set(["h-new", "h-old"]);
  withBytes.clear();
  withBytes.set("mid", { ...row("mid", 2), data: new ArrayBuffer(8) });
  files.restoreEncryptedFile.mockClear();
  files.seedStoredFile.mockClear();
  files.persistableCiphertext.mockClear();
});

it("shows a room's stored files newest first, reading a row's bytes only when nothing else holds them", async () => {
  await _hydrateAndSeedAttachments("rd2_room");
  expect(calls).toEqual([
    "room:meta",
    "show:new:store",
    "show:mid:store", "row-bytes:mid", "show:mid:row",
    "show:old:store",
  ]);
  // Shown, not seeded: a peer that wants one asks for it.
  expect(files.seedStoredFile).not.toHaveBeenCalled();
});

it("does not decrypt again a file already on screen, and one bad file does not stop the rest", async () => {
  transportState.fileTransfers.set("h-new", { blobURL: "blob:sent-this-session" });
  broken.add("mid");
  withBytes.delete("mid");
  await _hydrateAndSeedAttachments("rd2_room");
  expect(calls.filter((c) => c.startsWith("show:"))).toEqual(["show:mid:store", "show:old:store"]);
});

it("stores nothing for a file read back from storage, and still stores a real download", async () => {
  files.handlers.downloaded("h-new", new Blob(["x"]), true);
  await settle();
  expect(files.persistableCiphertext).not.toHaveBeenCalled();
  expect(calls.filter((c) => c.startsWith("write-"))).toEqual([]);
  files.handlers.downloaded("h-new", new Blob(["x"]));
  await settle();
  expect(files.persistableCiphertext).toHaveBeenCalledOnce();
});

it("serves a peer's request from the ciphertext, never decrypting it", async () => {
  expect(await files.lookup!("h-new")).toBeNull();
  expect(await files.lookup!("h-mid")).toBeNull();
  expect(calls).toEqual([
    "by-hash:meta", "serve:new:store",
    "by-hash:meta", "serve:mid:store", "row-bytes:mid", "serve:mid:row",
  ]);
  expect(files.restoreEncryptedFile).not.toHaveBeenCalled();
});
