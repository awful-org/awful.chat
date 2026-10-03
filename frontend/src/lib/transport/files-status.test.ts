import { beforeEach, expect, it, vi } from "vitest";

const HASH = "d".repeat(40);
const reads: Array<{ skipBytes?: boolean } | undefined> = [];
const writes: Array<{ id: string; status: string }> = [];
let rows: Array<{ id: string; infoHash: string; status: string }> = [];

vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachmentsByInfoHash: async (_hash: string, opts?: { skipBytes?: boolean }) => {
    reads.push(opts);
    return rows;
  },
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async () => [],
  putAttachment: async () => {},
  updateAttachmentStatus: async (id: string, status: string) => {
    writes.push({ id, status });
    rows = rows.map((r) => (r.id === id ? { ...r, status } : r));
  },
  updateAttachmentData: async () => {},
}));
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState: { fileTransfers: new Map() },
  _transport: {},
}));

const { initFiles, _resetAttachmentHydration } = await import("./files.svelte");
const handlers: Record<string, (...args: unknown[]) => void> = {};
initFiles({
  on: (event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; },
  setLocalFileLookup: () => {},
  seedFiles: async () => [],
} as never);

const snapshot = (status: string) => ({
  infoHash: HASH, filename: "cat.png", mimeType: "image/png", size: 5_000_000,
  status, progress: 1, done: true, seeding: status === "seeding", peers: 1, seeders: 1,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetAttachmentHydration();
  reads.length = 0;
  writes.length = 0;
  rows = [{ id: "row", infoHash: HASH, status: "complete" }];
});

it("a file served block after block has its status written once, without its bytes", async () => {
  // ~985 reports serve one 5 MB file to one peer.
  for (let i = 0; i < 985; i++) handlers.transfer(snapshot("seeding"));
  await settle();
  expect(reads).toEqual([{ skipBytes: true }]);
  expect(writes).toEqual([{ id: "row", status: "seeding" }]);

  // A real change is still written - storage keeps it from going backwards.
  handlers.transfer(snapshot("failed"));
  await settle();
  expect(reads).toHaveLength(2);
});

it("tries again while the file's row is not stored yet", async () => {
  rows = [];
  handlers.transfer(snapshot("seeding"));
  await settle();
  rows = [{ id: "late", infoHash: HASH, status: "pending" }];
  handlers.transfer(snapshot("seeding"));
  await settle();
  handlers.transfer(snapshot("seeding"));
  await settle();
  expect(reads).toHaveLength(2);
  expect(writes).toEqual([{ id: "late", status: "seeding" }]);
});
