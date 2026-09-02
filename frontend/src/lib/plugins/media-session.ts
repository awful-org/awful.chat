/**
 * Host-owned Media Session bridge. navigator.mediaSession is a GLOBAL
 * resource - two plugins writing it directly would fight over the lock
 * screen - so plugins go through host.setNowPlaying and the host
 * arbitrates: the most recent claimer owns the slot, releasing only
 * clears it if you still own it (the tile-presence rule, generalized).
 */

export interface NowPlayingInfo {
  title: string;
  artist?: string;
  artworkUrl?: string;
  playing: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

let _owner: symbol | null = null;

/**
 * Metadata caps. What a plugin passes here is peer-supplied (a title from a
 * shared playlist, artwork from a card), and it lands on the OS lock screen
 * and in the notification shade, outside anything the page can style or take
 * back. An unbounded title pushes the controls off the surface; the artwork
 * source is a URL the platform fetches on its own, so `http:` would be a
 * silent mixed-content fetch and any other scheme is not an image at all.
 */
const MAX_TEXT = 200;
const ARTWORK_SCHEMES = ["https:", "blob:", "data:image/"];

function cap(text: unknown): string {
  return typeof text === "string" ? text.slice(0, MAX_TEXT) : "";
}

function safeArtwork(url: string | undefined): string | null {
  if (!url) return null;
  const lower = url.trim().toLowerCase();
  return ARTWORK_SCHEMES.some((s) => lower.startsWith(s)) ? url : null;
}

function apply(info: NowPlayingInfo | null): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!info) {
      ms.metadata = null;
      ms.playbackState = "none";
      for (const a of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* unsupported action */
        }
      }
      return;
    }
    const artwork = safeArtwork(info.artworkUrl);
    ms.metadata = new MediaMetadata({
      title: cap(info.title),
      artist: cap(info.artist),
      artwork: artwork
        ? [{ src: artwork, sizes: "480x360", type: "image/jpeg" }]
        : [],
    });
    ms.playbackState = info.playing ? "playing" : "paused";
    const bind = (
      action: MediaSessionAction,
      fn: (() => void) | undefined
    ) => {
      try {
        ms.setActionHandler(action, fn ? () => fn() : null);
      } catch {
        /* unsupported action */
      }
    };
    bind("play", info.onPlay);
    bind("pause", info.onPause);
    bind("nexttrack", info.onNext);
    bind("previoustrack", info.onPrevious);
  } catch {
    // Media Session is progressive enhancement, never load-bearing.
  }
}

export function setNowPlayingFor(
  token: symbol,
  info: NowPlayingInfo | null
): void {
  if (info === null) {
    if (_owner === token) {
      _owner = null;
      apply(null);
    }
    return;
  }
  _owner = token;
  apply(info);
}

// Picture-in-Picture action handler. The module owns media-related global
// resources, so PiP action registration goes through here for consistency.
// When the browser's Media Session initiates PiP (e.g., on tab switch for
// Chromium), this handler is called to enter browser PiP.
let _pipEnterHandler: (() => void) | null = null;

/**
 * Register a Picture-in-Picture entry handler.
 *
 * Called when the browser automatically enters PiP (e.g., on tab switch for
 * Chromium's "video conferencing" heuristic, Chrome 120+) or when the user
 * manually requests it via the panel's button.
 *
 * The handler should call video.requestPictureInPicture() to enter PiP.
 */
export function setOnPictureInPictureEnter(
  handler: (() => void) | null
): void {
  _pipEnterHandler = handler;

  // Register the handler with navigator.mediaSession so Chromium calls it
  // when auto-entering PiP on tab switch.
  const ms = navigator.mediaSession;
  if (!ms) return;

  if (handler) {
    try {
      // enterpictureinpicture is a non-standard action, so cast to any.
      ms.setActionHandler("enterpictureinpicture" as MediaSessionAction, () => {
        handler();
      });
    } catch {
      // enterpictureinpicture is not supported on this browser.
    }
  } else {
    // Clear the handler.
    try {
      ms.setActionHandler("enterpictureinpicture" as MediaSessionAction, null);
    } catch {
      // Ignore if unsupported.
    }
  }
}
