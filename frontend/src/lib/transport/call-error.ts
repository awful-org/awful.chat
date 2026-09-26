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

/**
 * What to say when a screen share fails to start - or nothing, when the
 * person simply closed the browser's picker.
 *
 * Every engine reports a cancelled picker as NotAllowedError, the same name
 * a refused camera gets, so the camera copy above ("Microphone or camera
 * permission denied") greeted everyone who changed their mind. Chrome
 * separates the one refusal that is not a choice by its message: the OS
 * withholding screen capture ("Permission denied by system", macOS Screen
 * Recording). That one gets copy that says where to fix it.
 */
export function describeShareError(err: unknown): string | null {
  if (err instanceof Error) {
    if (err.name === "AbortError") return null;
    if (err.name === "NotAllowedError") {
      return /by system/i.test(err.message)
        ? "Your system is blocking screen capture. Allow this browser under Screen Recording in your system's privacy settings, then try again."
        : null;
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
