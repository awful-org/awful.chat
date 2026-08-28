import { beforeEach, describe, expect, it } from "vitest";
import {
  initStorageCrypto,
  clearStorageCrypto,
  sealRow,
  openRow,
  isSealed,
  rowHasBytes,
  beginPlaintextImport,
  STORE_SPECS,
} from "./storage-crypto";

const KEY = new Uint8Array(32).fill(7);

describe("storage at-rest crypto", () => {
  beforeEach(async () => {
    await initStorageCrypto(KEY);
  });

  it("round-trips a message and leaves no plaintext content on the row", async () => {
    const msg = {
      id: "m1",
      roomCode: "room-a",
      lamport: 4,
      senderId: "alice",
      type: "text",
      senderName: "Alice",
      content: "the secret plan",
      timestamp: 123,
    };
    const sealed = await sealRow(msg, STORE_SPECS.messages);

    // ID and lamport are clear fields; they survive for indexes.
    expect(sealed.id).toBe("m1");
    expect(sealed.lamport).toBe(4);
    // roomCode and senderId are blinded - the hash is indexable, the real
    // value is encrypted inside the blob.
    expect(typeof sealed.roomCode).toBe("string");
    expect(sealed.roomCode).toMatch(/^b1:/); // Blinded prefix
    expect(sealed.roomCode).not.toBe("room-a"); // Not plaintext
    expect(typeof sealed.senderId).toBe("string");
    expect(sealed.senderId).toMatch(/^b1:/); // Blinded prefix
    expect(sealed.senderId).not.toBe("alice"); // Not plaintext
    // ...and NOTHING readable remains of the body.
    expect(JSON.stringify(sealed)).not.toContain("secret plan");
    expect(JSON.stringify(sealed)).not.toContain("Alice");
    expect(isSealed(sealed)).toBe(true);

    const opened = await openRow<typeof msg>(sealed, STORE_SPECS.messages);
    expect(opened).toEqual(msg);
  });

  it("byte fields encrypt as raw buffers and round-trip", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 250]).buffer;
    const att = {
      id: "a1",
      roomCode: "r",
      messageId: "m1",
      infoHash: "h",
      status: "seeding",
      filename: "cat.png",
      mimeType: "image/png",
      size: 5,
      createdAt: 1,
      data,
    };
    const sealed = await sealRow(att, STORE_SPECS.attachments);
    expect(sealed.data).toBeUndefined();
    expect(rowHasBytes(sealed, "data")).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("cat.png");

    const opened = await openRow<typeof att>(sealed, STORE_SPECS.attachments);
    expect(new Uint8Array(opened.data as ArrayBuffer)).toEqual(
      new Uint8Array(data)
    );
    expect(opened.filename).toBe("cat.png");

    const meta = await openRow<typeof att>(sealed, STORE_SPECS.attachments, {
      skipBytes: true,
    });
    expect(meta.filename).toBe("cat.png");
    expect(meta.data).toBeUndefined();
  });

  it("legacy plaintext rows pass through openRow unchanged", async () => {
    const legacy = { id: "m1", roomCode: "r", content: "old row" };
    expect(await openRow(legacy, STORE_SPECS.messages)).toBe(legacy);
  });

  it("a different key cannot open the row", async () => {
    const sealed = await sealRow(
      { id: "x", content: "hidden" },
      STORE_SPECS.messages
    );
    await initStorageCrypto(new Uint8Array(32).fill(9));
    await expect(openRow(sealed, STORE_SPECS.messages)).rejects.toThrow();
  });

  it("a locked import window passes rows through plaintext, then the throw returns", async () => {
    clearStorageCrypto();
    const end = beginPlaintextImport();
    const row = await sealRow(
      { id: "p1", content: "imported before unlock" },
      STORE_SPECS.messages
    );
    expect(isSealed(row)).toBe(false);
    expect((row as { content?: string }).content).toBe("imported before unlock");
    end();
    await expect(sealRow({ id: "p2" }, STORE_SPECS.messages)).rejects.toThrow(
      /locked/
    );
  });

  it("openRows drops undecryptable rows instead of failing the query", async () => {
    const good = await sealRow({ id: "g", content: "ok" }, STORE_SPECS.messages);
    const bad = await sealRow({ id: "b", content: "broken" }, STORE_SPECS.messages);
    (bad._enc.ct as ArrayBuffer) = bad._enc.ct.slice(0, 4); // truncate
    const { openRows } = await import("./storage-crypto");
    const out = await openRows<{ id: string }>([good, bad], STORE_SPECS.messages);
    expect(out.map((r) => r.id)).toEqual(["g"]);
  });

  it("refuses to seal or open sealed rows while locked", async () => {
    const sealed = await sealRow({ id: "x" }, STORE_SPECS.messages);
    clearStorageCrypto();
    await expect(
      sealRow({ id: "y" }, STORE_SPECS.messages)
    ).rejects.toThrow(/locked/);
    await expect(openRow(sealed, STORE_SPECS.messages)).rejects.toThrow(
      /locked/
    );
  });
});
