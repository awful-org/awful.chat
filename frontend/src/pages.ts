import type { Component } from "svelte";
import { useQc, useQs } from "$lib/runtime-config";

/**
 * The pages that are not part of the startup bundle.
 *
 * Imported statically, the app shell made everything - libp2p, the call UI,
 * the settings - one ~2.9 MB entry chunk, and nothing painted until all of it
 * had downloaded and run: the public landing page included, which needs none
 * of it. Each of these is its own chunk now, loaded when App.svelte shows it.
 * vite.config.ts names the same three for the preload list (pageChunks).
 */
const loaders = {
  app: () => import("$lib/components/AppView.svelte"),
  qs: () => import("$lib/components/QuickSend.svelte"),
  qc: () => import("$lib/components/QuickCall.svelte"),
};
export type LazyPage = keyof typeof loaders;

const loads = new Map<LazyPage, Promise<Component>>();

/** The page's component: one load, whoever asks. A failed load is not kept. */
export function loadPage(page: LazyPage): Promise<Component> {
  let load = loads.get(page);
  if (!load) {
    load = loaders[page]().then((module) => module.default as Component);
    loads.set(page, load);
    load.catch(() => loads.delete(page));
  }
  return load;
}

/**
 * The page an address shows, when it is one of these - App.svelte's routes,
 * which this has to match. Null is the landing page, which is in the entry.
 */
export function pageFor(pathname: string): LazyPage | null {
  if (pathname.startsWith("/r/")) return "app";
  const path = pathname.replace(/\/$/, "");
  if (path === "/qs") return useQs() ? "qs" : null;
  if (path === "/qc") return useQc() ? "qc" : null;
  if (pathname === "/app" || pathname === "/share-target") return "app";
  return null;
}

/**
 * Start downloading a page without running it: its chunks as modulepreload
 * links, its stylesheets as preloads, from the list vite.config.ts writes
 * into index.html. main.ts calls this while /config.json is still being
 * read, so an invite link's first visit does not start the bulk of its
 * download a round trip late. Running has to wait: the page's modules may
 * read the configuration.
 */
export function preloadPage(page: LazyPage | null): void {
  if (!page) return;
  let lists: Partial<Record<LazyPage, unknown>>;
  try {
    lists = JSON.parse(document.getElementById("page-chunks")?.textContent || "{}");
  } catch {
    return;
  }
  const hrefs = lists[page];
  if (!Array.isArray(hrefs)) return;
  for (const href of hrefs) {
    if (typeof href !== "string") continue;
    const link = document.createElement("link");
    if (href.endsWith(".css")) {
      // Not a stylesheet yet: vite's loader adds that when the page is
      // imported, and waits for it, so the page never shows unstyled.
      link.rel = "preload";
      link.as = "style";
    } else {
      link.rel = "modulepreload";
    }
    // As vite's own loader asks for them, or the preload is not reused.
    link.crossOrigin = "";
    link.href = href;
    document.head.appendChild(link);
  }
}
