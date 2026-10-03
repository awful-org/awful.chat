import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkPutMessages,
  senderMaxLamports,
  getMessagesAboveWatermarks,
  wipeLocalDatabase,
} from "./storage";
import { initStorageCrypto, clearStorageCrypto } from "./storage-crypto";
import { MessageType, type Message } from "./types/message";

const TEST_KEY = new Uint8Array(32).fill(42);

let seq = 0;
function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    roomCode: "room-a",
    senderId: "alice",
    senderName: "Alice",
    timestamp: 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  seq = 0;
});

// Clean up after all tests to avoid affecting other test suites
afterEach(() => {
  vi.restoreAllMocks();
  clearStorageCrypto();
});

/** The lowest lamport any read of the room's rows started at. */
function lowestRead(getAll: { mock: { calls: unknown[][] } }): number {
  return Math.min(...getAll.mock.calls.map(([range]) => (range as IDBKeyRange).lower[1]));
}

// A room as it really looks: someone posted once, long ago, and has been
// quiet since. A member back from a short absence lacks only the last few
// rows; the peer's watermark for the quiet sender is (correctly) that one old
// row. The push read should start near the rows the peer lacks.
describe("the push read floor", () => {
  it("is not dragged to the room's start by a sender the peer is not missing anything from", async () => {
    await bulkPutMessages([msg({ senderId: "quiet" })]);
    const rows = Array.from({ length: 400 }, (_, i) => msg({ senderId: i % 2 ? "alice" : "bob" }));
    await bulkPutMessages(rows);
    // Lamports: quiet wrote 1; then 2..401 alternate bob (even) / alice (odd).
    const theirs = { quiet: 1, alice: 395, bob: 396 };
    await senderMaxLamports("room-a");
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    const missing = await getMessagesAboveWatermarks("room-a", theirs);
    expect(missing.map((m) => m.lamport)).toEqual([397, 398, 399, 400, 401]);
    // Nothing at or below 395 can be missing: quiet's only row is at 1, and
    // the peer already holds it.
    expect(lowestRead(getAll)).toBeGreaterThan(395);
  });

  it("still starts at a quiet sender's mark when the peer lacks that sender's rows", async () => {
    await bulkPutMessages([msg({ senderId: "quiet" }), msg({ senderId: "quiet" })]);
    await bulkPutMessages(Array.from({ length: 100 }, () => msg({ senderId: "alice" })));
    await senderMaxLamports("room-a");
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    const missing = await getMessagesAboveWatermarks("room-a", { quiet: 1, alice: 102 });
    expect(missing.map((m) => m.lamport)).toEqual([2]);
    expect(lowestRead(getAll)).toBe(2);
  });

  it("reads nothing for a peer that lacks nothing", async () => {
    await bulkPutMessages([msg({ senderId: "alice" }), msg({ senderId: "bob" })]);
    await senderMaxLamports("room-a");
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    expect(await getMessagesAboveWatermarks("room-a", { alice: 1, bob: 2 })).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
  });
});
