import { loadAudioPrefs } from "$lib/transport/audio-prefs";
import { WORKLET_URL } from "./worklet-url";

/**
 * Fetch the DTLN worklet ahead of the first call, in idle time, so joining
 * one does not also wait on an 8 MB download: the mic is not opened until the
 * worklet runs. The service worker keeps it after the first fetch (sw.ts
 * leaves it out of the precache on purpose), so this costs the network once
 * per browser and worklet version.
 *
 * Who may call is the caller's to decide - connect() asks for an unlocked
 * session, never the landing page or the setup and unlock screens, where it
 * used to run for every visitor. This decides whether it would be used:
 * noise suppression on, and the browser not asking to save data. On a
 * metered link 5 MB is a lot to spend on a guess, and a first call there
 * fetches the worklet itself.
 */
let asked = false;

export function warmWorkletWhenIdle(): void {
  if (asked) return;
  asked = true;
  const warm = () => {
    if (!worthWarming()) return;
    // Consume the body too: an unread worker-served stream keeps Chromium's
    // old worker busy and can delay even skipWaiting() activation for five
    // minutes.
    void fetch(WORKLET_URL)
      .then((response) => response.arrayBuffer())
      .catch(() => {});
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm);
  else setTimeout(warm, 3000);
}

function worthWarming(): boolean {
  if (!loadAudioPrefs().dtlnEnabled) return false;
  const connection = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)
    ?.connection;
  return connection?.saveData !== true;
}
