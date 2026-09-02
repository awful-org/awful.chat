import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeLatestSharedPayload,
  storeSharedPayload,
} from "./share-target";

// fake-indexeddb (from test-setup) backs both the share store and the
// awful-notify database the device key lives in.

const DB_NAME = "awful-share-target";
const STORE = "pending";

/** Every stored row, exactly as it sits on disk. */
function rawRows(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, "readonly");
      const all = tx.objectStore(STORE).getAll();
      all.onsuccess = () => resolve((all.result as unknown[]) ?? []);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => db.close();
    };
    req.onerror = () => reject(req.error);
  });
}

function file(name: string, body: string): File {
  return new File([body], name, { type: "text/plain" });
}

beforeEach(async () => {
  // Whatever a previous case left behind: the store must start empty.
  await consumeLatestSharedPayload();
});

describe("pending shares", () => {
  it("round-trips a share through the sealed record", async () => {
    await storeSharedPayload({
      title: "a title",
      text: "some text",
      url: "https://example.invalid/x",
      files: [file("note.txt", "file body")],
    });

    const got = await consumeLatestSharedPayload();
    expect(got?.title).toBe("a title");
    expect(got?.text).toBe("some text");
    expect(got?.url).toBe("https://example.invalid/x");
    expect(got?.files).toHaveLength(1);
    expect(got?.files[0].name).toBe("note.txt");
    expect(got?.files[0].type).toBe("text/plain");
    expect(await got?.files[0].text()).toBe("file body");

    // Claimed once, then gone.
    expect(await consumeLatestSharedPayload()).toBeNull();
  });

  it("leaves nothing readable on disk", async () => {
    await storeSharedPayload({
      title: "the title",
      text: "the shared secret",
      url: "https://example.invalid/private",
      files: [file("photo.txt", "the file bytes")],
    });

    const [row] = (await rawRows()) as Array<Record<string, unknown>>;
    // Only the key path and the eviction index stay in the clear.
    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "fileData",
      "id",
      "meta",
    ]);
    // Nothing the user shared - not even a file name - survives as a string.
    const dump = JSON.stringify(row);
    for (const secret of [
      "the title",
      "the shared secret",
      "example.invalid",
      "photo.txt",
      "the file bytes",
    ]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("still keeps at most three pending shares, newest first", async () => {
    for (const n of [1, 2, 3, 4]) {
      await storeSharedPayload({ text: `share ${n}`, files: [] });
    }

    expect(await rawRows()).toHaveLength(3);
    const got = await consumeLatestSharedPayload();
    expect(got?.text).toBe("share 4");
  });
});
