import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMessagesForRoom,
  getSearchIndex,
  putMessage,
  bulkPutMessages,
  wipeLocalDatabase,
  getSearchableStats,
} from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import {
  clearSearchCorpus,
  corpusState,
  ensureRoomCorpus,
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

  it("detects a stale index and re-sweeps", async () => {
    await putMessage(msg({ content: "first" }));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    // A message stored while no corpus is warm: the sealed index has not
    // flushed (3s debounce), so lastLamport is behind the messages store.
    await putMessage(msg({ content: "the fresh needle" }));
    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("fresh needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("live-appends stored messages into a warm corpus", async () => {
    await ensureRoomCorpus("room-a");
    await putMessage(msg({ content: "landed after the sweep" }));
    const hits = searchRooms(parseSearchQuery("landed"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("re-sweeps when a BACKFILLED older message missed the index flush", async () => {
    // The repair-sync shape: history arrives with lamports BELOW the room's
    // high-water mark. lastLamport alone cannot see it - only the entry
    // count can, and a crash inside the 3s append debounce loses the
    // in-memory pending queue, which is what clearSearchCorpus simulates.
    await putMessage(msg({ content: "recent message", lamport: 100 }));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    await bulkPutMessages([
      msg({ content: "backfilled needle from the past", lamport: 5 }),
    ]);
    clearSearchCorpus(); // the pending index append dies with the "crash"

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
