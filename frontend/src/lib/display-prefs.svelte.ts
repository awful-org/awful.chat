/**
 * Display preferences for the chat view. Device-local, like media-prefs: a
 * preference about this screen, not part of the identity or profile.
 */

const ITALIC_KEY = "awful:italic-own-name:v1";
const PEER_COLORS_KEY = "awful:show-peer-colors:v1";

function readStored(key: string, defaultValue: boolean): boolean {
  if (typeof localStorage === "undefined") return defaultValue;
  const v = localStorage.getItem(key);
  return v === null ? defaultValue : v === "1";
}

export const displayPrefs = $state({
  /** Render your own name above your messages in italics. */
  italicOwnName: readStored(ITALIC_KEY, false),
  /** Show other people's custom colors; off keeps every remote name default. */
  showPeerNicknameColors: readStored(PEER_COLORS_KEY, true),
});

export function setItalicOwnName(on: boolean): void {
  displayPrefs.italicOwnName = on;
  try {
    localStorage.setItem(ITALIC_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setShowPeerNicknameColors(on: boolean): void {
  displayPrefs.showPeerNicknameColors = on;
  try {
    localStorage.setItem(PEER_COLORS_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// A second tab flipping a switch should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === ITALIC_KEY)
      displayPrefs.italicOwnName = e.newValue === "1";
    if (e.key === PEER_COLORS_KEY)
      displayPrefs.showPeerNicknameColors = e.newValue === "1";
  });
}