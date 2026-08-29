/**
 * Name effect utilities for applying text effects to user nicknames.
 * CSS-only animations, respecting prefers-reduced-motion.
 *
 * The model uses three independent axes:
 * - fill: "none" | "gradient" | "rainbow" (mutually exclusive - they share background-clip)
 * - shimmer: boolean (animated sweep over the fill)
 * - glow: boolean (independent text-shadow, composes with any fill)
 *
 * Wire format (backward compatible):
 * - nameEffect: "none" | "gradient" | "shimmer" | "glow" | "rainbow" (legacy single string)
 * - nameShimmer?: boolean (optional, new field)
 * - nameGlow?: boolean (optional, new field)
 */

export type NameEffect = "none" | "gradient" | "shimmer" | "glow" | "rainbow";
export type NameEffectFill = "none" | "gradient" | "rainbow";

export interface NameEffectModel {
  fill: NameEffectFill;
  shimmer: boolean;
  glow: boolean;
}

/**
 * Convert wire format to internal model.
 * Wire -> model (used by every renderer):
 * - Old clients sending only nameEffect get converted to the new model
 * - New clients sending nameShimmer/nameGlow enrich the model
 */
export function wireToModel(
  nameEffect: string | undefined,
  nameShimmer: boolean | undefined,
  nameGlow: boolean | undefined
): NameEffectModel {
  const fill: NameEffectFill =
    nameEffect === "rainbow"
      ? "rainbow"
      : nameEffect === "gradient" || nameEffect === "shimmer"
        ? "gradient"
        : "none";

  const shimmer = nameShimmer ?? (nameEffect === "shimmer");
  const glow = nameGlow ?? (nameEffect === "glow");

  return { fill, shimmer, glow };
}

/**
 * Convert internal model to wire format.
 * Model -> wire (used when saving):
 * - Always writes both nameEffect (for old clients) and the new booleans
 * - Ensures backward compatibility while supporting the new model
 */
export function modelToWire(model: NameEffectModel): {
  nameEffect: NameEffect;
  nameShimmer: boolean;
  nameGlow: boolean;
} {
  const nameEffect: NameEffect =
    model.fill === "rainbow"
      ? "rainbow"
      : model.fill === "gradient"
        ? model.shimmer
          ? "shimmer"
          : "gradient"
        : model.glow
          ? "glow"
          : "none";

  return {
    nameEffect,
    nameShimmer: model.shimmer,
    nameGlow: model.glow,
  };
}

/**
 * Generate class and inline style for a name effect.
 * Composes fill, shimmer, and glow effects together.
 * Returns an object with `class` and `style` properties.
 */
export function nameEffectStyle(
  nameEffect: string | undefined,
  color: string | undefined,
  gradient2?: string,
  gradient3?: string,
  nameShimmer?: boolean,
  nameGlow?: boolean
): { class: string; style: string } {
  const model = wireToModel(nameEffect, nameShimmer, nameGlow);

  // Early return if no effects at all
  if (model.fill === "none" && !model.shimmer && !model.glow) {
    return { class: "", style: "" };
  }

  // Rainbow supplies its own colors; gradient and shimmer need the nickname
  // color and are meaningless without one. Glow also needs a color.
  if (!color && (model.fill !== "rainbow" && model.fill !== "none" || model.glow)) {
    return { class: "", style: "" };
  }

  const classes: string[] = ["name-effect"];
  const cssProperties: Record<string, string> = {};
  const animations: string[] = [];

  // Apply fill (gradient, rainbow, or none)
  if (model.fill === "gradient") {
    // User-picked stops when set; a derived lighter complement or white sweep otherwise,
    // so a gradient with no second color still renders something.
    // For legacy shimmer (gradient fill with shimmer on, no explicit gradient2),
    // use the white sweep; for regular gradient, use lightenColor.
    let stops: string[];
    if (model.shimmer && !gradient2) {
      // Legacy shimmer sweep: color -> white -> color
      stops = [color!, "rgba(255,255,255,0.3)", color!];
    } else {
      stops = [
        color!,
        // Color is guaranteed to exist at this point
        gradient2 || lightenColor(color!),
        ...(gradient3 ? [gradient3] : []),
      ];
    }
    const stopsStr = stops.join(", ");

    classes.push("name-effect-gradient");

    // Build the background gradient
    const gradientValue = `linear-gradient(90deg, ${stopsStr})`;
    cssProperties["background"] = gradientValue;
    cssProperties["-webkit-background-clip"] = "text";
    cssProperties["background-clip"] = "text";
    cssProperties["-webkit-text-fill-color"] = "transparent";

    // Apply shimmer animation over the gradient fill
    if (model.shimmer) {
      classes.push("name-effect-shimmer");
      // background-size: 200% 100% gives the background room to slide
      // for the shimmer keyframes (which move from -200% to 200%)
      cssProperties["background-size"] = "200% 100%";
      animations.push("shimmer 3.5s steps(50) infinite");
    }
  } else if (model.fill === "rainbow") {
    classes.push("name-effect-rainbow");
    const rainbowGradient =
      "linear-gradient(90deg,#ff5959,#ffb545,#ffe234,#5be35b,#4fc3ff,#b06aff,#ff5959)";
    cssProperties["background"] = rainbowGradient;
    cssProperties["-webkit-background-clip"] = "text";
    cssProperties["background-clip"] = "text";
    cssProperties["-webkit-text-fill-color"] = "transparent";
    animations.push("rainbow 3s linear infinite");
  } else if (model.shimmer) {
    // Shimmer without a fill: legacy behavior (no fill, just shimmer sweep).
    // This preserves the appearance of nameEffect: "shimmer" alone.
    classes.push("name-effect-shimmer");
    const shimmerGradient = `linear-gradient(90deg, ${color}, rgba(255,255,255,0.3), ${color})`;
    cssProperties["background"] = shimmerGradient;
    cssProperties["background-size"] = "200% 100%";
    cssProperties["-webkit-background-clip"] = "text";
    cssProperties["background-clip"] = "text";
    cssProperties["-webkit-text-fill-color"] = "transparent";
    animations.push("shimmer 3.5s steps(50) infinite");
  }

  // Apply glow (always independent, composes with any fill).
  // Glow uses text-shadow, which is independent of background-clip and
  // -webkit-text-fill-color, so it layers on top of any fill.
  if (model.glow) {
    classes.push("name-effect-glow");
    cssProperties["--name-glow-color"] = color!;
    cssProperties["text-shadow"] = `0 0 3px ${color}`;
  }

  if (color && model.fill === "none" && !model.shimmer) {
    cssProperties["color"] = color;
  }

  // Combine animations into a single property to avoid cascade issues
  // where duplicate animation properties cancel each other
  if (animations.length > 0) {
    cssProperties["animation"] = animations.join(", ");
  }

  // Build the style string from properties
  const styleStr = Object.entries(cssProperties)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");

  return { class: classes.join(" "), style: styleStr };
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
