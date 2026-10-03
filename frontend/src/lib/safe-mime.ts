/**
 * What type a peer's file may carry once it is in the browser.
 *
 * A file's MIME type is the SENDER's claim. A blob URL is on the app's own
 * origin, so a blob typed `text/html` - or an SVG, which can hold script -
 * opened as a page runs as the app: with its storage, including the device
 * key. The production CSP happened to block that; the dev server and any
 * deployment without that nginx config did not. So the type a blob gets is
 * decided here, from an allowlist, never taken from the wire as it is.
 */

/** Raster images a browser renders without running anything. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
/** Types that also open safely as a page of their own (the viewer's new tab). */
const OPENABLE_EXTRA = new Set(["application/pdf", "text/plain"]);

function base(mimeType: unknown): string {
  return typeof mimeType === "string" ? mimeType.split(";")[0].trim().toLowerCase() : "";
}

/**
 * The type to build a blob with. SVG keeps its type - an <img> shows it and
 * cannot run its scripts - but never opens as a page (see canOpenAsPage).
 * Anything unknown becomes application/octet-stream, which a browser saves
 * rather than renders.
 */
export function safeBlobType(mimeType: unknown): string {
  const type = base(mimeType);
  if (RASTER.has(type) || OPENABLE_EXTRA.has(type) || type === "image/svg+xml") return type;
  if (/^(audio|video)\/[a-z0-9.+-]+$/.test(type)) return type;
  return "application/octet-stream";
}

/** Whether a file of this type may be opened as a page of its own. */
export function canOpenAsPage(mimeType: unknown): boolean {
  const type = base(mimeType);
  return RASTER.has(type) || OPENABLE_EXTRA.has(type) || /^(audio|video)\/[a-z0-9.+-]+$/.test(type);
}
