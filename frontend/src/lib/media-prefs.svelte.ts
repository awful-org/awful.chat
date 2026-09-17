/**
 * Whether GIFs in chat animate on their own or wait for a hover.
 * Device-local, like the audio prefs: a preference about this screen.
 */

const KEY = "awful:gif-autoplay:v1";
const AUTO_DL_KEY = "awful:auto-download-media:v1";
const EXTERNAL_MEDIA_KEY = "awful:external-media:v1";

export const mediaPrefs = $state({
  externalMedia: typeof localStorage === "undefined" || localStorage.getItem(EXTERNAL_MEDIA_KEY) !== "0",
  gifAutoplay:
    typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "0",
  // On by default: media showing up without a click is the expected chat
  // behavior; the toggle exists for metered connections.
  autoDownloadMedia:
    typeof localStorage === "undefined" ||
    localStorage.getItem(AUTO_DL_KEY) !== "0",
});

export function setExternalMedia(on: boolean): void {
  mediaPrefs.externalMedia = on;
  try { localStorage.setItem(EXTERNAL_MEDIA_KEY, on ? "1" : "0"); } catch { /* device-local preference cannot persist */ }
}

/** External rendering can be disabled; locally transferred attachments remain usable. */
export function canLoadMedia(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/^(blob:|data:)/i.test(url)) return true;
  try {
    const origin = typeof location !== "undefined" ? location.origin : "https://local.invalid";
    const parsed = new URL(url, origin);
    return /^(https?:)$/.test(parsed.protocol) && (mediaPrefs.externalMedia || parsed.origin === origin);
  } catch { return false; }
}

export function setGifAutoplay(on: boolean): void {
  mediaPrefs.gifAutoplay = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setAutoDownloadMedia(on: boolean): void {
  mediaPrefs.autoDownloadMedia = on;
  try {
    localStorage.setItem(AUTO_DL_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// A second tab flipping the switch should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === EXTERNAL_MEDIA_KEY) mediaPrefs.externalMedia = e.newValue !== "0";
    if (e.key === KEY) mediaPrefs.gifAutoplay = e.newValue !== "0";
    if (e.key === AUTO_DL_KEY)
      mediaPrefs.autoDownloadMedia = e.newValue !== "0";
  });
}
