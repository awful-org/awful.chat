/**
 * Which pages a browser may translate: the landing page, and no other.
 *
 * Translation sends a page's text to whoever runs the translator, and here that
 * is decrypted messages. It also replaces the page's text nodes with its own,
 * after which an update to the originals shows nowhere: the composer's text
 * stopped at its first letter.
 *
 * Set on the document rather than in index.html, which the landing page and the
 * app share. main.ts does it before anything else, ahead of the moment a
 * browser looks at what it has loaded. The landing page's links to the app load
 * a new document, so a translator at work on it does not come along.
 */

import type { Route } from "../pages";

export function setPageTranslatable(
  route: Route,
  root: HTMLElement = document.documentElement
): void {
  const translatable = route === "landing";
  // The class is what Google's translator reads, the attribute every browser.
  root.classList.toggle("notranslate", !translatable);
  if (translatable) root.removeAttribute("translate");
  else root.setAttribute("translate", "no");
}
