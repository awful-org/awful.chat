import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageDecryptedFile, stageEncryptedFile } from "./file-staging";

let entries: Map<string, BlobPart[]>;
let afterWrite: (() => void) | undefined;
beforeEach(() => {
  entries = new Map();
  afterWrite = undefined;
  const directory = {
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
  };
  vi.stubGlobal("navigator", { storage: { async getDirectory() {
    return { async getDirectoryHandle() { return directory; } };
  } } });
});
afterEach(() => vi.unstubAllGlobals());

it("stages only opaque ciphertext for seeding and publishes plaintext after authentication", async () => {
  const original = new File(["private contents"], "secret-name.txt", { type: "text/plain" });
  const encrypted = await stageEncryptedFile(original);
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

it("discards staging on failed authentication, without returning partial plaintext", async () => {
  const encrypted = await stageEncryptedFile(new File(["secret"], "name"));
  const bytes = new Uint8Array(await encrypted.file.arrayBuffer());
  bytes[0] ^= 1;
  await expect(stageDecryptedFile(new Blob([bytes]), encrypted.encryption, "name", "text/plain")).rejects.toThrow();
  expect(entries.size).toBe(1); // only the caller-owned ciphertext remains
  await encrypted.dispose();
});

it("cancellation cleans up a partially written transfer", async () => {
  const controller = new AbortController();
  afterWrite = () => controller.abort();
  await expect(stageEncryptedFile(new File([new Uint8Array(1024 * 1024 + 1)], "large"), controller.signal)).rejects.toThrow();
  expect(entries.size).toBe(0);
});

it("fails explicitly instead of buffering unbounded files without storage support", async () => {
  vi.stubGlobal("navigator", { storage: {} });
  await expect(stageEncryptedFile(new File(["x"], "name"))).rejects.toThrow("browser storage support");
});
