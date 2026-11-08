import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new DOMException("Private window", "SecurityError"); } } });
});
afterEach(() => vi.unstubAllGlobals());
const root = async () => (await import("./file-storage")).fileStorageRoot();

it("uses temporary ciphertext storage when private browsing refuses OPFS", async () => {
  const directory = await (await root()).getDirectoryHandle("ciphertext", { create: true });
  const handle = await directory.getFileHandle("opaque-hash", { create: true });
  const writer = await handle.createWritable();
  await writer.write(new Blob(["encrypted bytes"]));
  await writer.close();
  expect(await (await handle.getFile()).text()).toBe("encrypted bytes");
  const same = await (await root()).getDirectoryHandle("ciphertext");
  expect(await (await (await same.getFileHandle("opaque-hash")).getFile()).text()).toBe("encrypted bytes");
});

it("does not publish partial writes and preserves the original file on abort", async () => {
  const handle = await (await root()).getFileHandle("opaque", { create: true });
  const first = await handle.createWritable(); await first.write("original"); await first.close();
  const replacement = await handle.createWritable(); await replacement.write("partial");
  expect(await (await handle.getFile()).text()).toBe("original");
  await replacement.abort();
  expect(await (await handle.getFile()).text()).toBe("original");
});

it("bounds combined committed and in-flight bytes and releases quota on abort/removal", async () => {
  const directory = await root();
  const large = new Blob(Array(64).fill(new Blob([new Uint8Array(1024 * 1024)])));
  const handle = await directory.getFileHandle("large", { create: true });
  const writer = await handle.createWritable(); await writer.write(large);
  const small = await (await directory.getFileHandle("small", { create: true })).createWritable();
  await expect(small.write("x")).rejects.toMatchObject({ name: "QuotaExceededError" });
  await writer.abort(); await small.write("x"); await small.close();
  await directory.removeEntry("small");
  const next = await handle.createWritable(); await next.write(large); await next.close();
  await directory.removeEntry("large");
  const final = await (await directory.getFileHandle("final", { create: true })).createWritable();
  await final.write(large); await final.abort();
});

it("removes a lease recursively without deleting another lease's files", async () => {
  const directory = await root();
  for (const name of ["old", "live"]) {
    const lease = await directory.getDirectoryHandle(name, { create: true });
    const writer = await (await lease.getFileHandle("piece", { create: true })).createWritable();
    await writer.write("ciphertext"); await writer.close();
  }
  await expect(directory.removeEntry("old")).rejects.toMatchObject({ name: "InvalidModificationError" });
  await directory.removeEntry("old", { recursive: true });
  await expect(directory.getDirectoryHandle("old")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(await (await (await (await directory.getDirectoryHandle("live")).getFileHandle("piece")).getFile()).text()).toBe("ciphertext");
});

it("keeps native OPFS when it is usable", async () => {
  const native = { native: true };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => native } });
  expect(await root()).toBe(native);
});

it("does not hide disk/quota failures by switching to temporary storage", async () => {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new DOMException("Full", "QuotaExceededError"); } } });
  await expect(root()).rejects.toMatchObject({ name: "QuotaExceededError" });
});
