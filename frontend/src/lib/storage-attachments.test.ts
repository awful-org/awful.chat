import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getAttachmentsByInfoHash,
  getAttachmentsWithData,
  putAttachment,
  updateAttachmentStatus,
  wipeLocalDatabase,
} from "./storage";
import { STORE_SPECS, initStorageCrypto, sealRow } from "./storage-crypto";
import type { Attachment } from "./types/message";

const KEY = new Uint8Array(32).fill(42);
beforeEach(async () => {
  await initStorageCrypto(KEY);
  await wipeLocalDatabase();
});
afterEach(() => vi.restoreAllMocks());

const row = (id: string, roomCode: string, bytes = 4): Attachment => ({
  id, roomCode, messageId: `m-${id}`, infoHash: `h-${id}`, filename: "cat.png",
  mimeType: "image/png", size: bytes, status: "seeding", createdAt: 1,
  data: new Uint8Array(bytes).fill(7).buffer,
});

it("opens a room's files through its index, never walking the store", async () => {
  for (let i = 0; i < 3; i++) await putAttachment(row(`a${i}`, "room-a"));
  for (let i = 0; i < 20; i++) await putAttachment(row(`b${i}`, "room-b", 1024));
  const walk = vi.spyOn(IDBObjectStore.prototype, "openCursor");
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");

  const rows = await getAttachmentsWithData("room-a");
  expect(rows.map((r) => r.id).sort()).toEqual(["a0", "a1", "a2"]);
  expect(rows.every((r) => r.data?.byteLength === 4)).toBe(true);
  expect(walk).not.toHaveBeenCalled();
  // Each of the room's rows, metadata and bytes: no other room's.
  expect(decrypt).toHaveBeenCalledTimes(6);

  // Metadata only: the bytes are never decrypted at all.
  decrypt.mockClear();
  const meta = await getAttachmentsWithData("room-a", { skipBytes: true });
  expect(meta.map((r) => r.id).sort()).toEqual(["a0", "a1", "a2"]);
  expect(meta.every((r) => r.data === undefined)).toBe(true);
  expect(decrypt).toHaveBeenCalledTimes(3);
});

it("a status that changes nothing is settled without opening the row", async () => {
  await putAttachment(row("a", "room-a", 1024 * 1024));
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  const encrypt = vi.spyOn(crypto.subtle, "encrypt");
  // What every block a seed serves used to cost: the whole file, twice.
  await updateAttachmentStatus("a", "seeding");
  await updateAttachmentStatus("a", "complete");
  expect(decrypt).not.toHaveBeenCalled();
  expect(encrypt).not.toHaveBeenCalled();
  expect((await getAttachmentsByInfoHash("h-a"))[0].status).toBe("seeding");
});

it("looks a file up by infoHash without its bytes when asked to", async () => {
  await putAttachment(row("a", "room-a", 1024 * 1024));
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  const [meta] = await getAttachmentsByInfoHash("h-a", { skipBytes: true });
  expect(meta).toMatchObject({ id: "a", roomCode: "room-a", status: "seeding" });
  expect(meta.data).toBeUndefined();
  expect(decrypt).toHaveBeenCalledTimes(1); // the small metadata blob only
});

it("a database from before the index finds its rows through it once upgraded", async () => {
  closeDatabase();
  // The v8 shape of the attachments store, holding a row sealed as v8 wrote it.
  const sealed = await sealRow(row("old", "room-a") as never, STORE_SPECS.attachments);
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("awful-chat", 8);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore("attachments", { keyPath: "id" });
      store.createIndex("byMessage", "messageId", { unique: false });
      store.createIndex("byInfoHash", "infoHash", { unique: false });
      store.createIndex("byStatus", "status", { unique: false });
      store.put(sealed);
    };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  });

  const rows = await getAttachmentsWithData("room-a");
  expect(rows.map((r) => r.id)).toEqual(["old"]);
  expect(new Uint8Array(rows[0].data!)).toEqual(new Uint8Array(4).fill(7));
  expect(await getAttachmentsWithData("room-b")).toEqual([]);
});
