/**
 * Asking the relay what a link leads to.
 */

import { apiUrl } from "$lib/runtime-config";

export interface OgPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  video?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoContentType?: string;
  mediaType: "video" | "image" | "none";
}

/** What there is to say of a link whose preview could not be had: its site. */
export function bareOgPreview(url: string): OgPreview {
  return { url, mediaType: "none" };
}

/** The longest wait honoured. The relay's window is a minute. */
const MAX_RETRY_AFTER_S = 600;

/**
 * How many times one link is asked again. At thirty a minute that fills a
 * whole screen of history; past it, a flood of links somebody posted is not
 * worth spending the budget of the next ones on.
 */
const MAX_RETRIES = 5;

/**
 * How long a 429 asks us to wait, in ms, or null when it does not say. Bounded
 * at both ends: zero would ask again at once, forever, and so would a wait too
 * long for setTimeout, which fires straight away.
 */
export function retryAfterMs(header: string | null): number | null {
  if (!header || !/^\d+$/.test(header)) return null;
  const seconds = Number(header);
  return seconds >= 1 && seconds <= MAX_RETRY_AFTER_S ? seconds * 1000 : null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The preview of a url: a bare one when the relay could not get it, a rejection
 * when the relay could not be asked.
 *
 * A room can show more new links than the relay fetches for one client in a
 * minute. It answers the rest 429 and says when to ask again, so that is when
 * we do; `onWait` runs first, for the caller to show something meanwhile.
 */
export async function fetchOgPreview(
  url: string,
  signal: AbortSignal,
  onWait: () => void
): Promise<OgPreview> {
  for (let tries = 0; ; tries++) {
    const response = await fetch(
      // No hardcoded origin: an unset apiUrl means this instance never said
      // where its relay is, and defaulting to awful.frav.in would hand every
      // link its users open to a stranger's server. Empty resolves
      // same-origin and 404s, so previews are simply off.
      `${apiUrl()}/og/preview?url=${encodeURIComponent(url)}`,
      { signal }
    );
    if (response.ok) return (await response.json()) as OgPreview;
    const ms =
      response.status === 429 && tries < MAX_RETRIES
        ? retryAfterMs(response.headers.get("Retry-After"))
        : null;
    // Every other answer is an {error} body, which is not a preview.
    if (ms === null) return bareOgPreview(url);
    onWait();
    await wait(ms, signal);
  }
}

/**
 * The address to give a video element, if this preview has one it can play.
 * Many sites (YouTube, Vimeo) name an embed page here instead, as text/html.
 */
export function playableVideo(
  preview: OgPreview,
  canPlay: (type: string) => boolean = browserPlays
): string | null {
  if (preview.mediaType !== "video" || !preview.video) return null;
  const type = preview.videoContentType;
  // With no type given, the element finds out; its error shows the link. Not
  // only video/*: Safari plays HLS, which calls itself application/*.
  return !type || /^video\//i.test(type) || canPlay(type) ? preview.video : null;
}

function browserPlays(type: string): boolean {
  return (
    typeof document !== "undefined" &&
    document.createElement("video").canPlayType(type) !== ""
  );
}
