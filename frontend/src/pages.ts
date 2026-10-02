import type { Component } from "svelte";
import { useQc, useQs } from "$lib/runtime-config";

/**
 * The pages that are not part of the startup bundle.
 *
 * Imported statically, the app shell made everything - libp2p, the call UI,
 * the settings - one ~2.9 MB entry chunk, and nothing painted until all of it
 * had downloaded and run: the public landing page included, which needs none
 * of it. Each of these is its own chunk now, loaded when App.svelte shows it.
 * The app's address shows the gate - the setup and unlock screens - until the
 * identity is unlocked, and the app only then: an invite link's first visit
 * is a form, and waiting for the app behind it was most of the wait.
 * vite.config.ts names the same pages for the preload list (pageChunks).
 */
const loaders = {
  app: () => import("$lib/components/AppView.svelte"),
  gate: () => import("$lib/components/IdentityGate.svelte"),
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
    load.catch((error) => {
      // Said here, once: the screen only says the app could not load, and a
      // page whose modules threw while loading - a bug, not the connection -
      // ends up on that same screen.
      console.error(`[pages] ${page} could not load`, error);
      loads.delete(page);
    });
  }
  return load;
}

export type Route = "landing" | "app" | "qs" | "qc";

/**
 * The routes an instance can turn off: whether they exist at all is in its
 * configuration (main.ts waits for that to be read on these two).
 */
export function optionalRoute(pathname: string): "qs" | "qc" | null {
  const path = pathname.replace(/\/$/, "");
  return path === "/qs" ? "qs" : path === "/qc" ? "qc" : null;
}

/** What an address shows: App.svelte's routing, and main.ts's preload. */
export function routeFor(pathname: string): Route {
  if (pathname.startsWith("/r/")) return "app";
  // A disabled optional route falls through to the landing page rather than
  // 404ing: the flag is an operator's choice, not a broken link, and the
  // page it would have shown does not exist here.
  const optional = optionalRoute(pathname);
  if (optional === "qs") return useQs() ? "qs" : "landing";
  if (optional === "qc") return useQc() ? "qc" : "landing";
  // /share-target is normally a POST the service worker answers; a GET
  // reaches nginx only when no worker controls the page yet, and the shared
  // payload is already parked in IndexedDB for the app to claim.
  if (pathname === "/app" || pathname === "/share-target") return "app";
  return "landing";
}

/**
 * The page a route shows first. The app's is the gate: nothing unlocks the
 * identity before the page is up, so the setup or unlock screen comes first.
 */
export function firstPage(route: Route): LazyPage | null {
  if (route === "landing") return null;
  return route === "app" ? "gate" : route;
}

const preloaded = new Set<LazyPage>();

/**
 * Start downloading a page without running it: its chunks as modulepreload
 * links, its stylesheets as preloads, from the list vite.config.ts writes
 * into index.html. main.ts calls this while /config.json is still being
 * read, so an invite link's first visit does not start its download a round
 * trip late. Running has to wait: the page's modules may read the
 * configuration. Once per page.
 *
 * modulepreload is also what vite's own loader asks for; a browser without
 * it (Safari before 17) gets these fetched by vite's modulepreload polyfill,
 * which runs first in the entry and watches for exactly these links.
 */
export function preloadPage(page: LazyPage | null): void {
  if (!page || preloaded.has(page)) return;
  let lists: Partial<Record<LazyPage, unknown>>;
  try {
    lists = JSON.parse(document.getElementById("page-chunks")?.textContent || "{}");
  } catch {
    return;
  }
  const hrefs = lists[page];
  if (!Array.isArray(hrefs)) return;
  preloaded.add(page);
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

/**
 * Download the page that is likely next - the app, behind the setup and
 * unlock screens - once the current one has painted and the browser is
 * idle, so it never competes with what is on screen. Not when the browser
 * asks to save data: the page then downloads when it is opened.
 */
export function prefetchPage(page: LazyPage): void {
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData === true) return;
  const later = () => preloadPage(page);
  if (typeof requestIdleCallback === "function") requestIdleCallback(later, { timeout: 2000 });
  else setTimeout(later, 200);
}
