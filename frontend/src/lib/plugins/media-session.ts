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
  /**
   * The element to float when the browser enters picture-in-picture on its
   * own (Chromium pops the window on a tab switch while media plays). A
   * call in progress keeps its own spotlight as the target instead.
   */
  pipVideo?: HTMLVideoElement;
}

let _owner: symbol | null = null;
/** The metadata last handed to the browser, so repeats are not re-fetched. */
let _metaKey: string | null = null;

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
  _pluginPipVideo = info?.pipVideo ?? null;
  syncPipAction();
  try {
    if (!info) {
      _metaKey = null;
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
    const title = cap(info.title);
    const artist = cap(info.artist);
    // Only a CHANGED metadata object is assigned: every assignment makes
    // the browser fetch the artwork again, and a playback plugin re-applies
    // on each play and pause, so a party's cover was fetched per click.
    // playbackState and the handlers are cheap and always refreshed.
    const key = `${title}\u0000${artist}\u0000${artwork ?? ""}`;
    if (key !== _metaKey) {
      _metaKey = key;
      ms.metadata = new MediaMetadata({
        title,
        artist,
        artwork: artwork
          ? [{ src: artwork, sizes: "480x360", type: "image/jpeg" }]
          : [],
      });
    }
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

// Picture-in-Picture. The module owns media-related global resources, so
// the one enterpictureinpicture action (Chromium's auto-PiP on tab switch)
// is registered here for whoever should float: a call's spotlight while a
// call is on, else the video the now-playing plugin named.
let _pipEnterHandler: (() => void) | null = null;
let _pluginPipVideo: HTMLVideoElement | null = null;

function syncPipAction(): void {
  const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
  if (!ms) return;
  const video = _pluginPipVideo;
  const fn =
    _pipEnterHandler ??
    (video ? () => void requestElementPip(video) : null);
  try {
    // enterpictureinpicture is not in the TS action union yet.
    ms.setActionHandler(
      "enterpictureinpicture" as MediaSessionAction,
      fn ? () => fn() : null
    );
  } catch {
    // Not supported here; PiP stays a manual affair.
  }
}

/**
 * Register the call's auto-PiP entry handler, or clear it. While set it
 * wins over any plugin video; clearing it hands the action back to the
 * plugin's, if one is playing.
 */
export function setOnPictureInPictureEnter(
  handler: (() => void) | null
): void {
  _pipEnterHandler = handler;
  syncPipAction();
}

/**
 * Float one video in the browser's own picture-in-picture window. Needs a
 * user gesture on most platforms. False where there is no API at all
 * (Firefox offers only its hover toggle) or the browser refused.
 */
export async function requestElementPip(
  video: HTMLVideoElement
): Promise<boolean> {
  try {
    if (document.pictureInPictureElement === video) return true;
    if (typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
      return true;
    }
    const webkit = video as unknown as {
      webkitSupportsPresentationMode?: (mode: string) => boolean;
      webkitSetPresentationMode?: (mode: string) => void;
    };
    if (
      webkit.webkitSetPresentationMode &&
      webkit.webkitSupportsPresentationMode?.("picture-in-picture")
    ) {
      webkit.webkitSetPresentationMode("picture-in-picture");
      return true;
    }
  } catch (err) {
    console.warn("[pip] could not open:", err);
  }
  return false;
}
