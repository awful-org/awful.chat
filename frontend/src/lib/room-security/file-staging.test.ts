import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageDecryptedFile, stageEncryptedFile } from "./file-staging";

let entries: Map<string, BlobPart[]>;
let afterWrite: (() => void) | undefined;
let directory: FileSystemDirectoryHandle;
beforeEach(() => {
  entries = new Map();
  afterWrite = undefined;
  directory = {
    async getFileHandle(name: string) {
      entries.set(name, []);
      return {
        async createWritable() {
          return {
            async write(bytes: Uint8Array) {
              entries.get(name)!.push(new Uint8Array(bytes));
              afterWrite?.();
            },
            async close() {}, async abort() { entries.set(name, []); },
          };
        },
        async getFile() { return new File(entries.get(name)!, name); },
      };
    },
    async removeEntry(name: string) { entries.delete(name); },
  } as never;
});
afterEach(() => vi.unstubAllGlobals());

it("stages only opaque ciphertext for seeding and publishes plaintext after authentication", async () => {
  const original = new File(["private contents"], "secret-name.txt", { type: "text/plain" });
  const encrypted = await stageEncryptedFile(original, directory);
  expect(encrypted.file.name).not.toContain("secret-name");
  expect(encrypted.file.type).toBe("application/octet-stream");
  expect(await encrypted.file.text()).not.toContain("private contents");
  const plain = await stageDecryptedFile(encrypted.file, encrypted.encryption, original.name, original.type);
  expect(await plain.file.text()).toBe("private contents");
  expect(plain.file.name).toBe(original.name);
  await encrypted.dispose();
  await encrypted.dispose();
  await plain.dispose();
  expect(entries.size).toBe(0);
});

it("never writes the decrypted copy to disk", async () => {
  const original = new File(["scanned passport"], "passport.txt", { type: "text/plain" });
  const encrypted = await stageEncryptedFile(original, directory);
  const plain = await stageDecryptedFile(encrypted.file, encrypted.encryption, original.name, original.type);
  expect(await plain.file.text()).toBe("scanned passport");
  expect(entries.size).toBe(1); // the caller's ciphertext, nothing else
  const onDisk = await new Blob([...entries.values()].flat()).text();
  expect(onDisk).not.toContain("scanned passport");
  // No storage at all: decryption does not need it.
  vi.stubGlobal("navigator", { storage: {} });
  const again = await stageDecryptedFile(encrypted.file, encrypted.encryption, original.name, original.type);
  expect(await again.file.text()).toBe("scanned passport");
});

it("discards staging on failed authentication, without returning partial plaintext", async () => {
  const encrypted = await stageEncryptedFile(new File(["secret"], "name"), directory);
  const bytes = new Uint8Array(await encrypted.file.arrayBuffer());
  bytes[0] ^= 1;
  await expect(stageDecryptedFile(new Blob([bytes]), encrypted.encryption, "name", "text/plain")).rejects.toThrow();
  expect(entries.size).toBe(1); // only the caller-owned ciphertext remains
  await encrypted.dispose();
});

it("cancellation cleans up a partially written transfer", async () => {
  const controller = new AbortController();
  afterWrite = () => controller.abort();
  await expect(stageEncryptedFile(new File([new Uint8Array(1024 * 1024 + 1)], "large"), directory, controller.signal)).rejects.toThrow();
  expect(entries.size).toBe(0);
});
