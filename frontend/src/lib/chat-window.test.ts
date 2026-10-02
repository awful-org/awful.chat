import { describe, expect, it } from "vitest";
import {
  FOLLOW_ROWS,
  HOLD_ROWS,
  MAX_ROWS,
  STEP_ROWS,
  TRIM_AT,
  around,
  hold,
  showNewer,
  showOlder,
  trimPoint,
  windowRange,
  type ChatWindow,
} from "./chat-window";

function rows(count: number, first = 1) {
  return Array.from({ length: count }, (_, i) => ({
    lamport: first + i,
    id: `m${String(first + i).padStart(6, "0")}`,
  }));
}

const size = (r: { from: number; to: number }) => r.to - r.from;

describe("chat window", () => {
  it("follows the newest rows, mounting at most FOLLOW_ROWS", () => {
    expect(windowRange(rows(30), null)).toEqual({ from: 0, to: 30 });
    expect(windowRange(rows(500), null)).toEqual({ from: 400, to: 500 });
    expect(windowRange([], null)).toEqual({ from: 0, to: 0 });
  });

  // The catch-up flush: a room open on its newest page, then one push round.
  it("mounts no more than FOLLOW_ROWS when 640 rows land at once", () => {
    const open = rows(50);
    expect(size(windowRange(open, null))).toBe(50);
    const caughtUp = [...open, ...rows(640, 51)];
    const r = windowRange(caughtUp, null);
    expect(size(r)).toBe(FOLLOW_ROWS);
    expect(r.to).toBe(caughtUp.length);
  });

  it("holds still while the reader is up in history, however much arrives", () => {
    let list = rows(150);
    const window = hold(list, windowRange(list, null));
    expect(windowRange(list, window)).toEqual({ from: 50, to: 150 });
    list = [...list, ...rows(20, 151)];
    // Below the reader, in view of nobody: mounted until the window is full.
    expect(windowRange(list, window)).toEqual({ from: 50, to: 170 });
    list = [...list, ...rows(500, 171)];
    expect(windowRange(list, window)).toEqual({ from: 50, to: 50 + MAX_ROWS });
  });

  it("grows a page toward older rows, dropping the newest past MAX_ROWS", () => {
    const list = rows(1000);
    let window: ChatWindow = null;
    let r = windowRange(list, window);
    window = showOlder(list, r);
    r = windowRange(list, window);
    expect(r).toEqual({ from: 1000 - FOLLOW_ROWS - STEP_ROWS, to: 1000 });
    window = showOlder(list, r);
    window = showOlder(list, windowRange(list, window));
    r = windowRange(list, window);
    expect(r.from).toBe(1000 - FOLLOW_ROWS - 3 * STEP_ROWS);
    expect(size(r)).toBe(MAX_ROWS);
    expect(window!.end).not.toBeNull();
  });

  it("grows a page toward newer rows the same way, and lets go of the end at the newest", () => {
    const list = rows(1000);
    let window = around(list, 100);
    let r = windowRange(list, window);
    for (let i = 0; i < 30 && r.to < list.length; i++) {
      window = showNewer(list, r);
      r = windowRange(list, window);
      expect(size(r)).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(r.to).toBe(list.length);
    expect(window!.end).toBeNull();
  });

  it("stays bounded through a long scroll back and forth", () => {
    let list = rows(3000);
    let window: ChatWindow = null;
    for (let i = 0; i < 80; i++) {
      window = showOlder(list, windowRange(list, window));
      if (i % 7 === 0) list = [...list, ...rows(3, list.length + 1)];
      expect(size(windowRange(list, window))).toBeLessThanOrEqual(MAX_ROWS);
    }
    for (let i = 0; i < 80; i++) {
      window = showNewer(list, windowRange(list, window));
      expect(size(windowRange(list, window))).toBeLessThanOrEqual(MAX_ROWS);
    }
  });

  // revealMessage used to leave everything between a jump target and the
  // present mounted: up to 2,000 rows, one page at a time.
  it("puts a jump target in a window of FOLLOW_ROWS around it", () => {
    const list = rows(2050);
    for (const index of [0, 10, 900, 2000, 2049]) {
      const r = windowRange(list, around(list, index));
      expect(index).toBeGreaterThanOrEqual(r.from);
      expect(index).toBeLessThan(r.to);
      expect(size(r)).toBe(FOLLOW_ROWS);
    }
    expect(windowRange(rows(30), around(rows(30), 5))).toEqual({ from: 0, to: 30 });
  });

  it("keeps its place when the rows it starts at are dropped, or more land inside it", () => {
    const list = rows(300);
    const window = hold(list, { from: 100, to: 200 });
    // The rows it started at trimmed away: it starts at the next one.
    expect(windowRange(list.slice(150), window)).toEqual({ from: 0, to: 50 });
    // A backfilled row inside it: still the same rows, one more of them.
    const withBackfill = [...list.slice(0, 150), { lamport: 150, id: "m000150b" }, ...list.slice(150)];
    expect(windowRange(withBackfill, window)).toEqual({ from: 100, to: 201 });
  });

  it("trims the held list only past TRIM_AT, never what following mounts", () => {
    expect(trimPoint(rows(TRIM_AT))).toBeNull();
    const list = rows(TRIM_AT + 1);
    const keepFrom = trimPoint(list)!;
    const kept = list.filter((row) => row.lamport >= keepFrom.lamport);
    expect(kept).toHaveLength(HOLD_ROWS);
    const mounted = windowRange(list, null);
    expect(list.slice(mounted.from, mounted.to).every((row) => kept.includes(row))).toBe(true);
  });

  // Replying to a message far back, then going back to the newest: the
  // trim took the message being replied to, its banner went, and the reply
  // went out as a plain message.
  it("keeps the message being replied to, and everything after it", () => {
    const list = rows(TRIM_AT + 100);
    const target = list[30];
    expect(trimPoint(list, target)).toEqual(target);
    // Newer than the cut anyway: the cut stays where it was.
    expect(trimPoint(list, list[list.length - 5])).toEqual(trimPoint(list));
    // At the oldest row held, nothing would go: no trim at all.
    expect(trimPoint(list, list[0])).toBeNull();
  });
});
