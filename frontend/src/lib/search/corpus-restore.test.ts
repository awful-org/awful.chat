import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bulkPutMessages, getSearchIndex, putMessage, wipeLocalDatabase } from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import { clearSearchCorpus, ensureRoomCorpus } from "./corpus.svelte";

// A restore that takes the device over (DataSettings, replace mode) arms the
// backup's identity with no lock event, wipes the database and imports that
// account's rows. The session it replaces keeps its search corpus and its
// pending index write until the page reloads after the import. That write
// must not seal this session's message text under the new key, into the
// new database: the index is written under the key its entries were read
// with, or not at all.

const TEST_KEY = new Uint8Array(32).fill(7);
const RESTORED_KEY = new Uint8Array(32).fill(9);
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

/**
 * The imported account's rows, this room's among them. Stored from a
 * second copy of the storage module, so this one's hook does not take them
 * in: the room then holds as many rows as the corpus has seen, and only the
 * key is left to tell the two accounts apart.
 */
async function importRestoredRows(rows: Message[]): Promise<void> {
  vi.resetModules();
  const otherCrypto = await import("$lib/storage-crypto");
  await otherCrypto.initStorageCrypto(RESTORED_KEY);
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

it("seals no index of the session a restore replaced under the restored key", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await bulkPutMessages(Array.from({ length: 30 }, () => msg()));
  await ensureRoomCorpus("room-a");
  // A live message: this session has an index write pending.
  await putMessage(msg({ content: "said before the restore" }));

  await initStorageCrypto(RESTORED_KEY);
  await wipeLocalDatabase();
  await importRestoredRows(
    Array.from({ length: 40 }, () => msg({ content: "the restored account's" }))
  );

  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(await getSearchIndex("room-a")).toBeUndefined();
});
