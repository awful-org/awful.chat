import { afterEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "./transport/file/opfs-test-helper";
import { executeDuressWipe } from "./duress";

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

  void executeDuressWipe();
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  expect([...disk.entries.keys()]).toEqual([]);
});
