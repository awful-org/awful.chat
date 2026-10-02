import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as storage from "$lib/storage";
import { bulkPutMessages, getSearchIndex, putMessage, wipeLocalDatabase } from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import { clearSearchCorpus, ensureRoomCorpus, saveSearchIndexes } from "./corpus.svelte";

// A room deleted in one tab must not get its sealed search index - the text
// of every message in it - back from another tab of the same profile. A tab
// that stepped down for another one ("Use here", node-lock.ts) keeps its
// corpus and its pending index write, and never hears of a deletion over
// there. The write is from memory, so nothing in this tab stops it; the
// room's rows do. An index is written only while they are all still there
// (saveIndex), counted again in one transaction with the write
// (putSearchIndex).
//
// The other tab is this module graph loaded a second time (vi.resetModules),
// over the same fake-indexeddb database, as corpus-second-tab.test.ts does.

const TEST_KEY = new Uint8Array(32).fill(7);
let seq = 0;

function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    roomCode: "room-a",
    senderId: "alice-id",
    senderDid: "did:key:alice",
    senderName: "Alice",
    timestamp: Date.now() - 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...overrides,
  };
}

async function otherTab(): Promise<typeof storage> {
  vi.resetModules();
  const otherCrypto = await import("$lib/storage-crypto");
  await otherCrypto.initStorageCrypto(TEST_KEY);
  return import("$lib/storage");
}

async function deleteRoomFromOtherTab(roomCode: string): Promise<void> {
  await (await otherTab()).deleteMessagesForRoom(roomCode);
}

beforeEach(async () => {
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  clearSearchCorpus();
  seq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not write back the index of a room another tab deleted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  // This tab searched the room: corpus loaded, index written.
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");
  expect(await getSearchIndex("room-a")).toBeDefined();

  // A live message lands here: an index write is pending (throttled).
  await putMessage(msg({ content: "said just before the room was deleted" }));

  // The other tab ("Use here") deletes the room: messages and index row.
  await deleteRoomFromOtherTab("room-a");
  expect(await getSearchIndex("room-a")).toBeUndefined();

  // This tab's pending write fires, whenever its timer says.
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // It used to write the deleted room's index back: all 31 messages' text.
  expect(await getSearchIndex("room-a")).toBeUndefined();
});

// Joined again over there, the room fills up from what arrives from now on.
// Rows again, but not the ones this tab's entries were read from.
it("does not write the index of a room another tab deleted back once it fills again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");
  await putMessage(msg({ content: "said just before the room was deleted" }));

  await deleteRoomFromOtherTab("room-a");
  await (await otherTab()).bulkPutMessages([
    msg({ content: "said after it was joined again" }),
    msg({ content: "and some more" }),
  ]);

  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(await getSearchIndex("room-a")).toBeUndefined();
});

it("does not write the index of a room another tab deletes while it is sealed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await putMessage(msg({ content: "said just before the room was deleted" }));

  // The rows are counted while they are all there, and the other tab's
  // deletion lands after that, before the write.
  const count = storage.countRoomRows;
  vi.spyOn(storage, "countRoomRows").mockImplementationOnce(async (roomCode, lamport) => {
    const counted = await count(roomCode, lamport);
    await deleteRoomFromOtherTab(roomCode);
    return counted;
  });

  await saveSearchIndexes();
  expect(await getSearchIndex("room-a")).toBeUndefined();
});
