import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_STEP_PX,
  clampSidebarWidth,
  parseSidebarWidth,
  sidebarMaxWidth,
  sidebarWidthForKey,
  storedSidebarWidth,
} from "./sidebar-width";

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
