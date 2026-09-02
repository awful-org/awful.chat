import { beforeEach, describe, expect, it } from "vitest";
import {
  initStorageCrypto,
  clearStorageCrypto,
  sealRow,
  openRow,
  isSealed,
  rowHasBytes,
  beginPlaintextImport,
  setAtRestSweepPending,
  STORE_SPECS,
  inspectRow,
  DeadRowError,
} from "./storage-crypto";

const KEY = new Uint8Array(32).fill(7);

/** The at-rest key, derived exactly as initStorageCrypto does, so a test can
 *  hand-build a blob the way an older build wrote it. */
async function atRestKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey("raw", KEY, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("awful.chat storage at-rest v1"),
      info: enc.encode("storage-key"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

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

  // ── AAD row binding ─────────────────────────────────────────────────────
  // A blob's additionalData is "<storeName> <primaryKey>", so lifting one
  // row's _enc onto another row's envelope must fail the AES-GCM auth tag
  // check, even though both were sealed under the same key.

  it("a blob sealed for (messages, id 1) fails when presented under a different id in the same store", async () => {
    const sealed1 = await sealRow(
      { id: "m1", content: "for m1" },
      STORE_SPECS.messages
    );
    const sealed2 = await sealRow(
      { id: "m2", content: "for m2" },
      STORE_SPECS.messages
    );
    // m2's envelope (its own clear/blinded fields), but m1's ciphertext.
    const swapped = { ...sealed2, _enc: sealed1._enc };
    await expect(openRow(swapped, STORE_SPECS.messages)).rejects.toThrow();
  });

  it("a blob sealed for (messages, id x1) fails when presented as (attachments, id x1)", async () => {
    const messageRow = await sealRow(
      { id: "x1", content: "message body" },
      STORE_SPECS.messages
    );
    const attachmentRow = await sealRow(
      { id: "x1", status: "complete", filename: "f" },
      STORE_SPECS.attachments
    );
    // Same store-relative primary key value, different store.
    const swapped = { ...attachmentRow, _enc: messageRow._enc };
    await expect(
      openRow(swapped, STORE_SPECS.attachments)
    ).rejects.toThrow();
  });

  // ── AAD v3: the clear fields are bound too ──────────────────────────────

  it("seals at v3 and round-trips with the clear fields bound in", async () => {
    const sealed = await sealRow(
      {
        id: "m3",
        lamport: 1,
        type: "text",
        status: "sent",
        content: "bound to its own row",
      },
      STORE_SPECS.messages
    );
    expect(sealed._enc.v).toBe(3);
    const opened = await openRow<{ content: string; status: string }>(
      sealed,
      STORE_SPECS.messages
    );
    expect(opened.content).toBe("bound to its own row");
    expect(opened.status).toBe("sent");
  });

  it("a v3 blob fails when a clear field beside it is swapped", async () => {
    const sealed = await sealRow(
      {
        id: "m3",
        lamport: 1,
        type: "text",
        status: "sent",
        content: "delivered once",
      },
      STORE_SPECS.messages
    );
    // Raw database access flipping the receipt status, or moving the message
    // in the lamport order, without touching the ciphertext.
    await expect(
      openRow({ ...sealed, status: "read" }, STORE_SPECS.messages)
    ).rejects.toThrow();
    await expect(
      openRow({ ...sealed, lamport: 99 }, STORE_SPECS.messages)
    ).rejects.toThrow();
  });

  it("a row sealed twice is dead: inspectRow throws DeadRowError, openRow rejects", async () => {
    // What the 2026-09-02 sweep left behind: sealRow applied to a row that
    // was already sealed. JSON.stringify turned the inner ArrayBuffer `ct`
    // into {}, so there is nothing to unwrap - only to recognise.
    const once = await sealRow(
      { id: "m3", lamport: 3, type: "text", status: "sent", roomCode: "room-z", senderId: "alice", content: "twice" },
      STORE_SPECS.messages
    );
    const twice = await sealRow(once as unknown as Record<string, unknown>, STORE_SPECS.messages);
    await expect(inspectRow(twice, STORE_SPECS.messages)).rejects.toBeInstanceOf(DeadRowError);
    await expect(openRow(twice, STORE_SPECS.messages)).rejects.toThrow(/sealed twice/);
    // A row sealed once is untouched by the check.
    const single = await inspectRow<{ content: string }>(once, STORE_SPECS.messages);
    expect(single.value.content).toBe("twice");
  });

  it("a v2 blob - bound to store and primary key only - still opens", async () => {
    // Exactly what a build before this change left on disk: AAD with no clear
    // fields in it, marked `v: 2`. The v3 AAD for this same row would read
    // "messages m2 id=m2 lamport=9 type=text status=sent", so this only opens
    // if decrypt builds the AAD the blob's OWN marker asks for.
    const key = await atRestKey();
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode("messages m2") },
      key,
      enc.encode(JSON.stringify({ senderName: "Alice", content: "old build" }))
    );
    const row = {
      id: "m2",
      lamport: 9,
      type: "text",
      status: "sent",
      _enc: { iv, ct, v: 2 },
    };

    const opened = await openRow<{ content: string; lamport: number }>(
      row,
      STORE_SPECS.messages
    );
    expect(opened.content).toBe("old build");
    expect(opened.lamport).toBe(9);
  });

  it("refuses an unsealed row once the at-rest sweep has finished", async () => {
    const legacy = { id: "m4", roomCode: "room-a", content: "never sealed" };
    // While a sweep may still be pending, plaintext rows are the sweep's job
    // and must stay readable.
    expect(await openRow(legacy, STORE_SPECS.messages)).toBe(legacy);

    setAtRestSweepPending(() => false);
    try {
      await expect(openRow(legacy, STORE_SPECS.messages)).rejects.toThrow(
        /unsealed row/
      );
      // The one spec with no store behind it has no sweep to wait for.
      expect(await openRow(legacy, { clear: ["id"] })).toBe(legacy);
    } finally {
      setAtRestSweepPending(() => true);
    }
  });

  it("a legacy blob with no AAD/version marker still decrypts", async () => {
    // Simulates a row written before AAD binding existed: sealed with a spec
    // that carries no storeName/key, exactly like every StoreCryptoSpec used
    // to look. The blob it produces has no `v` marker.
    const legacySpec = { clear: ["id"] };
    const legacy = await sealRow(
      { id: "m1", content: "predates AAD" },
      legacySpec
    );
    expect(legacy._enc.v).toBeUndefined();
    // Opened with the CURRENT, AAD-carrying spec - decrypt must skip AAD
    // because the blob itself says (via the missing `v`) it was never bound.
    const opened = await openRow<{ id: string; content: string }>(
      legacy,
      STORE_SPECS.messages
    );
    expect(opened.content).toBe("predates AAD");
  });
});
