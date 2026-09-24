/**
 * Whether a message is nothing but a link to an animated image, which the
 * chat renders inline (the GIF picker sends exactly this).
 *
 * The whole message must be the URL - a gif link inside a sentence stays a
 * link - but the host is deliberately NOT restricted. A host allowlist here
 * rejected every ordinary place a gif lives (imgur, the Discord CDN, someone's
 * own server); those messages then fell through to the OG card, and for a raw
 * image URL the relay reads the binary body as HTML, finds no meta tags and
 * answers mediaType "none", so the user got the bare link plus an empty
 * bordered card - and every viewer of the message made the relay download
 * the image, uncached.
 *
 * It also bought nothing: the same peer-supplied link still renders the OG
 * card's og:image as an <img src>, so the browser fetch the allowlist was
 * meant to prevent happened anyway, one hop later. Loading a remote image on
 * render does expose the viewer's IP to whoever hosts it; that has to be
 * answered where every remote image goes through (a relay-side image proxy),
 * not by breaking gif links.
 */
export function isGifUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return false;
  }
  try {
    // The extension is read off the pathname so a CDN's cache-busting query
    // ("...cat.gif?width=200") still counts as an image.
    return /\.(gif|webp)$/i.test(new URL(trimmed).pathname);
  } catch {
    return false;
  }
}
