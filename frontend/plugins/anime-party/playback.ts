/**
 * Pure, DOM-free rules for whether a local file is likely to play, and for
 * turning a native `<video>` decode failure into one honest sentence.
 *
 * Deliberately NOT a `canPlayType`/`MediaCapabilities` probe: this module
 * is imported by `reduce`-adjacent tests that run under vitest's `node`
 * environment (no DOM, see `frontend/vitest.config.ts`), and a codec's real
 * fate is only known once the browser actually tries to decode the file
 * anyway. What is knowable ahead of time, filename alone, is the one
 * failure that is not a maybe: Chromium and most browsers never play
 * Matroska at all, container or codec aside.
 */

export type PlaybackVerdict = "unplayable" | "risky" | "unknown";

export interface FileAssessment {
  verdict: PlaybackVerdict;
  /** One plain sentence, or null when there is nothing to warn about yet. */
  reason: string | null;
}

/** Matroska family. The dominant anime-release container, and the one
 *  browsers never play regardless of the codec inside it. */
const UNPLAYABLE_EXTENSIONS = new Set(["mkv", "mka", "mks"]);

/** Filename hints for encodes that decode unreliably even in a playable
 *  container (MP4/WebM). A hint, not a verdict - the browser's own attempt
 *  is the only real answer, so this only ever softens to "risky", never
 *  blocks a file the way the container check does. */
const RISKY_NAME_HINTS: RegExp[] = [
  /\bhevc\b/i,
  /\bh\.?265\b/i,
  /\b10.?bit\b/i,
  /\bhi10p\b/i,
];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function assessFile(filename: string): FileAssessment {
  const ext = extensionOf(filename);
  if (UNPLAYABLE_EXTENSIONS.has(ext)) {
    return {
      verdict: "unplayable",
      reason: `Browsers cannot play the Matroska (.${ext}) container. Convert this file to .mp4 or .webm, or watch it in a desktop player instead.`,
    };
  }
  if (RISKY_NAME_HINTS.some((re) => re.test(filename))) {
    return {
      verdict: "risky",
      reason:
        "This file's name suggests HEVC or 10-bit color, which many browsers decode unreliably. It may stutter, show no picture, or fail outright.",
    };
  }
  return { verdict: "unknown", reason: null };
}

/**
 * `HTMLMediaElement.error.code` to one plain sentence. Codes are the
 * standard `MediaError` constants (`MEDIA_ERR_ABORTED` = 1, ... `_SRC_NOT_SUPPORTED` = 4).
 */
const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: "Loading this file was aborted.",
  2: "The file could not be loaded, which usually means a network or file-access problem, not the format.",
  3: "The file started playing but decoding failed partway through - often an unsupported codec profile inside an otherwise playable container.",
  4: "This browser does not support this file's format at all.",
};

export function mediaErrorMessage(code: number | null | undefined): string {
  if (code == null) return "This file could not be played, for an unknown reason.";
  return MEDIA_ERROR_MESSAGES[code] ?? "This file could not be played, for an unknown reason.";
}
