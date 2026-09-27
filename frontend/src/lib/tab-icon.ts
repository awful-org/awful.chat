/**
 * The tab's favicon while another tab holds the node.
 *
 * Only one tab of a profile runs the node (node-lock.ts); the others wait
 * with an "open in another tab · Use here" bar that nobody sees until they
 * switch back. WhatsApp marks its waiting tab in the tab strip itself, and
 * so does this: the awful mark dimmed, with a red badge
 * (public/favicon-held.svg, rendered to favicon-held.png because Safari does
 * not take SVG favicons).
 *
 * The original href is read from the page rather than hardcoded, so a
 * change to index.html's icon is never undone by this.
 */

const HELD_ICON = "/favicon-held.png";

let originalHref: string | null = null;

export function showHeldElsewhereIcon(held: boolean): void {
  if (typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (held) {
    originalHref ??= link.getAttribute("href");
    link.setAttribute("href", HELD_ICON);
  } else if (originalHref !== null) {
    link.setAttribute("href", originalHref);
    originalHref = null;
  }
}
