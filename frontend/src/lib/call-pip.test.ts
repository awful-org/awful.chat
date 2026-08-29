import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BAR_HEIGHT,
  HEIGHT,
  WIDTH,
  callPipPanel,
  clampPanelToViewport,
  defaultPanelPosition,
  panelWidth,
} from "./call-pip.svelte";

// This suite runs in node (vitest.config.ts sets environment: "node") and the
// project has no jsdom, so a minimal global stands in for the viewport. The
// module only reads innerWidth/innerHeight behind a typeof guard.
const setViewport = (w: number, h: number) => {
  (globalThis as { window?: unknown }).window = {
    innerWidth: w,
    innerHeight: h,
  };
};

beforeEach(() => {
  setViewport(1920, 1080);
  callPipPanel.minimized = false;
});
afterEach(() => {
  callPipPanel.minimized = false;
  delete (globalThis as { window?: unknown }).window;
});

describe("default position", () => {
  // It used the DM panel's own bottom-right formula, so the call panel opened
  // nested inside the DM panel - the collision the other corner exists to avoid.
  it("opens on the left, not on top of the DM panel", () => {
    const pos = defaultPanelPosition();
    expect(pos.x).toBeLessThan(1920 / 2);
    expect(pos.x + WIDTH).toBeLessThan(1920 - WIDTH);
  });

  it("keeps the whole panel on screen", () => {
    const pos = defaultPanelPosition();
    expect(pos.y + HEIGHT + BAR_HEIGHT).toBeLessThanOrEqual(1080);
  });
});

describe("width", () => {
  it("is the full width on a desktop viewport", () => {
    expect(panelWidth()).toBe(WIDTH);
  });

  // The spec narrows the panel on a small screen. The clamp has to use the
  // same number the component renders, or the panel gets a strip of screen it
  // can never be dragged into.
  it("narrows on a phone, and the clamp agrees with it", () => {
    setViewport(400, 800);
    expect(panelWidth()).toBeLessThan(WIDTH);
    callPipPanel.x = 9999;
    clampPanelToViewport();
    expect(callPipPanel.x + panelWidth()).toBeLessThanOrEqual(400);
  });
});

describe("clamping on resize", () => {
  it("keeps the body on screen, not just the bar", () => {
    callPipPanel.x = 100;
    callPipPanel.y = 900;
    setViewport(1920, 700);
    clampPanelToViewport();
    expect(callPipPanel.y + HEIGHT + BAR_HEIGHT).toBeLessThanOrEqual(700);
  });

  it("only reserves the bar when minimized", () => {
    callPipPanel.minimized = true;
    callPipPanel.x = 100;
    callPipPanel.y = 900;
    setViewport(1920, 700);
    clampPanelToViewport();
    expect(callPipPanel.y + BAR_HEIGHT).toBeLessThanOrEqual(700);
    expect(callPipPanel.y).toBeGreaterThan(700 - BAR_HEIGHT - 40);
  });

  it("never pushes the panel off the left or top", () => {
    callPipPanel.x = -500;
    callPipPanel.y = -500;
    clampPanelToViewport();
    expect(callPipPanel.x).toBeGreaterThanOrEqual(0);
    expect(callPipPanel.y).toBeGreaterThanOrEqual(0);
  });
});
