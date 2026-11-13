import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "./opfs-test-helper";
import { stageDecryptedFile, stageEncryptedFile } from "../../room-security/file-staging";
import { adoptCiphertext, consumeCiphertext, readCiphertext, removeCiphertext } from "./ciphertext-store";
import { fileStorageRoot } from "./file-storage";

const HASH = "a".repeat(40);
beforeEach(() => vi.stubGlobal("navigator", {}));
afterEach(async () => { await removeCiphertext(HASH); vi.unstubAllGlobals(); });

it("adopts staging larger than half the fallback quota without copying and survives lease cleanup", async () => {
  const root = await fileStorageRoot();
  const staging = await root.getDirectoryHandle("stage", { create: true });
  const staged = await stageEncryptedFile(new File([new Uint8Array(33 * 1024 * 1024)], "private"), staging);
  const moved = await adoptCiphertext(HASH, staged, new AbortController().signal);
  await staged.dispose();
  await root.removeEntry("stage", { recursive: true });
  expect(moved.size).toBe(staged.file.size);
  const held = await readCiphertext(HASH);
  expect(held?.size).toBe(staged.file.size);
  expect(await held!.slice(0, 32).arrayBuffer()).toEqual(await staged.file.slice(0, 32).arrayBuffer());
});

it("copies bounded ciphertext when native OPFS has no move API", async () => {
  const disk = fakeOPFS(); vi.stubGlobal("navigator", disk);
  const staging = await (await fileStorageRoot()).getDirectoryHandle("stage", { create: true });
  const staged = await stageEncryptedFile(new File(["secret"], "private"), staging);
  await adoptCiphertext(HASH, staged, new AbortController().signal);
  await staged.dispose();
  expect(await (await readCiphertext(HASH))!.arrayBuffer()).toEqual(await staged.file.arrayBuffer());
  expect([...disk.entries.keys()]).toEqual([`room-v2-ciphertext/${HASH}`]);
});

it("removes an adopted file if cancellation races ownership transfer", async () => {
  const abort = new AbortController();
  const staged = {
    file: new File(["ciphertext"], "opaque"), dispose: async () => {},
    moveTo: async (dir: FileSystemDirectoryHandle, name: string) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const writer = await handle.createWritable(); await writer.write("ciphertext"); await writer.close();
      abort.abort(); return handle.getFile();
    },
  };
  await expect(adoptCiphertext(HASH, staged, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(await readCiphertext(HASH)).toBeNull();
});

it("caches and authenticates a fragmented stream in one traversal with no durable reread", async () => {
  const disk = fakeOPFS(); vi.stubGlobal("navigator", disk);
  const staging = await (await fileStorageRoot()).getDirectoryHandle("stage", { create: true });
  const staged = await stageEncryptedFile(new File([new Uint8Array(1024 * 1024 + 19).fill(42)], "private"), staging);
  const bytes = new Uint8Array(await staged.file.arrayBuffer());
  let traversals = 0;
  async function* source() {
    traversals++;
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) yield bytes.subarray(offset, offset + 256 * 1024);
  }
  const plain = await consumeCiphertext(HASH, source(), new AbortController().signal, stream =>
    stageDecryptedFile(stream, staged.encryption, "private", "text/plain"));
  expect(traversals).toBe(1);
  expect(disk.reads).not.toContain(`room-v2-ciphertext/${HASH}`);
  expect(plain.size).toBe(1024 * 1024 + 19);
  expect(await disk.entries.get(`room-v2-ciphertext/${HASH}`)!.arrayBuffer()).toEqual(bytes.buffer);
  expect([...disk.entries.values()].every(blob => blob.size !== plain.size)).toBe(true);
  await staged.dispose();
});

it.each(["authentication", "cancellation", "early consumer"])("removes partial cache on %s failure", async mode => {
  const abort = new AbortController();
  const closed = vi.fn();
  async function* source() { try { yield new Uint8Array([1, 2, 3]); } finally { closed(); } }
  await expect(consumeCiphertext(HASH, source(), abort.signal, async stream => {
    for await (const _chunk of stream) {
      if (mode === "authentication") throw new Error("authentication failed");
      if (mode === "cancellation") abort.abort();
      else break;
    }
  })).rejects.toThrow();
  expect(await readCiphertext(HASH)).toBeNull();
  expect(closed).toHaveBeenCalledOnce();
});
