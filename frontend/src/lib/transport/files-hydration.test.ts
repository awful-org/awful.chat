import { beforeEach, expect, it, vi } from "vitest";
import type { Attachment, Message } from "$lib/types/message";

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
  getAttachmentsByInfoHash: async (hash: string, opts?: { skipBytes?: boolean; withBytes?: Set<string> }) => {
    calls.push(`by-hash:${opts?.skipBytes ? "meta" : "bytes"}`);
    const found = rows.filter((r) => r.infoHash === hash);
    for (const r of found) if (withBytes.has(r.id)) opts?.withBytes?.add(r.id);
    return found;
  },
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async (_room: string, opts?: { skipBytes?: boolean; withBytes?: Set<string> }) => {
    calls.push(`room:${opts?.skipBytes ? "meta" : "bytes"}`);
    for (const id of withBytes.keys()) opts?.withBytes?.add(id);
    return rows;
  },
  putAttachment: async () => {},
  updateAttachmentStatus: async () => { calls.push("write-status"); },
  updateAttachmentData: async (id: string) => { calls.push(`write-data:${id}`); },
}));
const transportState = {
  roomCode: "rd2_room" as string | null,
  /** The open conversation's loaded page. */
  messages: [] as Message[],
  fileTransfers: new Map<string, { blobURL?: string }>(),
};
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
  restore: null as ((infoHash: string, asked: boolean) => Promise<boolean>) | null,
  on(event: string, handler: (...args: unknown[]) => void) { this.handlers[event] = handler; },
  setLocalFileLookup(
    fn: (infoHash: string) => Promise<File | null>,
    restore: (infoHash: string, asked: boolean) => Promise<boolean>,
  ) { this.lookup = fn; this.restore = restore; },
  seedFiles: async () => [],
  getTransfer: () => undefined,
  persistableCiphertext: vi.fn(async (): Promise<ArrayBuffer | undefined> => undefined),
  holdsCiphertext: vi.fn(async (row: Attachment) => durable.has(row.infoHash)),
  restoreEncryptedFile: vi.fn(async (row: Attachment, data?: ArrayBuffer) => {
    calls.push(`show:${row.id}:${data ? "row" : "store"}`);
    if (broken.has(row.id)) throw new Error("authentication failed");
    const shown = !!data || durable.has(row.infoHash);
    if (shown) transportState.fileTransfers.set(row.infoHash, { blobURL: `blob:${row.id}` });
    return shown;
  }),
  seedStoredFile: vi.fn(async (row: Attachment, data?: ArrayBuffer) => {
    calls.push(`serve:${row.id}:${data ? "row" : "store"}`);
    return !!data || durable.has(row.infoHash);
  }),
};
const { initFiles, _hydrateAndSeedAttachments, _resetAttachmentHydration, _showLoadedHeldFiles } =
  await import("./files.svelte");
const { mediaPrefs } = await import("$lib/media-prefs.svelte");
initFiles(files as never);

const row = (id: string, createdAt: number): Attachment => ({
  id, roomCode: "rd2_room", messageId: `m-${id}`, infoHash: `h-${id}`, filename: `${id}.png`,
  mimeType: "image/png", size: 8, status: "seeding", createdAt, encryption: {} as never,
});
/** The messages of `of`, oldest first, as the open conversation lists them. */
const page = (...of: Attachment[]): Message[] =>
  [...of].sort((a, b) => a.createdAt - b.createdAt).map((a) => ({
    id: a.messageId, roomCode: a.roomCode, senderId: "did:someone", senderName: "", timestamp: a.createdAt,
    lamport: a.createdAt, type: "file", content: "", meta: { files: [{
      infoHash: a.infoHash, filename: a.filename, mimeType: a.mimeType, size: a.size, encryption: a.encryption,
    }] },
  }) as unknown as Message);
const settle = () => new Promise((r) => setTimeout(r, 0));
const shown = () => calls.filter((c) => c.startsWith("show:"));

beforeEach(() => {
  _resetAttachmentHydration();
  calls.length = 0;
  broken.clear();
  transportState.roomCode = "rd2_room";
  transportState.fileTransfers = new Map();
  rows = [row("old", 1), row("new", 3), row("mid", 2)];
  transportState.messages = page(...rows);
  durable = new Set(["h-new", "h-old"]);
  withBytes.clear();
  withBytes.set("mid", { ...row("mid", 2), data: new ArrayBuffer(8) });
  files.restoreEncryptedFile.mockClear();
  files.seedStoredFile.mockClear();
  files.holdsCiphertext.mockClear();
  files.persistableCiphertext.mockReset();
  files.persistableCiphertext.mockResolvedValue(undefined);
  mediaPrefs.autoDownloadMedia = true;
});

it("shows a room's stored files on its page newest first, reading a row's bytes only when nothing else holds them", async () => {
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
  expect(shown()).toEqual(["show:mid:store", "show:old:store"]);
});

it("stores nothing for a file read back from storage, and still stores a real download", async () => {
  files.handlers.downloaded("h-new", new Blob(["x"]), true);
  await settle();
  expect(files.persistableCiphertext).not.toHaveBeenCalled();
  // Not even a look at its rows: there is nothing to keep or seed.
  expect(calls).toEqual([]);
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

it("leaves a held file over the auto-download ceiling for its Download button, then shows it from here", async () => {
  rows = [{ ...row("video", 4), mimeType: "video/mp4", size: 2 * 1024 ** 3 }, row("new", 3)];
  transportState.messages = page(...rows);
  durable = new Set(["h-video", "h-new"]);
  await _hydrateAndSeedAttachments("rd2_room");
  expect(calls).toEqual(["room:meta", "show:new:store"]);
  expect(transportState.fileTransfers.get("h-video")).toMatchObject({ status: "pending", seeders: 1 });
  // Asked for - its button: shown from this device's copy, and a file this
  // device does not hold is not.
  expect(await files.restore!("h-video", true)).toBe(true);
  expect(calls.at(-1)).toBe("show:video:store");
  expect(await files.restore!("h-unknown", true)).toBe(false);
});

it("shows by itself only the held pictures, videos and sounds whose messages are loaded", async () => {
  const MB = 1024 * 1024;
  const pdf = { ...row("report", 5), filename: "report.pdf", mimeType: "application/pdf" };
  const huge = { ...row("film", 4), mimeType: "video/mp4", size: 100 * MB };
  rows = [pdf, huge, { ...row("new", 3), size: 60 * MB }, { ...row("mid", 2), size: 60 * MB }, row("old", 1)];
  durable = new Set(rows.map((r) => r.infoHash));
  withBytes.clear();
  // The page holds every message but the oldest.
  transportState.messages = page(...rows.slice(0, 4));
  await _hydrateAndSeedAttachments("rd2_room");
  // Both 60 MB pictures: what the page shows, not a share of the room.
  expect(shown()).toEqual(["show:new:store", "show:mid:store"]);
  // The rest are held: this device counts as a seeder, nothing is fetched.
  for (const hash of ["h-report", "h-film", "h-old"]) {
    expect(transportState.fileTransfers.get(hash)).toMatchObject({ status: "pending", seeders: 1 });
  }
  // Scrolled back to: the older page's picture shows by itself as well.
  await _showLoadedHeldFiles("rd2_room", page(...rows));
  expect(shown()).toEqual(["show:new:store", "show:mid:store", "show:old:store"]);
  // A document asked for is shown from here.
  expect(await files.restore!("h-report", true)).toBe(true);
  expect(calls.at(-1)).toBe("show:report:store");
});

it("shows a held file whoever sent it and whatever auto-download says, since nothing is fetched", async () => {
  mediaPrefs.autoDownloadMedia = false;
  transportState.messages = [];
  await _hydrateAndSeedAttachments("rd2_room");
  expect(shown()).toEqual([]);
  // The user's own picture, on a page loaded after the room opened.
  const own = page(row("old", 1)).map((m) => ({ ...m, senderId: "did:me" }));
  await _showLoadedHeldFiles("rd2_room", own);
  expect(shown()).toEqual(["show:old:store"]);
});

it("tries a held file that will not open once, not every time the page changes", async () => {
  broken.add("new");
  await _hydrateAndSeedAttachments("rd2_room");
  for (let i = 0; i < 3; i++) await _showLoadedHeldFiles("rd2_room", page(...rows));
  expect(shown().filter((c) => c === "show:new:store")).toHaveLength(1);
});

it("does not show the files of a conversation that was left", async () => {
  transportState.messages = [];
  await _hydrateAndSeedAttachments("rd2_room");
  transportState.roomCode = "rd2_other";
  await _showLoadedHeldFiles("rd2_room", page(...rows));
  expect(shown()).toEqual([]);
});

it("an ask nobody made leaves a held file held: nothing decrypted, nothing fetched", async () => {
  // A seeder announcing it, a message arriving: true, it is here.
  expect(await files.restore!("h-new", false)).toBe(true);
  // Held in its row alone: found without reading the bytes.
  expect(await files.restore!("h-mid", false)).toBe(true);
  expect(files.restoreEncryptedFile).not.toHaveBeenCalled();
  expect(calls.filter((c) => c.startsWith("row-bytes:"))).toEqual([]);
  expect(transportState.fileTransfers.get("h-new")).toMatchObject({ status: "pending", seeders: 1 });
  // Not here: it is fetched.
  durable.delete("h-old");
  expect(await files.restore!("h-old", false)).toBe(false);
  expect(await files.restore!("h-unknown", false)).toBe(false);
});

it("a file asked for while the room opens is decrypted once", async () => {
  rows = [row("new", 2), row("old", 1)];
  transportState.messages = page(...rows);
  durable = new Set(["h-new", "h-old"]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  files.restoreEncryptedFile.mockImplementationOnce(async (r: Attachment) => {
    calls.push(`show:${r.id}:store`);
    await gate;
    transportState.fileTransfers.set(r.infoHash, { blobURL: `blob:${r.id}` });
    return true;
  });
  // Auto-download asks for the newest picture as it renders...
  const asked = files.restore!("h-new", true);
  await settle();
  // ...while the room open reads its files back.
  const hydration = _hydrateAndSeedAttachments("rd2_room");
  await settle();
  release();
  await Promise.all([asked, hydration]);
  expect(shown()).toEqual(["show:new:store", "show:old:store"]);
});

it("does not decrypt a file already on screen when it is asked for", async () => {
  transportState.fileTransfers.set("h-new", { blobURL: "blob:sent-this-session" });
  expect(await files.restore!("h-new", true)).toBe(true);
  expect(calls).toEqual([]);
});

it("keeps a protected file served from its ciphertext, but never shown here, a file to ask for", async () => {
  const served = {
    infoHash: "h-new", filename: "new.png", mimeType: "image/png", size: 8, encryption: {} as never,
    status: "seeding", progress: 1, done: true, seeding: true, peers: 1, seeders: 1,
  };
  files.handlers.transfer(served);
  expect(transportState.fileTransfers.get("h-new")).toMatchObject({ status: "pending", seeders: 1 });
  // Shown, it is seeding like any other.
  files.handlers.transfer({ ...served, blobURL: "blob:transport-owned" });
  expect(transportState.fileTransfers.get("h-new")).toMatchObject({ status: "seeding" });
  transportState.fileTransfers = new Map([["h-new", { blobURL: "blob:sent-this-session" }]]);
  files.handlers.transfer(served);
  expect(transportState.fileTransfers.get("h-new")).toMatchObject({ status: "seeding" });
});

it("gives a row that never got its copy of the file one, once, and leaves the rest of the rows alone", async () => {
  files.persistableCiphertext.mockResolvedValue(new ArrayBuffer(8));
  await _hydrateAndSeedAttachments("rd2_room");
  await settle();
  // "mid" carries its bytes; "new" and "old" were kept only in this
  // device's file store.
  expect(calls.filter((c) => c.startsWith("write-")).sort()).toEqual(["write-data:new", "write-data:old"]);
  expect(files.persistableCiphertext.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(["h-new", "h-old"]);
});

it("gives those rows their copy whether or not anything shows the file, without decrypting it", async () => {
  files.persistableCiphertext.mockResolvedValue(new ArrayBuffer(8));
  rows = [{ ...row("doc", 2), mimeType: "application/pdf" }, row("old", 1)];
  durable = new Set(["h-doc", "h-old"]);
  withBytes.clear();
  // Nothing of the room is on the page.
  transportState.messages = [];
  await _hydrateAndSeedAttachments("rd2_room");
  await settle();
  expect(calls.filter((c) => c.startsWith("write-")).sort()).toEqual(["write-data:doc", "write-data:old"]);
  expect(files.restoreEncryptedFile).not.toHaveBeenCalled();
});
