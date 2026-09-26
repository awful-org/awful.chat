import { describe, expect, it } from "vitest";
import {
  MAX_DRAG,
  REPLY_THRESHOLD,
  SIDEBAR_THRESHOLD,
  dragOffset,
  swipeAction,
} from "./swipe";

describe("swipeAction", () => {
  it("replies once the finger has travelled the threshold left", () => {
    expect(swipeAction(-(REPLY_THRESHOLD - 1))).toBeNull();
    expect(swipeAction(-REPLY_THRESHOLD)).toBe("reply");
    // A long swipe still replies - the old damped check read ~0 out here.
    expect(swipeAction(-400)).toBe("reply");
  });

  it("opens the sidebar once the finger has travelled the threshold right", () => {
    expect(swipeAction(SIDEBAR_THRESHOLD - 1)).toBeNull();
    expect(swipeAction(SIDEBAR_THRESHOLD)).toBe("sidebar");
  });
});

describe("dragOffset", () => {
  it("follows the finger near rest and keeps its direction", () => {
    expect(dragOffset(0)).toBe(0);
    expect(dragOffset(-10)).toBeLessThan(0);
    expect(Math.abs(dragOffset(-10))).toBeGreaterThan(8);
  });

  it("only ever grows, and never passes the cap", () => {
    let prev = 0;
    for (let x = 1; x <= 600; x += 10) {
      const d = Math.abs(dragOffset(-x));
      expect(d).toBeGreaterThan(prev);
      expect(d).toBeLessThan(MAX_DRAG);
      prev = d;
    }
  });
});
