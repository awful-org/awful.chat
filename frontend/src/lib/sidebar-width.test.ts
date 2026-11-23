import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_STEP_PX,
  SIDEBAR_COLLAPSED_PX,
  SIDEBAR_COLLAPSE_AT_PX,
  clampSidebarWidth,
  collapsedSidebarKey,
  parseSidebarWidth,
  sidebarDragCommit,
  sidebarDragState,
  sidebarMaxWidth,
  sidebarWidthForKey,
  storedSidebarWidth,
} from "./sidebar-width";

describe("SIDEBAR_COLLAPSE_AT_PX", () => {
  it("is halfway between the rail and the minimum width", () => {
    expect(SIDEBAR_COLLAPSE_AT_PX).toBe(164);
    expect(SIDEBAR_MIN_PX - SIDEBAR_COLLAPSE_AT_PX).toBe(108);
    expect(SIDEBAR_COLLAPSE_AT_PX - SIDEBAR_COLLAPSED_PX).toBe(108);
  });
});

describe("sidebarDragState", () => {
  it("follows the pointer while the sidebar is open", () => {
    expect(sidebarDragState(false, 300, 40, 1920)).toEqual({ collapsed: false, width: 340 });
    expect(sidebarDragState(false, 300, -20, 1920)).toEqual({ collapsed: false, width: 280 });
  });

  it("stops at the minimum, and stays open, short of the line", () => {
    expect(sidebarDragState(false, 300, -60, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MIN_PX,
    });
    // From the minimum: 108px further left is exactly on the line, still open.
    expect(sidebarDragState(false, SIDEBAR_MIN_PX, -108, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MIN_PX,
    });
  });

  it("collapses once the edge is past the line", () => {
    expect(sidebarDragState(false, SIDEBAR_MIN_PX, -109, 1920)).toEqual({ collapsed: true });
    expect(sidebarDragState(false, 400, -300, 1920)).toEqual({ collapsed: true });
    // Out past the window's left edge.
    expect(sidebarDragState(false, 400, -2000, 1920)).toEqual({ collapsed: true });
  });

  it("measures the line from where the edge is, not from where the drag began", () => {
    // A wide sidebar travels further before it folds: 400 - 164 = 236px.
    expect(sidebarDragState(false, 400, -236, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MIN_PX,
    });
    expect(sidebarDragState(false, 400, -237, 1920)).toEqual({ collapsed: true });
  });

  it("opens again when the same drag comes back across the line", () => {
    expect(sidebarDragState(false, 400, -250, 1920)).toEqual({ collapsed: true });
    expect(sidebarDragState(false, 400, -200, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MIN_PX,
    });
    expect(sidebarDragState(false, 400, -50, 1920)).toEqual({ collapsed: false, width: 350 });
  });

  it("keeps a collapsed sidebar on the rail for a click or a small drag", () => {
    expect(sidebarDragState(true, 400, 0, 1920)).toEqual({ collapsed: true });
    expect(sidebarDragState(true, 400, 20, 1920)).toEqual({ collapsed: true });
    expect(sidebarDragState(true, 400, -40, 1920)).toEqual({ collapsed: true });
    // 56 + 107 = 163: one short of the line.
    expect(sidebarDragState(true, 400, 107, 1920)).toEqual({ collapsed: true });
  });

  it("opens a collapsed sidebar at the minimum past the line, then follows the pointer", () => {
    expect(sidebarDragState(true, 400, 108, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MIN_PX,
    });
    expect(sidebarDragState(true, 400, 300, 1920)).toEqual({ collapsed: false, width: 356 });
    // The saved width is not where it opens: the edge is.
    expect(sidebarDragState(true, 400, 1000, 1920)).toEqual({
      collapsed: false,
      width: SIDEBAR_MAX_PX,
    });
  });

  it("clamps the open width to this window", () => {
    expect(sidebarDragState(false, 300, 500, 1000)).toEqual({ collapsed: false, width: 400 });
  });

  it("stays where it started for a pointer position that is not a number", () => {
    expect(sidebarDragState(false, 300, Number.NaN, 1920)).toEqual({
      collapsed: false,
      width: 300,
    });
    expect(sidebarDragState(true, 300, Number.NaN, 1920)).toEqual({ collapsed: true });
  });
});

describe("sidebarDragCommit", () => {
  it("saves nothing for a press that never moved", () => {
    expect(sidebarDragCommit(false, null)).toEqual({});
    expect(sidebarDragCommit(true, null)).toEqual({});
  });

  it("saves the width an open drag ends at", () => {
    expect(sidebarDragCommit(false, { collapsed: false, width: 340 })).toEqual({ width: 340 });
  });

  it("saves only the collapse, never the minimum the drag passed through", () => {
    expect(sidebarDragCommit(false, { collapsed: true })).toEqual({ collapsed: true });
  });

  it("saves nothing when a collapsed sidebar is left collapsed", () => {
    expect(sidebarDragCommit(true, { collapsed: true })).toEqual({});
  });

  it("saves the expand and the width when a collapsed sidebar is dragged open", () => {
    expect(sidebarDragCommit(true, { collapsed: false, width: 300 })).toEqual({
      collapsed: false,
      width: 300,
    });
  });
});

describe("collapsedSidebarKey", () => {
  it("expands with Right arrow and Enter", () => {
    expect(collapsedSidebarKey("ArrowRight")).toBe("expand");
    expect(collapsedSidebarKey("Enter")).toBe("expand");
  });

  it("ignores every other key", () => {
    expect(collapsedSidebarKey("ArrowLeft")).toBeNull();
    expect(collapsedSidebarKey("Home")).toBeNull();
    expect(collapsedSidebarKey("End")).toBeNull();
    expect(collapsedSidebarKey(" ")).toBeNull();
  });
});

describe("sidebarWidthForKey never collapses", () => {
  it("holds Left arrow at the minimum", () => {
    let w = 400;
    for (let i = 0; i < 50; i++) {
      const next = sidebarWidthForKey("ArrowLeft", w, 1920);
      expect(typeof next).toBe("number");
      w = next as number;
    }
    expect(w).toBe(SIDEBAR_MIN_PX);
  });
});

describe("sidebarMaxWidth", () => {
  it("is 480px in a wide window", () => {
    expect(sidebarMaxWidth(1920)).toBe(SIDEBAR_MAX_PX);
  });

  it("is 40% of a window too narrow for 480px", () => {
    expect(sidebarMaxWidth(1000)).toBe(400);
  });

  it("never falls below the minimum, so a small window has no range at all", () => {
    expect(sidebarMaxWidth(640)).toBe(SIDEBAR_MIN_PX);
    expect(sidebarMaxWidth(0)).toBe(SIDEBAR_MIN_PX);
    expect(sidebarMaxWidth(Number.NaN)).toBe(SIDEBAR_MIN_PX);
  });
});

describe("clampSidebarWidth", () => {
  it("passes a width inside the range through", () => {
    expect(clampSidebarWidth(360, 1920)).toBe(360);
  });

  it("keeps the sidebar at least as wide as it always was", () => {
    expect(clampSidebarWidth(100, 1920)).toBe(SIDEBAR_MIN_PX);
  });

  it("re-clamps a width saved on a big screen to a small window", () => {
    expect(clampSidebarWidth(480, 1000)).toBe(400);
    expect(clampSidebarWidth(480, 700)).toBe(280);
  });

  it("rounds to whole pixels", () => {
    expect(clampSidebarWidth(300.6, 1920)).toBe(301);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampSidebarWidth(Number.NaN, 1920)).toBe(SIDEBAR_DEFAULT_PX);
  });
});

describe("sidebarWidthForKey", () => {
  it("steps the edge the way the arrow points", () => {
    expect(sidebarWidthForKey("ArrowRight", 300, 1920)).toBe(300 + SIDEBAR_STEP_PX);
    expect(sidebarWidthForKey("ArrowLeft", 300, 1920)).toBe(300 - SIDEBAR_STEP_PX);
  });

  it("does not step past either end", () => {
    expect(sidebarWidthForKey("ArrowLeft", SIDEBAR_MIN_PX, 1920)).toBe(SIDEBAR_MIN_PX);
    expect(sidebarWidthForKey("ArrowRight", 470, 1920)).toBe(SIDEBAR_MAX_PX);
    expect(sidebarWidthForKey("ArrowRight", 400, 1000)).toBe(400);
  });

  it("goes to the ends of this window's range with Home and End", () => {
    expect(sidebarWidthForKey("Home", 400, 1920)).toBe(SIDEBAR_MIN_PX);
    expect(sidebarWidthForKey("End", 300, 1920)).toBe(SIDEBAR_MAX_PX);
    expect(sidebarWidthForKey("End", 300, 1000)).toBe(400);
  });

  it("resets with Enter", () => {
    expect(sidebarWidthForKey("Enter", 400, 1920)).toBe("default");
  });

  it("ignores other keys", () => {
    expect(sidebarWidthForKey("ArrowUp", 300, 1920)).toBeNull();
    expect(sidebarWidthForKey("a", 300, 1920)).toBeNull();
  });
});

describe("parseSidebarWidth", () => {
  it("reads a stored width", () => {
    expect(parseSidebarWidth("360")).toBe(360);
    expect(parseSidebarWidth("360.4")).toBe(360);
  });

  it("is null (the default) when nothing is stored", () => {
    expect(parseSidebarWidth(null)).toBeNull();
    expect(parseSidebarWidth("")).toBeNull();
    expect(parseSidebarWidth("  ")).toBeNull();
  });

  it("rejects what the app could not have saved", () => {
    expect(parseSidebarWidth("wide")).toBeNull();
    expect(parseSidebarWidth("NaN")).toBeNull();
    expect(parseSidebarWidth("Infinity")).toBeNull();
    expect(parseSidebarWidth("100")).toBeNull();
    expect(parseSidebarWidth("4000")).toBeNull();
    expect(parseSidebarWidth("-300")).toBeNull();
  });

  it("accepts both ends of the range", () => {
    expect(parseSidebarWidth(String(SIDEBAR_MIN_PX))).toBe(SIDEBAR_MIN_PX);
    expect(parseSidebarWidth(String(SIDEBAR_MAX_PX))).toBe(SIDEBAR_MAX_PX);
  });
});

describe("storedSidebarWidth", () => {
  it("stores a dragged width", () => {
    expect(storedSidebarWidth(360)).toBe("360");
  });

  it("stores nothing for the default, so a reset leaves no key behind", () => {
    expect(storedSidebarWidth(null)).toBeNull();
    expect(storedSidebarWidth(SIDEBAR_DEFAULT_PX)).toBeNull();
  });

  it("stores nothing for a width outside the range", () => {
    expect(storedSidebarWidth(9999)).toBeNull();
  });

  it("round-trips through parseSidebarWidth", () => {
    expect(parseSidebarWidth(storedSidebarWidth(400))).toBe(400);
  });
});
