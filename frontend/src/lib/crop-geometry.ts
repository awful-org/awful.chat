/**
 * Pure geometry for the image cropper. The cropper shows the image behind a
 * fixed crop frame; the user pans, zooms, and rotates it. These helpers keep
 * the image large enough to cover the frame at any angle and keep the pan
 * inside the covered range.
 *
 * The transform is applied about the image center: a natural-image point p
 * (relative to the center) maps to the frame point
 *   center + pan + R(angle) * (scale * p).
 *
 * Kept DOM-free so the math is unit-testable.
 */
import type { CropView } from "./crop";

/**
 * The smallest scale at which the rotated image still covers the whole frame.
 *
 * Rotating the frame by -angle into the image axes, its half-extents grow to
 * Ux = (fw/2)|cos| + (fh/2)|sin| and Uy = (fw/2)|sin| + (fh/2)|cos|. The scaled
 * image half-size must reach each, so scale >= 2*Ux/natW and >= 2*Uy/natH.
 */
export function coverScale(
  natW: number,
  natH: number,
  frameW: number,
  frameH: number,
  angleDeg: number
): number {
  if (natW <= 0 || natH <= 0) return 1;
  const r = (angleDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const needX = (frameW * c + frameH * s) / natW;
  const needY = (frameW * s + frameH * c) / natH;
  return Math.max(needX, needY);
}

/**
 * Clamp the pan so the rotated, scaled image still covers the frame. Returns
 * the corrected pan; an already-valid pan is returned unchanged.
 */
export function clampPan(view: CropView): { panX: number; panY: number } {
  const { natW, natH, frameW, frameH, scale, angleDeg } = view;
  const r = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const c = Math.abs(cos);
  const s = Math.abs(sin);

  const ux = (frameW / 2) * c + (frameH / 2) * s;
  const uy = (frameW / 2) * s + (frameH / 2) * c;
  const maxDx = Math.max(0, (scale * natW) / 2 - ux);
  const maxDy = Math.max(0, (scale * natH) / 2 - uy);

  // Rotate the pan into image axes, clamp there, then rotate back.
  const dx = cos * view.panX + sin * view.panY;
  const dy = -sin * view.panX + cos * view.panY;
  const cdx = Math.min(maxDx, Math.max(-maxDx, dx));
  const cdy = Math.min(maxDy, Math.max(-maxDy, dy));

  return {
    panX: cos * cdx - sin * cdy,
    panY: sin * cdx + cos * cdy,
  };
}
