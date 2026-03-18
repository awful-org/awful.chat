/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { precacheAndRoute } from "workbox-precaching";
import { storeSharedPayload } from "$lib/share-target";

declare let self: ServiceWorkerGlobalScope;

clientsClaim();
self.skipWaiting();

precacheAndRoute((self as ServiceWorkerGlobalScope & { __WB_MANIFEST: any }).__WB_MANIFEST);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "POST") return;

  const url = new URL(request.url);
  if (url.pathname !== "/share-target") return;

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
});
