import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "./transport/file/opfs-test-helper";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it("the duress wipe empties the origin's private file system too", async () => {
  const disk = fakeOPFS();
  disk.entries.set(`room-v2-ciphertext/${"a".repeat(40)}`, new Blob(["ciphertext"]));
  // Where an older build left a decrypted attachment behind.
  disk.entries.set("room-v2-transfers/3a1392f4-7763-43e2-a8a9-7cd8fb556978", new Blob(["scanned passport"]));
  disk.entries.set("room-v2-pieces/0123456789abcdef/0", new Blob(["piece"]));
  disk.entries.set("anything-else/file", new Blob(["x"]));
  const replace = vi.fn();
  vi.stubGlobal("navigator", { storage: disk.storage });
  vi.stubGlobal("location", { replace });

  const { executeDuressWipe } = await import("./duress");
  void executeDuressWipe();
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  expect([...disk.entries.keys()]).toEqual([]);
});

it("waits for blocked IndexedDB deletion instead of showing a false fresh install", async () => {
  const disk = fakeOPFS();
  const replace = vi.fn();
  const requests: Array<{ onsuccess?: () => void; onerror?: () => void }> = [];
  vi.stubGlobal("navigator", { storage: disk.storage });
  vi.stubGlobal("location", { replace });
  vi.stubGlobal("indexedDB", {
    databases: async () => [],
    deleteDatabase: () => {
      const req: (typeof requests)[number] = {};
      requests.push(req);
      return req;
    },
  });
  const { executeDuressWipe } = await import("./duress");
  void executeDuressWipe();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(replace).not.toHaveBeenCalled();
  expect(requests.length).toBeGreaterThan(0);

  for (const req of requests) req.onsuccess?.();
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
});

it("does not navigate when a database deletion fails", async () => {
  const disk = fakeOPFS();
  const replace = vi.fn();
  vi.stubGlobal("navigator", { storage: disk.storage });
  vi.stubGlobal("location", { replace });
  vi.stubGlobal("indexedDB", {
    databases: async () => [],
    deleteDatabase: () => {
      const req: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
      req.error = new Error("deletion denied");
      queueMicrotask(() => req.onerror?.());
      return req;
    },
  });
  const { executeDuressWipe } = await import("./duress");
  await expect(executeDuressWipe()).rejects.toThrow("deletion denied");
  expect(replace).not.toHaveBeenCalled();
});

it("does not navigate when private-file deletion fails", async () => {
  const disk = fakeOPFS();
  disk.entries.set("private/file", new Blob(["secret"]));
  const root = await disk.storage.getDirectory();
  const remove = root.removeEntry;
  root.removeEntry = async (name: string, opts?: { recursive?: boolean }) => {
    if (name === "private") throw new Error("OPFS denied");
    return remove(name, opts);
  };
  const replace = vi.fn();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  vi.stubGlobal("location", { replace });
  const { executeDuressWipe } = await import("./duress");
  await expect(executeDuressWipe()).rejects.toThrow("OPFS denied");
  expect(replace).not.toHaveBeenCalled();
  expect(disk.entries.has("private/file")).toBe(true);
});
