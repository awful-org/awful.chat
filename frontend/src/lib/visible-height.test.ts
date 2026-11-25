import { afterEach, describe, expect, it, vi } from "vitest";
import { pageZoom, visibleHeight } from "./visible-height";

function page(layout: [number, number], visual: [number, number] | null) {
  vi.stubGlobal("window", {
    innerHeight: layout[1],
    visualViewport: visual ? { width: visual[0], height: visual[1] } : undefined,
  });
  vi.stubGlobal("document", { documentElement: { clientWidth: layout[0] } });
}

describe("visibleHeight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the window's, with nothing in the way", () => {
    page([412, 800], [412, 800]);
    expect(visibleHeight()).toBe(800);
    page([412, 800], null);
    expect(visibleHeight()).toBe(800);
  });

  it("shrinks for a keyboard", () => {
    page([412, 800], [412, 480]);
    expect(visibleHeight()).toBe(480);
  });

  it("does not shrink for zoom", () => {
    page([980, 1900], [980 / 1.5, 1900 / 1.5]);
    expect(visibleHeight()).toBeCloseTo(1900);
    expect(pageZoom()).toBeCloseTo(1.5);
  });

  it("shrinks for a keyboard alone when zoomed as well", () => {
    page([412, 800], [206, 240]);
    expect(visibleHeight()).toBeCloseTo(480);
  });

  it("holds for a page zoomed out past its layout", () => {
    page([412, 800], [824, 1600]);
    expect(visibleHeight()).toBeCloseTo(800);
  });

  it("takes rounding for no zoom, and nonsense for none either", () => {
    page([412, 800], [411.43, 799.5]);
    expect(visibleHeight()).toBe(799.5);
    page([0, 800], [0, 700]);
    expect(visibleHeight()).toBe(700);
  });
});
