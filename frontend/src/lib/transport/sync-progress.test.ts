import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_STALL_MS,
  _resetSyncProgress,
  noteSyncBatch,
  noteSyncComplete,
  syncProgress,
} from "./sync-progress.svelte";

beforeEach(() => {
  _resetSyncProgress();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sync progress", () => {
  it("counts a push frame by frame and clears on complete", () => {
    noteSyncBatch("room-a", "peer-1", 0, 3, 20);
    expect(syncProgress.get("room-a")).toEqual({
      batches: 1,
      total: 3,
      messages: 20,
    });
    noteSyncBatch("room-a", "peer-1", 1, 3, 20);
    noteSyncBatch("room-a", "peer-1", 2, 3, 7);
    expect(syncProgress.get("room-a")).toEqual({
      batches: 3,
      total: 3,
      messages: 47,
    });
    noteSyncComplete("room-a", "peer-1");
    expect(syncProgress.has("room-a")).toBe(false);
  });

  it("sums the peers pushing to one room, and stays up until the last is done", () => {
    noteSyncBatch("room-a", "peer-1", 0, 2, 20);
    noteSyncBatch("room-a", "peer-2", 0, 4, 20);
    expect(syncProgress.get("room-a")).toEqual({
      batches: 2,
      total: 6,
      messages: 40,
    });
    noteSyncComplete("room-a", "peer-1");
    expect(syncProgress.get("room-a")).toEqual({
      batches: 1,
      total: 4,
      messages: 20,
    });
    noteSyncComplete("room-a", "peer-2");
    expect(syncProgress.has("room-a")).toBe(false);
  });

  it("keeps rooms apart", () => {
    noteSyncBatch("room-a", "peer-1", 0, 1, 5);
    noteSyncBatch("room-b", "peer-1", 0, 1, 5);
    noteSyncComplete("room-a", "peer-1");
    expect(syncProgress.has("room-a")).toBe(false);
    expect(syncProgress.has("room-b")).toBe(true);
  });

  it("gives up on a push whose frames stop without a complete", () => {
    noteSyncBatch("room-a", "peer-1", 0, 5, 20);
    vi.advanceTimersByTime(SYNC_STALL_MS - 1);
    expect(syncProgress.has("room-a")).toBe(true);
    // Every frame extends the deadline.
    noteSyncBatch("room-a", "peer-1", 1, 5, 20);
    vi.advanceTimersByTime(SYNC_STALL_MS - 1);
    expect(syncProgress.has("room-a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(syncProgress.has("room-a")).toBe(false);
  });

  it("never reads further along than the total, whatever a peer sends", () => {
    noteSyncBatch("room-a", "peer-1", 0, 3, 1);
    noteSyncBatch("room-a", "peer-1", 2, 3, 1);
    // Next push from the same peer restarts at 0 with a smaller total.
    noteSyncBatch("room-a", "peer-1", 0, 1, 1);
    const p = syncProgress.get("room-a")!;
    expect(p.batches).toBeLessThanOrEqual(p.total);
  });

  it("counts a frame that does not describe a push as nothing", () => {
    noteSyncBatch("room-a", "peer-1", -1, 3, 1);
    noteSyncBatch("room-a", "peer-1", 3, 3, 1);
    noteSyncBatch("room-a", "peer-1", 0, 0, 1);
    noteSyncBatch("room-a", "peer-1", Number.NaN, 3, 1);
    noteSyncBatch("room-a", "peer-1", 0, Number.POSITIVE_INFINITY, 1);
    expect(syncProgress.has("room-a")).toBe(false);
  });

  it("completing a room nobody is pushing to is a no-op", () => {
    noteSyncComplete("room-a", "peer-1");
    expect(syncProgress.has("room-a")).toBe(false);
  });
});
