/**
 * Intrinsic image dimensions, so a picture can occupy its space before it
 * has loaded.
 *
 * Without these an image is zero-height until it decodes and then snaps to
 * full size, shoving everything below it down - which is why the chat had to
 * be re-scrolled once the images finished, and why a loading skeleton could
 * not be drawn at the right size. They are measured once by the sender, who
 * already holds the file, and travel with the announce.
 *
 * Also the size a peer's inline avatar or banner claims in its header, read
 * without decoding it, and the size a GIF's still frame is drawn at: both
 * keep an image from costing what its own dimensions would.
 */

/**
 * The largest sane pixel dimension we will believe.
 *
 * These numbers arrive from a peer inside a signed message, which proves who
 * sent them and nothing about whether they are honest. A width of 1e9 in an
 * aspect-ratio is a layout weapon, so anything outside this range is treated
 * as "no dimensions" and the image falls back to loading the old way.
 */
const MAX_DIMENSION = 20000;

/** Tailwind's max-w-xs and max-h-56 on the inline image, in rem. */
const MAX_W_REM = 20;
const MAX_H_REM = 14;

/** Beyond this the box is a sliver, which is a layout weapon of its own. */
const MAX_RATIO = 20;

export function isSaneDimension(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_DIMENSION;
}

/**
 * The exact box an image of this shape will occupy, as an inline style.
 *
 * Both the skeleton and the image itself wear it, so the one is replaced by
 * the other with no reflow at all. CSS does the fitting: the width is
 * whichever of the two limits binds first, and aspect-ratio supplies the
 * height, so there is no measuring in JavaScript to drift out of step with
 * the class list.
 *
 * Returns "" when the dimensions are missing or untrustworthy, which leaves
 * the caller rendering exactly as it did before they existed.
 */
export function mediaBoxStyle(
  width: unknown,
  height: unknown
): string {
  if (!isSaneDimension(width) || !isSaneDimension(height)) return "";
  // A pair inside the range can still be absurd as a RATIO: 20000x1 passes
  // both bounds and lays out a box a fraction of a pixel tall.
  const ratio = width / height;
  if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) return "";
  const w = Math.min(
    MAX_W_REM,
    MAX_H_REM * ratio,
    // Never larger than the picture itself. The limits are a ceiling, not a
    // target: without this a 64x64 avatar got stretched to 224x224 and
    // blurred, where before it simply rendered at 64.
    width / 16
  );
  return `width: ${w.toFixed(3)}rem; aspect-ratio: ${width} / ${height};`;
}

/**
 * How long to wait for a file to tell us its size.
 *
 * This runs on the send path, before seeding, so a file that never reports
 * metadata would hold the send open indefinitely. Losing the dimensions
 * costs a layout shift; losing the send costs the message.
 */
const MEASURE_TIMEOUT_MS = 3000;

/**
 * Cleanups owed by measurements still in flight. A timeout abandons the
 * promise but not the resources it opened, so the timeout runs them itself.
 */
const releaseOnTimeout = new Set<() => void>();

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        for (const release of [...releaseOnTimeout]) {
          releaseOnTimeout.delete(release);
          try {
            release();
          } catch {
            // Best effort: a failed cleanup must not fail the send.
          }
        }
        resolve(null);
      }, MEASURE_TIMEOUT_MS);
    }),
  ]);
}

/**
 * Measure a local image or video. Resolves to null for anything else and for
 * anything that will not decode, so the caller can simply attach whatever
 * comes back.
 */
export async function measureMedia(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  // Both paths, not just video: the comment above promises the send path is
  // protected, and img.decode() on a hostile or truncated file is not
  // guaranteed to reject promptly either.
  if (file.type.startsWith("video/")) return withTimeout(measureVideo(file));
  if (!file.type.startsWith("image/")) return null;
  return withTimeout(measureImage(file));
}

async function measureImage(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      const { width, height } = bmp;
      bmp.close();
      if (isSaneDimension(width) && isSaneDimension(height)) {
        return { width, height };
      }
      return null;
    } catch {
      // Fall through: Safari has historically refused some formats here.
    }
  }
  if (typeof Image !== "function" || typeof URL === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    return isSaneDimension(width) && isSaneDimension(height)
      ? { width, height }
      : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A video reports its shape through metadata, which needs an element and a
 * load - there is no createImageBitmap equivalent. preload="metadata" keeps
 * it to the header rather than pulling the media down twice.
 */
async function measureVideo(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return null;
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  // Released on the way out of the race too. A finally here only runs when
  // this promise settles, and when the timeout wins it never does - leaving
  // an element still fetching a URL that is never revoked.
  const release = () => {
    // Drop the source before revoking, or the element keeps fetching a URL
    // that no longer resolves.
    video.src = "";
    video.load();
    URL.revokeObjectURL(url);
  };
  releaseOnTimeout.add(release);
  try {
    video.preload = "metadata";
    // Muted and inline: some browsers refuse to load metadata for a video
    // they consider capable of making noise without a gesture.
    video.muted = true;
    video.playsInline = true;
    const ready = new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("metadata failed"));
    });
    video.src = url;
    await ready;
    const { videoWidth: width, videoHeight: height } = video;
    return isSaneDimension(width) && isSaneDimension(height)
      ? { width, height }
      : null;
  } catch {
    return null;
  } finally {
    releaseOnTimeout.delete(release);
    release();
  }
}

type Size = { width: number; height: number };
/** A file's byte at `i`, or -1 past its end. */
type ByteAt = (i: number) => number;

/**
 * The pixel size an image declares in its header, read without decoding
 * it: GIF, PNG, WebP and JPEG. Null for any other format, or for a header
 * cut short.
 */
export function declaredImageSize(byteAt: ByteAt): Size | null {
  return (
    gifSize(byteAt) ?? pngSize(byteAt) ?? webpSize(byteAt) ?? jpegSize(byteAt)
  );
}

/** `n` bytes from `at`, or null when the file ends first. */
function bytesAt(byteAt: ByteAt, at: number, n: number): number[] | null {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const b = byteAt(at + k);
    if (b < 0) return null;
    out.push(b);
  }
  return out;
}

const ascii = (b: number[], at: number, n: number) =>
  String.fromCharCode(...b.slice(at, at + n));

/**
 * The logical screen, grown to fit the first frame: Chromium and Firefox
 * both grow it, so a 1x1 screen around a 16383x16383 frame decodes at the
 * frame's size.
 */
function gifSize(byteAt: ByteAt): Size | null {
  const head = bytesAt(byteAt, 0, 13);
  if (!head || ascii(head, 0, 3) !== "GIF") return null;
  let width = head[6] | (head[7] << 8);
  let height = head[8] | (head[9] << 8);
  // Past the global colour table, then past any extensions: each is a run
  // of sub-blocks that an empty one ends.
  let at = 13 + (head[10] & 0x80 ? 3 << ((head[10] & 7) + 1) : 0);
  while (byteAt(at) === 0x21) {
    at += 2;
    for (let len = byteAt(at); len > 0; len = byteAt(at)) at += len + 1;
    at++;
  }
  const frame = byteAt(at) === 0x2c ? bytesAt(byteAt, at + 1, 8) : null;
  if (frame) {
    const [left, top, w, h] = [0, 2, 4, 6].map((k) => frame[k] | (frame[k + 1] << 8));
    width = Math.max(width, left + w);
    height = Math.max(height, top + h);
  }
  return { width, height };
}

const u32 = (b: number[], at: number) =>
  b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);

/** The IHDR chunk, which must come first. */
function pngSize(byteAt: ByteAt): Size | null {
  const head = bytesAt(byteAt, 0, 24);
  if (!head || head[0] !== 0x89 || ascii(head, 1, 3) !== "PNG") return null;
  if (ascii(head, 12, 4) !== "IHDR") return null;
  return { width: u32(head, 16), height: u32(head, 20) };
}

/** An extended WebP's canvas (an animated one is extended), or its one bitstream's size. */
function webpSize(byteAt: ByteAt): Size | null {
  const head = bytesAt(byteAt, 0, 30);
  if (!head || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") return null;
  switch (ascii(head, 12, 4)) {
    case "VP8X":
      return {
        width: 1 + (head[24] | (head[25] << 8) | (head[26] << 16)),
        height: 1 + (head[27] | (head[28] << 8) | (head[29] << 16)),
      };
    case "VP8 ":
      // After the frame tag and the start code: 14 bits a side.
      return {
        width: (head[26] | (head[27] << 8)) & 0x3fff,
        height: (head[28] | (head[29] << 8)) & 0x3fff,
      };
    case "VP8L": {
      // After the signature byte: 14 bits of width - 1, then of height - 1.
      const bits = head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  return null;
}

/**
 * The frame header, walking the segments before it by their lengths, so a
 * padded EXIF block cannot push it out of reach and an embedded thumbnail
 * is never mistaken for it.
 */
function jpegSize(byteAt: ByteAt): Size | null {
  if (byteAt(0) !== 0xff || byteAt(1) !== 0xd8) return null;
  let at = 2;
  for (;;) {
    if (byteAt(at) !== 0xff) return null;
    while (byteAt(at + 1) === 0xff) at++;
    const marker = byteAt(at + 1);
    at += 2;
    // TEM, RST0-7 and SOI carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = bytesAt(byteAt, at, 2);
    // The end of the image, or the scan begins, with no frame header yet.
    if (!length || marker === 0xd9 || marker === 0xda) return null;
    // SOF0-15, except DHT, JPG and DAC, which share the range.
    const sofn = marker >= 0xc0 && marker <= 0xcf;
    if (sofn && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = bytesAt(byteAt, at + 2, 5);
      return sof && { width: (sof[3] << 8) | sof[4], height: (sof[1] << 8) | sof[2] };
    }
    const len = (length[0] << 8) | length[1];
    if (len < 2) return null;
    at += len;
  }
}

/**
 * The size a base64 data: URL's image declares, decoding only the parts of
 * it the header walk reads, 3 KiB at a time: never the whole picture, which
 * is what the check is there to avoid.
 */
export function dataUrlImageSize(url: string): Size | null {
  const b64 = url.slice(url.indexOf(",") + 1);
  const WINDOW = 3072;
  let start = -1;
  let chunk = "";
  return declaredImageSize((i) => {
    const at = i - (i % WINDOW);
    if (at !== start) {
      start = at;
      const chars = b64.slice((at / 3) * 4, ((at + WINDOW) / 3) * 4);
      try {
        chunk = atob(chars.padEnd(Math.ceil(chars.length / 4) * 4, "="));
      } catch {
        chunk = "";
      }
    }
    return i - at < chunk.length ? chunk.charCodeAt(i - at) : -1;
  });
}

/**
 * The most an avatar or banner sent inline may claim to be, a side. The
 * picker sends 256 and 840. A peer's hand-made 16383x16383 GIF is a few
 * dozen bytes that decode to a gigabyte, in every place it is drawn, and
 * it is stored and drawn again on every launch.
 */
const MAX_PROFILE_IMAGE_SIDE = 4096;

/**
 * Whether an inline avatar or banner claims a size worth drawing. A format
 * not read here (AVIF) or a header cut short passes, as before: GifImage
 * bounds every still frame it draws, whatever arrives.
 */
export function profileImageFits(dataUrl: string): boolean {
  const size = dataUrlImageSize(dataUrl);
  return (
    !size ||
    (size.width <= MAX_PROFILE_IMAGE_SIDE &&
      size.height <= MAX_PROFILE_IMAGE_SIDE)
  );
}

/**
 * A still frame's longest side, in canvas pixels: far more than an avatar
 * or a GIF in a message is ever shown at.
 */
const MAX_FRAME_SIDE = 1024;

/** Past this an image is not decoded for a still frame: 4096x4096 is 64 MB decoded. */
const MAX_FRAME_PIXELS = 4096 * 4096;

export function canDecodeStillFrame(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= MAX_FRAME_PIXELS;
}

/**
 * The canvas for a still frame of a `naturalWidth` x `naturalHeight`
 * image shown in a `shownWidth` x `shownHeight` box (CSS pixels, 0 when
 * unknown): the image's own shape, with the pixels to cover the box at
 * `pixelRatio`, never more than the image has, nor MAX_FRAME_SIDE a side.
 * Null for an image too large to decode for one.
 *
 * Every canvas is a backing store of its own, so drawing each at the
 * image's size put a peer's 16383x16383 avatar at a gigabyte in every
 * place it appeared: the user list, each of their message groups, a
 * profile card, a call tile.
 */
export function stillFrameSize(
  naturalWidth: number,
  naturalHeight: number,
  shownWidth: number,
  shownHeight: number,
  pixelRatio: number
): Size | null {
  if (!canDecodeStillFrame(naturalWidth, naturalHeight)) return null;
  let scale = Math.min(
    1,
    MAX_FRAME_SIDE / Math.max(naturalWidth, naturalHeight)
  );
  if (shownWidth > 0 && shownHeight > 0) {
    const ratio = Math.max(1, pixelRatio || 1);
    // Enough to cover the box: an avatar crops the frame to fill it.
    const cover = Math.max(
      (shownWidth * ratio) / naturalWidth,
      (shownHeight * ratio) / naturalHeight
    );
    scale = Math.min(scale, cover);
  }
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}
