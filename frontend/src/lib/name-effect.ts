/**
 * Name effect utilities for applying text effects to user nicknames.
 * CSS-only animations, respecting prefers-reduced-motion.
 */

export type NameEffect = "none" | "gradient" | "shimmer" | "glow" | "rainbow";

/**
 * Generate class and inline style for a name effect.
 * Returns an object with `class` and `style` properties.
 */
export function nameEffectStyle(
  effect: string | undefined,
  color: string | undefined,
  gradient2?: string,
  gradient3?: string
): { class: string; style: string } {
  if (!effect || effect === "none") {
    return { class: "", style: "" };
  }
  // Rainbow supplies its own colors; the rest are built from the nickname
  // color and are meaningless without one.
  if (!color && effect !== "rainbow") {
    return { class: "", style: "" };
  }

  const baseClass = "name-effect";

  switch (effect) {
    case "gradient": {
      // User-picked stops when set; a derived lighter complement otherwise,
      // so a gradient with no second color still renders something.
      const stops = [
        color,
        // The early return above guarantees color for non-rainbow effects.
        gradient2 || lightenColor(color!),
        ...(gradient3 ? [gradient3] : []),
      ].join(", ");
      return {
        class: `${baseClass} name-effect-gradient`,
        style: `background: linear-gradient(90deg, ${stops}); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;`,
      };
    }

    case "shimmer": {
      // Animated gradient sweep
      return {
        class: `${baseClass} name-effect-shimmer`,
        // steps(): background-position and text-shadow animations PAINT on
        // every frame and cannot be GPU-composited - a handful of animated
        // names idled the whole tab at several % CPU. Stepped timing keeps
        // the look at ~15fps for a fraction of the paint work.
        style: `background: linear-gradient(90deg, ${color}, rgba(255,255,255,0.3), ${color}); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: shimmer 3.5s steps(50) infinite;`,
      };
    }

    case "glow": {
      // Text-shadow pulse in the nickname color
      return {
        class: `${baseClass} name-effect-glow`,
        style: `color: ${color}; text-shadow: 0 0 8px ${color}; animation: glow 2s steps(24) infinite;`,
      };
    }

    case "rainbow": {
      // hue-rotate needs a SATURATED base: rotating the default near-gray
      // text color produces the same gray, which is why this effect looked
      // dead. A multi-stop gradient clipped to the text, spun by hue-rotate
      // (360deg = identity, so the loop is seamless). Under reduced motion
      // the animation stops and the static gradient remains.
      return {
        class: `${baseClass} name-effect-rainbow`,
        style:
          "background: linear-gradient(90deg,#ff5959,#ffb545,#ffe234,#5be35b,#4fc3ff,#b06aff,#ff5959); " +
          "-webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; " +
          "animation: rainbow 3s linear infinite;",
      };
    }

    default:
      return { class: "", style: "" };
  }
}

/**
 * Generate a lighter/complementary color from a hex color.
 * Simple approach: desaturate and brighten.
 */
function lightenColor(hex: string): string {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Lighten by averaging with white and boosting saturation
  const lr = Math.min(255, Math.floor(r * 0.7 + 255 * 0.3));
  const lg = Math.min(255, Math.floor(g * 0.7 + 255 * 0.3));
  const lb = Math.min(255, Math.floor(b * 0.7 + 255 * 0.3));

  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}
