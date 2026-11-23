/**
 * Still frames already drawn, for the next place the same picture shows up.
 *
 * GifImage loads and decodes a copy of an animated picture before it draws
 * any of it, which is at least a frame with nothing there. A picture that was
 * on screen a moment ago - every avatar of a chat, on every change of channel
 * - blinked for it each time. The frame drawn then is the one drawn now, at
 * once, until the copy is ready.
 *
 * Only small frames, the avatars: what is kept is pixels already checked and
 * drawn, never an image to decode. Forgotten when the session ends, as the
 * avatars themselves are.
 */
interface Frame {
  width: number;
  height: number;
}

/** A larger frame (a GIF in a message) is not kept. */
export const MAX_KEPT_SIDE = 192;
export const MAX_KEPT_FRAMES = 64;

/** Oldest use first: a Map keeps insertion order, and a use inserts again. */
const frames = new Map<string, HTMLCanvasElement>();

/** Keep a copy of the frame just drawn of `src`. */
export function keepStillFrame(
  src: string,
  canvas: HTMLCanvasElement,
  copyOf: (canvas: HTMLCanvasElement) => HTMLCanvasElement = copyCanvas
): void {
  if (!keepable(canvas)) return;
  const held = frames.get(src);
  // The sharpest one drawn: each place draws at its own size.
  const copy = held && held.width >= canvas.width ? held : copyOf(canvas);
  frames.delete(src);
  frames.set(src, copy);
  while (frames.size > MAX_KEPT_FRAMES) frames.delete(frames.keys().next().value!);
}

/** The frame last drawn of `src`, or undefined. */
export function keptStillFrame(src: string): HTMLCanvasElement | undefined {
  const held = frames.get(src);
  if (!held) return undefined;
  frames.delete(src);
  frames.set(src, held);
  return held;
}

export function forgetStillFrames(): void {
  frames.clear();
}

function keepable({ width, height }: Frame): boolean {
  return width > 0 && height > 0 && width <= MAX_KEPT_SIDE && height <= MAX_KEPT_SIDE;
}

function copyCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d")?.drawImage(canvas, 0, 0);
  return copy;
}
