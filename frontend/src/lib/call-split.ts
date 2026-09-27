/**
 * Where the line between the call and the chat sits, while it is dragged.
 *
 * Pure: the stage and ChatView own the pointer and the pixels, this only
 * answers "the finger is here - where does the line go". Two rules:
 *
 * - Clamped. The call keeps one row of tiles and its controls, the chat
 *   keeps its composer and a few messages, however far the drag goes.
 * - Magnetic. Near one of the default sizes the line sticks to it, so the
 *   layout the app picks on its own is always easy to land back on - and
 *   releasing on the automatic size hands sizing back to the app.
 */

/** How close, in pixels, the line has to come before a default catches it. */
export const SNAP_PX = 20;

export interface SplitBounds {
  min: number;
  max: number;
  /** Sizes the line sticks to, in pixels. Out-of-bounds ones are ignored. */
  snaps: readonly number[];
  snapPx?: number;
}

export interface SplitPosition {
  px: number;
  /** The snap the line is stuck to, or null while it moves freely. */
  snap: number | null;
}

export function resolveSplit(raw: number, bounds: SplitBounds): SplitPosition {
  // A window too small for both minimums: the call's minimum wins, since a
  // call squeezed below one tile row shows nothing useful at all.
  const max = Math.max(bounds.min, bounds.max);
  const px = Math.min(max, Math.max(bounds.min, raw));
  const reach = bounds.snapPx ?? SNAP_PX;
  let snap: number | null = null;
  for (const s of bounds.snaps) {
    if (s < bounds.min || s > max) continue;
    if (Math.abs(px - s) <= reach && (snap === null || Math.abs(px - s) < Math.abs(px - snap))) {
      snap = s;
    }
  }
  return { px: snap ?? px, snap };
}

/** A stored size, or null (automatic) for anything that is not a share. */
export function parseFraction(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}
