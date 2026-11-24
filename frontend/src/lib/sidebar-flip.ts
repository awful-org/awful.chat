import { flip, type AnimationConfig, type FlipParams } from "svelte/animate";

/**
 * svelte's flip, moving an element and never scaling it. A voice channel's
 * row holds the people in its call, so it grows and shrinks as they come and
 * go, and flip plays a size change as a scale: the row was drawn squashed to
 * its old height, name and pictures with it, each time somebody joined.
 */
export function slideFlip(
  node: Element,
  { from, to }: { from: DOMRect; to: DOMRect },
  params: FlipParams = {}
): AnimationConfig {
  // Grown or shrunk in place: nothing moved, so nothing plays.
  if (from.left === to.left && from.top === to.top) return { duration: 0 };
  return flip(node, { from: new DOMRect(from.left, from.top, to.width, to.height), to }, params);
}
