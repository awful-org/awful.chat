import { describe, expect, it } from "vitest";
import { SNAP_PX, parseFraction, resolveSplit } from "./call-split";

const bounds = { min: 200, max: 700, snaps: [350, 450] };

describe("resolveSplit", () => {
  it("follows the finger between the snaps", () => {
    expect(resolveSplit(400, bounds)).toEqual({ px: 400, snap: null });
  });

  it("sticks to a default within reach, from either side", () => {
    expect(resolveSplit(350 + SNAP_PX, bounds)).toEqual({ px: 350, snap: 350 });
    expect(resolveSplit(350 - SNAP_PX + 1, bounds)).toEqual({ px: 350, snap: 350 });
    expect(resolveSplit(350 + SNAP_PX + 1, bounds).snap).toBeNull();
  });

  it("picks the nearer default when two are in reach", () => {
    const close = { min: 0, max: 1000, snaps: [100, 130] };
    expect(resolveSplit(120, close).snap).toBe(130);
    expect(resolveSplit(110, close).snap).toBe(100);
  });

  it("keeps both sides usable however far the drag goes", () => {
    expect(resolveSplit(50, bounds).px).toBe(200);
    expect(resolveSplit(5000, bounds).px).toBe(700);
  });

  it("ignores a default the bounds cannot reach", () => {
    expect(resolveSplit(690, { ...bounds, snaps: [720] })).toEqual({ px: 690, snap: null });
  });

  it("gives the call its minimum when the window fits neither side", () => {
    expect(resolveSplit(100, { min: 200, max: 150, snaps: [] }).px).toBe(200);
  });
});

describe("parseFraction", () => {
  it("reads a stored share", () => {
    expect(parseFraction("0.42")).toBe(0.42);
  });

  it("treats anything else as automatic", () => {
    for (const raw of [null, "", "0", "1", "-0.3", "1.5", "abc", "NaN"]) {
      expect(parseFraction(raw)).toBeNull();
    }
  });
});
