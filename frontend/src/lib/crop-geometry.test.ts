import { describe, it, expect } from "vitest";
import { coverScale, clampPan } from "./crop-geometry";
import type { CropView } from "./crop";

function view(partial: Partial<CropView>): CropView {
  return {
    natW: 100,
    natH: 100,
    frameW: 100,
    frameH: 100,
    scale: 1,
    panX: 0,
    panY: 0,
    angleDeg: 0,
    ...partial,
  };
}

describe("coverScale", () => {
  it("matches the plain cover ratio at angle 0", () => {
    // A wide frame over a square image is bound by the width ratio.
    expect(coverScale(100, 100, 50, 25, 0)).toBe(0.5);
    // A tall frame over a wide image is bound by the height ratio.
    expect(coverScale(200, 100, 50, 80, 0)).toBeCloseTo(0.8, 10);
  });

  it("is unchanged by a 90 degree turn of a square frame", () => {
    // A square frame over a square image needs the same scale at 0 and 90.
    expect(coverScale(100, 100, 80, 80, 90)).toBeCloseTo(0.8, 10);
  });

  it("needs a larger scale at 45 degrees", () => {
    const at0 = coverScale(100, 100, 100, 100, 0);
    const at45 = coverScale(100, 100, 100, 100, 45);
    expect(at0).toBe(1);
    // sqrt(2) more room is needed to keep the frame covered when turned 45.
    expect(at45).toBeCloseTo(Math.SQRT2, 6);
  });

  it("returns 1 for degenerate sizes", () => {
    expect(coverScale(0, 100, 50, 50, 0)).toBe(1);
  });
});

describe("clampPan", () => {
  it("keeps a larger image from uncovering the frame", () => {
    // scale 2, square: half-image 100, frame half-extent 50 -> pan range +-50.
    expect(clampPan(view({ scale: 2, panX: 10, panY: -20 }))).toEqual({
      panX: 10,
      panY: -20,
    });
    const clamped = clampPan(view({ scale: 2, panX: 999, panY: -999 }));
    expect(clamped.panX).toBeCloseTo(50, 6);
    expect(clamped.panY).toBeCloseTo(-50, 6);
  });

  it("pins the pan to zero at the cover scale", () => {
    // At exactly cover scale there is no slack in either axis.
    const s = coverScale(100, 100, 100, 100, 0); // 1
    const clamped = clampPan(view({ scale: s, panX: 40, panY: 40 }));
    expect(clamped.panX).toBeCloseTo(0, 6);
    expect(clamped.panY).toBeCloseTo(0, 6);
  });

  it("clamps along the rotated image axes", () => {
    // Turned 90 degrees, an over-large pan still lands inside the covered box.
    const v = view({ scale: 2, angleDeg: 90, panX: 999, panY: 999 });
    const clamped = clampPan(v);
    // Map back into image axes; both components must sit within the +-50 range.
    const r = (v.angleDeg * Math.PI) / 180;
    const dx = Math.cos(r) * clamped.panX + Math.sin(r) * clamped.panY;
    const dy = -Math.sin(r) * clamped.panX + Math.cos(r) * clamped.panY;
    expect(Math.abs(dx)).toBeLessThanOrEqual(50 + 1e-6);
    expect(Math.abs(dy)).toBeLessThanOrEqual(50 + 1e-6);
  });
});
