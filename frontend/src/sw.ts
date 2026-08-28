/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { precacheAndRoute, matchPrecache } from "workbox-precaching";
import { storeSharedPayload } from "$lib/share-target";
import { storeNotifyIntent } from "$lib/notify-intents";

declare let self: ServiceWorkerGlobalScope;

clientsClaim();

// registerType is "prompt": the new worker WAITS until the user accepts the
// reload (updateServiceWorker() posts SKIP_WAITING). The old unconditional
// skipWaiting() activated instantly and, with clientsClaim, swapped the
// precache under live pages - their old hashed chunks vanished, the next
// lazy import failed, and the vite:preloadError handler force-reloaded the
// app mid-call. That was the "sometimes it auto-refreshes".
// Notification clicks and inline replies. The intent is WRITTEN to
// IndexedDB first - the app may be closed, or open but locked - and the
// app drains it after unlock; the postMessage below is just the "check
// now" nudge for a window that is already alive.
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data as
    | { roomCode?: string; dmPeerDid?: string }
    | undefined;
  const reply = (event as NotificationEvent & { reply?: string }).reply;
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (data?.roomCode) {
        await storeNotifyIntent({
          kind: event.action === "reply" && reply ? "reply" : "open",
          roomCode: data.roomCode,
          dmPeerDid: data.dmPeerDid,
          text: reply ?? "",
          ts: Date.now(),
        }).catch(() => {});
      }
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const win = wins[0] as WindowClient | undefined;
      if (win) {
        await win.focus().catch(() => {});
        win.postMessage({ type: "notify-intent" });
      } else {
        // Replies too: with no window alive, opening the app is the ONLY
        // way the stored intent ever gets drained and sent - gating this
        // on "not a reply" silently dropped replies typed while the app
        // was fully closed.
        await self.clients.openWindow("/app").catch(() => {});
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

precacheAndRoute(
  (self as ServiceWorkerGlobalScope & { __WB_MANIFEST: any }).__WB_MANIFEST
);

// Big, rarely-needed assets are kept OUT of the precache (see globIgnores in
// vite.config.ts) and cached the first time they are actually used instead:
//   - the DTLN wasm worklet (~8 MB), warmed once in the idle time after
//     app start and loaded on first voice use
//   - shiki language chunks (~300 files), fetched only when a code block of
//     that language is rendered
// Precaching them cost every visitor ~16 MB on install and on every update.
const WORKLET_CACHE = "dtln-worklet-v1";
const LANGS_CACHE = "shiki-langs-v1";

function runtimeCacheName(url: URL): string | null {
  if (url.origin !== self.location.origin) return null;
  if (url.pathname === "/audio-worklet.js") return WORKLET_CACHE;
  if (url.pathname.startsWith("/assets/langs/")) return LANGS_CACHE;
  return null;
}

async function cacheFirst(
  request: Request,
  cacheName: string,
  exclusive = false
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Entries are content-versioned (hashed filename or ?v= query), so a
  // successful response is safe to keep until its URL changes.
  if (response.ok) {
    if (exclusive) {
      // One live version: a changed ?v= misses the cache above, lands here,
      // and replaces the superseded entry instead of accumulating 8 MB blobs.
      try {
        for (const key of await cache.keys()) await cache.delete(key);
      } catch {
        // noop: worst case the old entry lingers
      }
    }
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

/**
 * A share POST cannot be attributed to its sender from inside a service
 * worker. Origin and Sec-Fetch-Site are appended after the fetch event is
 * dispatched, so they are simply absent from request.headers here
 * (whatwg/fetch#1322 exists to fix exactly that), and the referrer is one
 * referrerpolicy="no-referrer" away from being empty - which is what a
 * hostile page sets and a genuine OS share may carry anyway. A referrer test
 * therefore rejects nobody who tries while risking every real share, so we
 * do not run one.
 *
 * What a page cannot fake is the shape of the navigation it caused. A share
 * is always a top-level navigation: the share sheet opens the app. A form
 * auto-submitted into a hidden iframe or an <object> is the only shape that
 * can plant payloads and hammer the storage quota in a loop without the user
 * ever seeing it, and that is what this rejects. A top-level POST from a
 * hostile page still reaches the handler - it also drags the user onto our
 * own origin in a visible tab, one payload per navigation, and the bounds in
 * storeSharedPayload are what keep that from costing anything.
 *
 * This is a deny list on purpose: an unfamiliar destination passes, because
 * silently dropping a real share is worse than storing a bounded record.
 */
const NESTED_NAVIGATION_DESTINATIONS = new Set([
  "iframe",
  "frame",
  "fencedframe",
  "embed",
  "object",
]);

/** The app is a SPA: every in-scope navigation is served by index.html. */
async function handleNavigation(request: Request): Promise<Response> {
  const cached = await matchPrecache("index.html");
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method === "POST") {
    const url = new URL(request.url);
    if (url.pathname !== "/share-target") return;
    // Not answering leaves the POST to the network, where nginx serves a
    // static path and returns 405 - nothing is stored either way.
    if (NESTED_NAVIGATION_DESTINATIONS.has(request.destination)) return;

    event.respondWith(
      (async () => {
        try {
          const formData = await request.formData();
          const title = (formData.get("title") as string | null) ?? undefined;
          const text = (formData.get("text") as string | null) ?? undefined;
          const sharedUrl = (formData.get("url") as string | null) ?? undefined;
          const files = formData
            .getAll("files")
            .filter((value): value is File => value instanceof File);

          if (files.length > 0 || text || sharedUrl || title) {
            await storeSharedPayload({
              title,
              text,
              url: sharedUrl,
              files,
            });
          }
        } catch {
          // noop: we still redirect into app shell
        }

        return Response.redirect("/app?shared=1", 303);
      })()
    );
    return;
  }

  if (request.method !== "GET") return;

  // Without this the app simply does not open offline: precacheAndRoute only
  // matches exact URLs, so /app and /r/<code> miss the cache entirely even
  // though every message already lives on the device.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  const cacheName = runtimeCacheName(new URL(request.url));
  if (cacheName) {
    event.respondWith(
      cacheFirst(request, cacheName, cacheName === WORKLET_CACHE)
    );
  }
});
