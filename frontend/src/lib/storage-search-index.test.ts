import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as storageCrypto from "./storage-crypto";
import { initStorageCrypto } from "./storage-crypto";
import {
  bulkPutMessages,
  deleteMessagesForRoom,
  getSearchIndex,
  putSearchIndex,
  wipeLocalDatabase,
  type SearchIndexRecord,
} from "./storage";
import { MessageType, type Message } from "./types/message";

/**
 * A room's sealed search index is the text of every searchable message in
 * it. It is written only while the room has its rows, counted in the
 * transaction that writes it; a room's deletion takes it along in the
 * transaction that takes the rows.
 */

const KEY = new Uint8Array(32).fill(7);

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
