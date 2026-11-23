import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_KEPT_FRAMES,
  MAX_KEPT_SIDE,
  forgetStillFrames,
  keepStillFrame,
  keptStillFrame,
} from "./still-frames";

const canvas = (width: number, height = width) => ({ width, height }) as HTMLCanvasElement;
const copy = (c: HTMLCanvasElement) => ({ ...c }) as HTMLCanvasElement;
const keep = (src: string, c: HTMLCanvasElement) => keepStillFrame(src, c, copy);

beforeEach(forgetStillFrames);

describe("still frames kept for the next place a picture shows", () => {
  it("gives back a copy, not the canvas on the page", () => {
    const shown = canvas(28);
    keep("a", shown);
    expect(keptStillFrame("a")).toEqual(shown);
    expect(keptStillFrame("a")).not.toBe(shown);
    expect(keptStillFrame("b")).toBeUndefined();
  });

  it("keeps the sharpest drawn of a picture", () => {
    keep("a", canvas(56));
    keep("a", canvas(28));
    expect(keptStillFrame("a")?.width).toBe(56);
    keep("a", canvas(84));
    expect(keptStillFrame("a")?.width).toBe(84);
  });

  it("keeps no large frame, and none of nothing", () => {
    keep("wide", canvas(MAX_KEPT_SIDE + 1, 10));
    keep("tall", canvas(10, MAX_KEPT_SIDE + 1));
    keep("none", canvas(0));
    for (const src of ["wide", "tall", "none"]) expect(keptStillFrame(src)).toBeUndefined();
  });

  it("drops the one used longest ago past its bound", () => {
    for (let i = 0; i < MAX_KEPT_FRAMES; i++) keep(`p${i}`, canvas(28));
    keptStillFrame("p0");
    keep("new", canvas(28));
    expect(keptStillFrame("p0")).toBeDefined();
    expect(keptStillFrame("p1")).toBeUndefined();
  });

  it("forgets them all when the session ends", () => {
    keep("a", canvas(28));
    forgetStillFrames();
    expect(keptStillFrame("a")).toBeUndefined();
  });
});
