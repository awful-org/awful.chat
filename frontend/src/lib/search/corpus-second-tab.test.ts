import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bulkPutMessages, getSearchIndex, putMessage, wipeLocalDatabase } from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import { clearSearchCorpus, ensureRoomCorpus, searchRooms } from "./corpus.svelte";
import { parseSearchQuery } from "./query";

// Two tabs of one profile share one database, and each tab's message-stored
// hook hears only its own writes. A tab that stepped down for another one
// ("Use here", node-lock.ts) keeps its search corpus and its pending index
// write; the tab that took over stores rows this one never sees. The index
// this tab writes must not vouch for those rows: its rowsBelow was counted
// from the database, so it took them in while its entries did not hold
// them, and the next session trusted the count and never read them again.
//
// The other tab is this module graph loaded a second time
// (vi.resetModules), over the same fake-indexeddb database.

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

/** Store rows from another tab: another copy of the storage module. */
async function storeFromOtherTab(...rows: Message[]): Promise<void> {
  vi.resetModules();
  const otherCrypto = await import("$lib/storage-crypto");
  await otherCrypto.initStorageCrypto(TEST_KEY);
  const otherStorage = await import("$lib/storage");
  await otherStorage.bulkPutMessages(rows);
}

beforeEach(async () => {
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  clearSearchCorpus();
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

it("finds a message another tab backfilled while this tab still held a dirty corpus", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  // This tab searched the room: corpus loaded, index written.
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");
  // A live message lands here, so this tab has an index write pending.
  await putMessage(msg({ content: "live in the first tab" }));

  // Another tab takes the node and stores history from a peer that was
  // offline: lamport below everything indexed. This tab's hook never fires.
  await storeFromOtherTab(
    msg({ id: "backfill-1", lamport: 5, content: "the backfilled needle" })
  );

  // The first tab's pending index write fires, whenever its timer says, and
  // lands (it covers the live message, lamport 31).
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await vi.waitFor(
    async () => expect((await getSearchIndex("room-a"))?.lastLamport).toBe(31),
    { timeout: 5_000, interval: 20 }
  );
  // It went without a count: this tab cannot vouch for every row below.
  expect((await getSearchIndex("room-a"))?.rowsBelow).toBeUndefined();

  // Next session: memory gone, the sealed row is all there is.
  clearSearchCorpus();
  await ensureRoomCorpus("room-a");
  expect(searchRooms(parseSearchQuery("backfilled needle"), ["room-a"])).toHaveLength(1);
});

// The tab that built its corpus while waiting for the node, then took the
// seat: what the holder stored meanwhile is NEWER than its index, and the
// live message after it moves lastLamport past those rows.
it("finds messages another tab stored above this tab's index, once a live one lands here", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");

  await storeFromOtherTab(
    msg({ content: "said while this tab waited" }),
    msg({ type: MessageType.Reaction, content: "+1", reactionTo: "msg-31" })
  );
  await putMessage(msg({ content: "live here afterwards" }));

  // This tab's pending write, once the throttle lets it through.
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await vi.waitFor(
    async () => expect((await getSearchIndex("room-a"))?.lastLamport).toBe(33),
    { timeout: 5_000, interval: 20 }
  );
  expect((await getSearchIndex("room-a"))?.rowsBelow).toBeUndefined();

  clearSearchCorpus();
  await ensureRoomCorpus("room-a");
  expect(searchRooms(parseSearchQuery("waited"), ["room-a"])).toHaveLength(1);
  expect(searchRooms(parseSearchQuery("afterwards"), ["room-a"])).toHaveLength(1);
});
