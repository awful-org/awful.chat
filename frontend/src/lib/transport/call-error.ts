/**
 * Media-error text and lifecycle, kept out of call.svelte.ts so it can be
 * tested: that module builds a libp2p node at import time, which no test
 * environment can load. Without this seam the only way to "test" these was to
 * paste a copy of the function into the test file, which then passes happily
 * while the real implementation regresses.
 */

/** How long an error stays on screen. Matches TransportStatus's own budget. */
export const ERROR_CLEAR_MS = 10_000;

/**
 * A readable message for a media failure.
 *
 * A denied permission surfaces the BROWSER's wording, which differs per engine
 * - Firefox says "Permission denied by user", Chrome says "Permission denied"
 * - and none of them say what to do about it.
 */
export function describeMediaError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "NotAllowedError") {
      return "Microphone or camera permission denied. Re-grant permission in your browser's site settings to continue.";
    }
    return err.message;
  }
  return String(err);
}

/** Structural, so this module never has to import the transport state. */
export interface ErrorSlot {
  error: string | null;
}

let _timer: ReturnType<typeof setTimeout> | null = null;

/** Drop any pending auto-clear, without touching the current message. */
export function cancelErrorClear(): void {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

/**
 * Show a message and retire it on its own. Previously a media error sat on
 * screen until the next attempt, so a denied permission never went away.
 */
export function setErrorWithAutoClear(
  slot: ErrorSlot,
  message: string,
  ms: number = ERROR_CLEAR_MS
): void {
  cancelErrorClear();
  slot.error = message;
  _timer = setTimeout(() => {
    // Only OUR message. The slot is shared - dm.svelte.ts and
    // transmission.svelte.ts write it too - so an unconditional null would
    // wipe a newer, unrelated error that arrived inside the window and cut
    // its display short for reasons the user cannot see.
    if (slot.error === message) slot.error = null;
    _timer = null;
  }, ms);
}
