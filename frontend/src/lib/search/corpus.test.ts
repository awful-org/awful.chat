import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "$lib/storage";
import {
  deleteMessagesForRoom,
  getSearchIndex,
  putMessage,
  putSearchIndex,
  bulkPutMessages,
  wipeLocalDatabase,
  getSearchableStats,
} from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import {
  clearSearchCorpus,
  corpusState,
  dropRoomCorpus,
  ensureRoomCorpus,
  saveSearchIndexes,
  searchRooms,
  scopeProgress,
} from "./corpus.svelte";
import { parseSearchQuery } from "./query";

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

function many(count: number, overrides: Partial<Message> = {}): Message[] {
  return Array.from({ length: count }, () => msg(overrides));
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

describe("search corpus", () => {
  it("sweeps a room and finds messages", async () => {
    await putMessage(msg({ content: "the deploy went fine" }));
    await putMessage(msg({ content: "unrelated chatter" }));
    await ensureRoomCorpus("room-a");

    const hits = searchRooms(parseSearchQuery("deploy"), ["room-a"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.text).toContain("deploy");
    expect(scopeProgress(["room-a"]).done).toBe(true);
  });

  it("writes a sealed index the next session reuses", async () => {
    await putMessage(msg({ content: "needle in the haystack" }));
    await ensureRoomCorpus("room-a");

    const record = await getSearchIndex("room-a");
    expect(record).toBeDefined();
    expect(record!.lastLamport).toBe(
      (await getSearchableStats("room-a", [MessageType.Text])).newestLamport
    );

    // "Next session": memory gone, index row still there.
    clearSearchCorpus();
    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("brings a stale index current from where it ends", async () => {
    await putMessage(msg({ content: "first" }));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    // A message stored while no corpus is warm: the sealed index is behind
    // the messages store.
    await putMessage(msg({ content: "the fresh needle" }));
    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("fresh needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("tops a stale index up without sweeping the room again", async () => {
    await bulkPutMessages(many(120));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    await putMessage(msg({ content: "landed later" }));
    await putMessage(msg({ type: MessageType.Reaction, content: "+1", reactionTo: "msg-1" }));
    await putMessage(msg({ content: "landed last" }));

    const sweep = vi.spyOn(storage, "getMessages");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await ensureRoomCorpus("room-a");

    expect(searchRooms(parseSearchQuery("landed"), ["room-a"])).toHaveLength(2);
    expect(searchRooms(parseSearchQuery('"message 7"'), ["room-a"]).length).toBeGreaterThan(0);
    expect(sweep).not.toHaveBeenCalled();
    // The index row (its fields, then its entries) and the two new messages.
    // The reaction is left out on its clear type, before any decrypt.
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it("opens a current index with one row's decrypt, reading no message", async () => {
    await bulkPutMessages(many(120));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    const walk = vi.spyOn(storage, "getSearchableStats");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await ensureRoomCorpus("room-a");

    expect(searchRooms(parseSearchQuery("message"), ["room-a"])).toHaveLength(80);
    expect(walk).not.toHaveBeenCalled();
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it("uses an index row an older build wrote, and writes it back with its count", async () => {
    await bulkPutMessages(many(30));
    await ensureRoomCorpus("room-a");
    const written = await getSearchIndex("room-a");
    expect(written!.rowsBelow).toBe(29);
    // What builds before the count wrote: the same row without it.
    await putSearchIndex({
      roomCode: "room-a",
      lastLamport: written!.lastLamport,
      data: written!.data,
    });
    clearSearchCorpus();
    await putMessage(msg({ content: "after the old build" }));

    const sweep = vi.spyOn(storage, "getMessages");
    await ensureRoomCorpus("room-a");
    expect(sweep).not.toHaveBeenCalled();
    expect(searchRooms(parseSearchQuery("old build"), ["room-a"])).toHaveLength(1);

    await saveSearchIndexes();
    const upgraded = await getSearchIndex("room-a");
    expect(upgraded!.lastLamport).toBe(31);
    expect(upgraded!.rowsBelow).toBe(30);
  });

  it("live-appends stored messages into a warm corpus", async () => {
    await ensureRoomCorpus("room-a");
    await putMessage(msg({ content: "landed after the sweep" }));
    const hits = searchRooms(parseSearchQuery("landed"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("rebuilds when a BACKFILLED older message is missing from the index", async () => {
    // The repair-sync shape: history arrives with lamports BELOW the room's
    // high-water mark. lastLamport alone cannot see it - only the count of
    // rows below it can. An index written before the row was stored, by a
    // session that then closed, is exactly that.
    await putMessage(msg({ content: "recent message", lamport: 100 }));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    await bulkPutMessages([
      msg({ content: "backfilled needle from the past", lamport: 5 }),
    ]);

    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("backfilled needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("deleting a room deletes its sealed index row", async () => {
    await putMessage(msg({ content: "gone soon" }));
    await ensureRoomCorpus("room-a");
    expect(await getSearchIndex("room-a")).toBeDefined();
    await deleteMessagesForRoom("room-a");
    expect(await getSearchIndex("room-a")).toBeUndefined();
  });

  it("excludes non-searchable types", async () => {
    await putMessage(
      msg({ type: MessageType.Reaction, content: "thumbs", reactionTo: "x" })
    );
    await ensureRoomCorpus("room-a");
    expect(searchRooms(parseSearchQuery("thumbs"), ["room-a"])).toHaveLength(0);
  });

  it("announces a sweep's growth a couple of times, not once per page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await bulkPutMessages(many(500));
    const before = corpusState.version;
    await ensureRoomCorpus("room-a");
    // Ten pages. Each announcement re-ran the whole search being typed.
    const announced = corpusState.version - before;
    expect(announced).toBeGreaterThanOrEqual(1);
    expect(announced).toBeLessThanOrEqual(2);
  });
});

describe("sealed index writes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  async function searchedBefore(roomCode: string, content: string): Promise<void> {
    await bulkPutMessages(many(20, { roomCode, content }));
    await ensureRoomCorpus(roomCode);
  }

  it("rewrites no index when a message is stored", async () => {
    await searchedBefore("room-a", "alpha");
    await searchedBefore("room-b", "beta");
    // room-b was searched in an earlier session: it has an index row but is
    // not in memory now. room-a is.
    clearSearchCorpus();
    await ensureRoomCorpus("room-a");

    const get = vi.spyOn(storage, "getSearchIndex");
    const put = vi.spyOn(storage, "putSearchIndex");
    for (let i = 0; i < 5; i++) {
      await putMessage(msg({ roomCode: "room-a", content: `live a ${i}` }));
      await putMessage(msg({ roomCode: "room-b", content: `live b ${i}` }));
      await vi.advanceTimersByTimeAsync(700);
    }

    // Found at once, from memory.
    expect(searchRooms(parseSearchQuery("live"), ["room-a"])).toHaveLength(5);
    // Each of these used to queue a read, decode, re-seal and write of its
    // room's whole index three seconds on - room-b's too, unsearched.
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    // Once things go quiet, room-a's index is written once, from memory.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0].roomCode).toBe("room-a");
    expect(get).not.toHaveBeenCalled();
  });

  it("writes a busy room's index at most once per five minutes", async () => {
    await searchedBefore("room-a", "alpha");
    const put = vi.spyOn(storage, "putSearchIndex");

    for (let minute = 0; minute < 4; minute++) {
      await putMessage(msg({ content: `minute ${minute}` }));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(put).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect((await getSearchIndex("room-a"))!.lastLamport).toBe(24);
  });

  it("gives a room deleted mid-write no index back", async () => {
    await searchedBefore("room-a", "alpha");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await putMessage(msg({ content: "about to go" }));
    const put = vi.spyOn(storage, "putSearchIndex");
    const count = storage.countRowsBelow;
    vi.spyOn(storage, "countRowsBelow").mockImplementationOnce(async (roomCode, lamport) => {
      // The room is deleted while its index is being written.
      dropRoomCorpus("room-a");
      await deleteMessagesForRoom("room-a");
      return count(roomCode, lamport);
    });

    await saveSearchIndexes();
    expect(put).not.toHaveBeenCalled();
    expect(await getSearchIndex("room-a")).toBeUndefined();
  });
});
