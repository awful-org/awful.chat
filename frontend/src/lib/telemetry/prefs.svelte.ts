/**
 * Diagnostic preferences. Device-local, like `display-prefs`.
 *
 * Neither switch controls the RECORDER. The flight recorder is always on, in
 * memory, from boot, because a bug is over by the time anyone thinks to flip a
 * switch. These two switches gate the two EXITS from the tab:
 *
 * - `persist` - write sealed chunks to IndexedDB, so a crash or a reload keeps
 *   the history.
 * - `upload` - allow a bundle to reach this instance's collector. That is a
 *   real disclosure change: the relay gains ICE states, timings, counters and
 *   error codes it did not have. See `docs/spec.md` "Server Privacy".
 *
 * Its own module rather than a lodger in `display-prefs.svelte.ts`: that module
 * pulls in `chat-font`, and a diagnostic switch must not drag a font stack into
 * every importer.
 */

const PERSIST_KEY = "awful:diag-persist:v1";
const UPLOAD_KEY = "awful:diag-upload:v1";

// Copied, not imported, from display-prefs for the reason in the header, with
// one addition: node 25 defines a `localStorage` global that throws unless the
// process was started with `--localstorage-file`, so a `typeof` test is not
// enough on its own.
function readStored(key: string, defaultValue: boolean): boolean {
  try {
    if (typeof localStorage === "undefined") return defaultValue;
    const v = localStorage.getItem(key);
    return v === null ? defaultValue : v === "1";
  } catch {
    return defaultValue;
  }
}

export const diagPrefs = $state({
  /** Keep the diagnostic ring across reloads and crashes, sealed on disk. */
  persist: readStored(PERSIST_KEY, false),
  /** Allow an upload of a bundle to this instance's collector. */
  upload: readStored(UPLOAD_KEY, false),
});

export function setDiagPersist(on: boolean): void {
  diagPrefs.persist = on;
  try {
    localStorage.setItem(PERSIST_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setDiagUpload(on: boolean): void {
  diagPrefs.upload = on;
  try {
    localStorage.setItem(UPLOAD_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// A second tab flipping a switch should be reflected here, not fought. Both
// keys are listed: `display-prefs.svelte.ts:179-181` records the bug that one
// forgotten key causes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PERSIST_KEY) diagPrefs.persist = e.newValue === "1";
    if (e.key === UPLOAD_KEY) diagPrefs.upload = e.newValue === "1";
  });
}
