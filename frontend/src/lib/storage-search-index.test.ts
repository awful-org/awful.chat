import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as storageCrypto from "./storage-crypto";
import {
  beginPlaintextImport,
  blindValue,
  clearStorageCrypto,
  initStorageCrypto,
} from "./storage-crypto";
import {
  bulkPutMessages,
  deleteMessagesForRoom,
  getDB,
  getSearchIndex,
  putSearchIndex,
  wipeLocalDatabase,
  type SearchIndexRecord,
} from "./storage";
import { MessageType, type Message } from "./types/message";

/**
 * A room's sealed search index is the text of every searchable message in
 * it. It is written only while the room has the rows its entries were read
 * from, checked in the transaction that writes it, and only sealed under the
 * key its entries were read with; a room's deletion takes it along in the
 * transaction that takes the rows.
 */

const KEY = new Uint8Array(32).fill(7);
const RESTORED_KEY = new Uint8Array(32).fill(9);

function msg(i: number): Message {
  return {
    id: `msg-${i}`,
    roomCode: "room-a",
    senderId: "alice-id",
    senderName: "Alice",
    timestamp: 1_000 + i,
    lamport: i,
    type: MessageType.Text,
    content: `message ${i}`,
    attachments: [],
  };
}

const rows = [msg(1), msg(2), msg(3)];

function record(): SearchIndexRecord {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, entries: [] }));
  return { roomCode: "room-a", lastLamport: 3, data: bytes.buffer as ArrayBuffer };
}

beforeEach(async () => {
  await initStorageCrypto(KEY);
  await wipeLocalDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes a room's index while the room has rows", async () => {
  await bulkPutMessages(rows);
  expect(await putSearchIndex(record())).toBe(true);
  expect((await getSearchIndex("room-a"))?.lastLamport).toBe(3);
});

it("writes no index for a room with no rows", async () => {
  expect(await putSearchIndex(record())).toBe(false);
  expect(await getSearchIndex("room-a")).toBeUndefined();
});

it("writes no index for a room that lost rows since they were counted", async () => {
  await bulkPutMessages(rows);
  expect(await putSearchIndex(record(), { minRows: 4 })).toBe(false);
  expect(await getSearchIndex("room-a")).toBeUndefined();
});

// Deleted in another tab and filled again there: as many rows as when the
// entries were read, but not the messages they were read from.
it("writes no index whose messages are not all among the room's rows", async () => {
  await bulkPutMessages(rows);
  expect(await putSearchIndex(record(), { minRows: 3, ids: ["msg-1", "msg-9"] })).toBe(false);
  expect(await getSearchIndex("room-a")).toBeUndefined();
  expect(await putSearchIndex(record(), { minRows: 3, ids: ["msg-1", "msg-2", "msg-3"] })).toBe(true);
});

// A restore that takes the device over arms the backup's identity with no
// lock event, wipes the database and imports that account's rows, while
// the session it replaces still holds its search corpus.
it("seals no index under a key other than the one its entries were read with", async () => {
  const readWith = await blindValue("room-a");
  await initStorageCrypto(RESTORED_KEY);
  await wipeLocalDatabase();
  await bulkPutMessages(rows);

  expect(await putSearchIndex(record(), { rowKey: readWith })).toBe(false);
  expect(await getSearchIndex("room-a")).toBeUndefined();
  expect(await putSearchIndex(record(), { rowKey: await blindValue("room-a") })).toBe(true);
});

// An import onto a device with no key armed passes rows through unsealed
// (beginPlaintextImport) until the first unlock seals them.
it("never writes an index unsealed, not even in an import's plaintext window", async () => {
  clearStorageCrypto();
  const endImport = beginPlaintextImport();
  try {
    await bulkPutMessages(rows);
    expect(await putSearchIndex(record())).toBe(false);
  } finally {
    endImport();
  }
  expect(await (await getDB()).getAll("searchIndex")).toEqual([]);
});

it("takes along an index another tab writes while the room is being deleted", async () => {
  await bulkPutMessages(rows);
  // The other tab: this module graph loaded a second time, over the same
  // database.
  vi.resetModules();
  const otherCrypto = await import("./storage-crypto");
  await otherCrypto.initStorageCrypto(KEY);
  const other = await import("./storage");

  // Its write lands in the middle of this tab's deletion: after the index
  // row is first deleted, while the rows are still there.
  const blind = storageCrypto.blindValue;
  let written = false;
  vi.spyOn(storageCrypto, "blindValue").mockImplementation(async (value) => {
    if (value === "msg-1" && !written) written = await other.putSearchIndex(record());
    return blind(value);
  });
  await deleteMessagesForRoom("room-a");

  expect(written).toBe(true);
  expect(await getSearchIndex("room-a")).toBeUndefined();
});
