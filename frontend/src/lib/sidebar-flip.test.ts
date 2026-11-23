import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slideFlip } from "./sidebar-flip";

class Rect {
  constructor(public left: number, public top: number, public width: number, public height: number) {}
  get right() { return this.left + this.width; }
  get bottom() { return this.top + this.height; }
}
const rect = (top: number, height: number) => new Rect(0, top, 190, height) as unknown as DOMRect;
const node = (height: number) => ({ clientWidth: 190, clientHeight: height, currentCSSZoom: 1 }) as unknown as Element;

beforeEach(() => {
  vi.stubGlobal("DOMRect", Rect);
  vi.stubGlobal("getComputedStyle", () => ({ transform: "none", transformOrigin: "95px 35px" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("slideFlip", () => {
  it("plays nothing for a row that only grew", () => {
    expect(slideFlip(node(70), { from: rect(10, 32), to: rect(10, 70) }, { duration: 180 }).duration).toBe(0);
  });

  it("slides a row that moved", () => {
    const config = slideFlip(node(32), { from: rect(50, 32), to: rect(88, 32) }, { duration: 180 });
    expect(config.duration).toBe(180);
    expect(config.css!(0, 1)).toContain("translate(0px, -38px) scale(1, 1)");
  });

  it("slides a row that moved and grew from where its top was, unscaled", () => {
    const config = slideFlip(node(70), { from: rect(50, 32), to: rect(88, 70) }, { duration: 180 });
    expect(config.css!(0, 1)).toContain("translate(0px, -38px) scale(1, 1)");
  });
});
