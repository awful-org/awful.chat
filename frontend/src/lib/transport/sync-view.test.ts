import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "$lib/types/message";
import {
  SYNC_VIEW_MAX_WAIT_MS,
  SYNC_VIEW_SETTLE_MS,
  createSyncViewBuffer,
} from "./sync-view";

const row = (id: string): Message => ({ id }) as Message;
const ids = (rows: Message[]) => rows.map((m) => m.id);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sync view buffer", () => {
  it("hands a burst over once, after the frames go quiet", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.add("room-a", [row("1"), row("2")]);
    vi.advanceTimersByTime(SYNC_VIEW_SETTLE_MS - 50);
    buf.add("room-a", [row("3")]);
    vi.advanceTimersByTime(SYNC_VIEW_SETTLE_MS - 50);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ids(flush.mock.calls[0][1])).toEqual(["1", "2", "3"]);
    expect(buf.pending("room-a")).toBe(0);
  });

  it("does not wait forever on a push that never pauses", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    let n = 0;
    // A frame every 100ms keeps resetting the settle timer.
    for (let t = 0; t < SYNC_VIEW_MAX_WAIT_MS; t += 100) {
      buf.add("room-a", [row(String(++n))]);
      vi.advanceTimersByTime(100);
    }
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][1]).toHaveLength(SYNC_VIEW_MAX_WAIT_MS / 100);
  });

  it("flushes immediately when the pusher says it is done", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.add("room-a", [row("1")]);
    buf.settle("room-a");
    expect(flush).toHaveBeenCalledTimes(1);
    // Nothing left to fire later.
    vi.advanceTimersByTime(SYNC_VIEW_MAX_WAIT_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("settling a room with nothing parked is a no-op", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.settle("room-a");
    expect(flush).not.toHaveBeenCalled();
  });

  it("parks each row once, however many peers push it", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.add("room-a", [row("1"), row("2")]);
    buf.add("room-a", [row("2"), row("3")]);
    buf.settle("room-a");
    expect(ids(flush.mock.calls[0][1])).toEqual(["1", "2", "3"]);
  });

  it("keeps rooms apart", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.add("room-a", [row("a1")]);
    buf.add("room-b", [row("b1")]);
    buf.settle("room-a");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toBe("room-a");
    expect(buf.pending("room-b")).toBe(1);
    vi.advanceTimersByTime(SYNC_VIEW_SETTLE_MS);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0]).toBe("room-b");
  });

  it("dropping a room forgets its rows without flushing", () => {
    const flush = vi.fn();
    const buf = createSyncViewBuffer(flush);
    buf.add("room-a", [row("1")]);
    buf.drop("room-a");
    vi.advanceTimersByTime(SYNC_VIEW_MAX_WAIT_MS * 2);
    expect(flush).not.toHaveBeenCalled();
    expect(buf.pending("room-a")).toBe(0);
  });
});
