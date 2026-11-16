import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DM_QUEUE_KEY,
  DM_QUEUE_MAX,
  importDmQueueBlob,
  loadQueuedDmMessages,
  mergeDmQueues,
  readDmQueueBlob,
  saveQueuedDmMessages,
  type QueuedMessage,
} from "./dm-queue";
import { createIdentity, lockIdentity } from "../identity/identity";
import { wipeLocalDatabase } from "../storage";

const entry = (messageId: string, queuedAt: number, to = "did:key:zBob"): QueuedMessage =>
  ({ to, data: [1], queuedAt, messageId });

describe("mergeDmQueues", () => {
  it("keeps each entry once, oldest first", () => {
    const merged = mergeDmQueues(
      [entry("b", 20), entry("a", 10)],
      [entry("a", 10), entry("c", 30)],
    );
    expect(merged.map((e) => e.messageId)).toEqual(["a", "b", "c"]);
  });

  it("stays within the queue's own bound, giving up the oldest", () => {
    const local = Array.from({ length: DM_QUEUE_MAX }, (_, i) => entry(`l${i}`, 1_000 + i));
    const merged = mergeDmQueues(local, [entry("older", 1), entry("newest", 9_999)]);
    expect(merged).toHaveLength(DM_QUEUE_MAX);
    expect(merged.at(-1)?.messageId).toBe("newest");
    expect(merged.some((e) => e.messageId === "older")).toBe(false);
  });
});

// The retry queue lived only in this device's localStorage, so a message
// still waiting to be delivered was lost to a device sync: the new device had
// its row, stuck on "sending", and nothing that would ever send it.
describe("carrying the DM retry queue between devices", () => {
  const store = new Map<string, string>();

  beforeEach(async () => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    await wipeLocalDatabase();
    await createIdentity("dm-queue-test-password");
  });

  afterEach(() => {
    lockIdentity();
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("travels sealed, and a replace stores it as it came", async () => {
    await saveQueuedDmMessages([entry("there", 10)]);
    const blob = readDmQueueBlob()!;
    expect(blob).not.toContain("zBob");
    store.clear();
    await importDmQueueBlob(blob, "replace");
    expect(store.get(DM_QUEUE_KEY)).toBe(blob);
    expect((await loadQueuedDmMessages()).map((e) => e.messageId)).toEqual(["there"]);
  });

  it("a replace with no queue to bring clears this device's", async () => {
    await saveQueuedDmMessages([entry("here", 10)]);
    await importDmQueueBlob(undefined, "replace");
    expect(store.has(DM_QUEUE_KEY)).toBe(false);
  });

  it("a merge folds it into the local queue", async () => {
    await saveQueuedDmMessages([entry("there", 10)]);
    const blob = readDmQueueBlob()!;
    await saveQueuedDmMessages([entry("here", 20)]);
    await importDmQueueBlob(blob, "add");
    expect((await loadQueuedDmMessages()).map((e) => e.messageId)).toEqual(["there", "here"]);
  });

  it("a merge leaves out a queue that does not open under this account", async () => {
    await saveQueuedDmMessages([entry("here", 20)]);
    const foreign = JSON.stringify({ iv: btoa("x".repeat(12)), ct: btoa("y".repeat(40)) });
    await importDmQueueBlob(foreign, "add");
    expect((await loadQueuedDmMessages()).map((e) => e.messageId)).toEqual(["here"]);
  });

  it("a merge takes a queue from before the sealing, and stores it sealed", async () => {
    const legacy = JSON.stringify([entry("legacy", 5)]);
    await importDmQueueBlob(legacy, "add");
    expect((await loadQueuedDmMessages()).map((e) => e.messageId)).toEqual(["legacy"]);
    expect(store.get(DM_QUEUE_KEY)).not.toContain("legacy");
  });
});
