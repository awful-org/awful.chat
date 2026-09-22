import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachmentsByInfoHash: async () => [],
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async () => [],
  putAttachment: async () => {},
  updateAttachmentStatus: async () => {},
  updateAttachmentData: async () => {},
}));

const transportState = { fileTransfers: new Map<string, { blobURL?: string }>() };
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState,
  _transport: { send: () => {} },
}));

const { initFiles, withFileTransfer } = await import("./files.svelte");

const handlers: Record<string, (...args: unknown[]) => void> = {};
initFiles({
  on: (event: string, handler: (...args: unknown[]) => void) => {
    handlers[event] = handler;
  },
  setLocalFileLookup: () => {},
  seedFiles: async () => [],
} as never);

let minted = 0;
const revoked = new Set<string>();
globalThis.URL.createObjectURL = () => `blob:ours-${++minted}`;
globalThis.URL.revokeObjectURL = (url: string) => {
  revoked.add(url);
};

const HASH = "c".repeat(40);
const base = {
  infoHash: HASH,
  filename: "x.png",
  mimeType: "image/png",
  size: 5,
  progress: 1,
  done: true,
  peers: 0,
  seeders: 1,
};

const shown = () => transportState.fileTransfers.get(HASH)?.blobURL;

describe("file blob URL ownership", () => {
  beforeEach(() => {
    transportState.fileTransfers = new Map();
    revoked.clear();
  });

  it("keeps a downloaded picture alive when hydration and the torrent both re-offer URLs", () => {
    // The torrent finishes: its snapshot carries the transport's OWN url.
    handlers.transfer({ ...base, status: "complete", seeding: false, blobURL: "blob:wt" });
    handlers.downloaded(HASH, new Blob(["hello"]));
    // A hydration pass offers another url for the same bytes...
    withFileTransfer({ ...base, status: "seeding", seeding: true, blobURL: "blob:ours-hydrate" });
    // ...and the torrent re-sends its own on the next wire/upload event.
    handlers.transfer({ ...base, status: "seeding", seeding: true, blobURL: "blob:wt" });

    // What is on screen must still be a live url.
    const url = shown();
    expect(url).toBeDefined();
    expect(revoked.has(url!)).toBe(false);
    // The duplicate is released rather than leaked; the transport's own url
    // is the transport's to revoke.
    expect(revoked.has("blob:ours-hydrate")).toBe(true);
    expect(revoked.has("blob:wt")).toBe(false);
  });

  it("adopts the first url offered for a file with none", () => {
    withFileTransfer({ ...base, status: "seeding", seeding: true, blobURL: "blob:ours-first" });
    expect(shown()).toBe("blob:ours-first");
  });
});
