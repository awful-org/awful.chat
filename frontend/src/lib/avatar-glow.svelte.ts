import { SvelteMap } from "svelte/reactivity";
import { canLoadMedia } from "./media-prefs.svelte";

/**
 * The average colour of an avatar, so chrome around a picture can be lit by
 * the picture.
 *
 * Two halves: pure colour maths, which is where the whole look actually
 * lives and is unit tested, and a small cache in front of a canvas read,
 * which is not (it needs a real decoder). Callers prime a URL from an effect
 * and read the result from the template; the first paint has no glow and the
 * glow fades in a frame or two later, which is why the elements that use it
 * carry a filter transition.
 */

/**
 * Pixels a side to sample. The browser's own downscale does the averaging in
 * native code, so this is about how much detail survives, not speed - and a
 * 1x1 draw is not the free version of this: some engines drop to
 * nearest-neighbour at that ratio and hand back one arbitrary pixel.
 */
const SAMPLE = 24;

/**
 * Under this alpha a pixel is the transparent corner of a circular avatar
 * rather than part of the picture. Averaging those in is averaging in black,
 * which drags every glow toward a muddy grey no matter what the pfp is.
 */
const MIN_ALPHA = 16;

/** Cap on remembered avatars, so a long call with many peers cannot grow
 *  this without bound. Evicts oldest-first; recomputing is cheap. */
const MAX_CACHED = 128;

export type Triplet = string;

/**
 * The alpha-weighted mean of RGBA bytes, or null when nothing is opaque
 * enough to count.
 */
export function averagePixels(
  data: ArrayLike<number>
): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < MIN_ALPHA) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (n === 0) return null;
  return [r / n, g / n, b / n];
}

/**
 * Turn a flat average into a colour worth glowing with.
 *
 * The mean of a photograph is almost always a muddy near-grey, and a muddy
 * near-grey glow just looks like the shadow is broken. Two corrections: pull
 * the channels away from the luma to recover the chroma the averaging washed
 * out, then slide the whole thing into a band that reads as a light source,
 * since a very dark average glows as nothing and a very bright one glows as
 * white.
 */
export function stylize(rgb: [number, number, number]): Triplet {
  const [r, g, b] = rgb;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const SATURATION = 1.9;
  const shift = Math.min(200, Math.max(120, luma)) - luma;
  const out = [r, g, b].map((v) =>
    Math.round(
      Math.min(255, Math.max(0, luma + (v - luma) * SATURATION + shift))
    )
  );
  return `${out[0]} ${out[1]} ${out[2]}`;
}

/**
 * The tile filled flat with the avatar's own colour.
 *
 * This started as a radial wash and a wash is the wrong instinct at tile
 * size: a soft falloff across a few hundred pixels reads as a smudge rather
 * than as light, and it bands on a dark tile. A flat fill reads as a
 * deliberate backdrop - the avatar sits on a card in its own colour, which
 * stays legible when the tile is small and when several tiles sit side by
 * side in different colours.
 *
 * Still translucent: at full opacity the tile stops agreeing with the app's
 * own surface colours, and a pale avatar turns the tile into a white slab.
 */
export function ambientStyle(triplet: Triplet | null | undefined): string {
  if (!triplet) return "";
  return `background-color: rgb(${triplet} / 0.7);`;
}

/**
 * A soft rim on the avatar itself, so the circle belongs to the wash instead
 * of sitting on top of it.
 *
 * drop-shadow rather than box-shadow on purpose: Tailwind builds `ring-*` out
 * of box-shadow, so an inline box-shadow silently deletes the ring these
 * avatars are already wearing. A filter also follows the rendered shape, so a
 * circular avatar glows as a circle without anyone restating the radius.
 */
export function rimStyle(
  triplet: Triplet | null | undefined,
  scale = 1
): string {
  if (!triplet) return "";
  return `filter: drop-shadow(0 0 ${Math.round(8 * scale)}px rgb(${triplet} / 0.35));`;
}

// ── The cache ──────────────────────────────────────────────────────────────

const glows = new SvelteMap<string, Triplet | null>();

/** Start resolving a URL's glow if it is not already known or in flight. */
export function primeGlow(url: string): void {
  if (!canLoadMedia(url)) return;
  if (glows.has(url)) return;
  if (glows.size >= MAX_CACHED) {
    const oldest = glows.keys().next().value;
    if (oldest !== undefined) glows.delete(oldest);
  }
  // Claimed before the await so a re-render mid-flight does not queue a
  // second decode of the same picture.
  glows.set(url, null);
  void computeGlow(url).then((t) => glows.set(url, t));
}

/** The glow for a URL, or null while it is unknown, in flight, or unusable. */
export function glowFor(url: string | null | undefined): Triplet | null {
  return url ? (glows.get(url) ?? null) : null;
}

async function computeGlow(url: string): Promise<Triplet | null> {
  if (typeof document === "undefined") return null;
  const img = new Image();
  // Must be set before src. blob: and data: avatars ignore it; a remote pfp
  // needs it or the canvas is tainted and reading it throws. A host that
  // sends no CORS headers therefore gets no glow, which is the right way to
  // fail: the picture still renders, it just does not light anything.
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const avg = averagePixels(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
    return avg ? stylize(avg) : null;
  } catch {
    return null;
  }
}
