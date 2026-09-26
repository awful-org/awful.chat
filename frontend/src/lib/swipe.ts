/**
 * Mobile swipes in the chat: left on a message row to reply (the row
 * follows the finger), right anywhere in the message area to open the rooms
 * sidebar (nothing moves).
 *
 * Decisions use the RAW finger travel; only the drawing is damped. The old
 * code compared the damped offset against the threshold, and its curve
 * (x * (1 - (x/180)^1.2)) peaked near 51px and fell back to 0 by 180px - a
 * 60px reply threshold was unreachable, and a long swipe snapped back.
 */

/** Finger travel, in px, that commits a reply (leftward). */
export const REPLY_THRESHOLD = 60;
/** Finger travel, in px, that opens the rooms sidebar (rightward). */
export const SIDEBAR_THRESHOLD = 70;
/** The furthest a row is drawn from rest, however far the finger goes. */
export const MAX_DRAG = 72;

/**
 * Where to draw the row for a raw horizontal travel: one-to-one near rest,
 * easing toward MAX_DRAG, never past it and never back toward 0.
 */
export function dragOffset(raw: number): number {
  return Math.sign(raw) * MAX_DRAG * (1 - Math.exp(-Math.abs(raw) / MAX_DRAG));
}

export type SwipeAction = "reply" | "sidebar" | null;

/** What a swipe of this raw travel has committed to, if anything. */
export function swipeAction(raw: number): SwipeAction {
  if (raw <= -REPLY_THRESHOLD) return "reply";
  if (raw >= SIDEBAR_THRESHOLD) return "sidebar";
  return null;
}
