import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { loadRuntimeConfig } from "$lib/runtime-config";
import { captureInstallPrompt } from "$lib/install-prompt.svelte";

// The service worker still has exactly ONE registration: useRegisterSW inside
// ReloadPrompt.svelte. A second registerSW() here used to race it - each
// registration attached its own updatefound listener, and whichever caught
// the update decided what the user saw: sometimes the reload popup,
// sometimes only a transport toast (silently lost when transport was not up
// yet), sometimes nothing. One registration, one UI.
//
// What DID move is where that one registration lives: App.svelte mounts
// ReloadPrompt above the route switch, so the worker is registered on the
// landing page and while the identity is still locked. Registering only from
// inside AppView meant the page most first-time visitors ever see had no
// worker at all, and a site with no worker is a site the browser will not
// offer to install.

// The install event fires once, early, and cannot be replayed - before the
// app mounts is the only place that reliably catches it.
captureInstallPrompt();

// A tab that loaded before a deploy holds the old index.html, and its lazy
// imports (webtorrent, mediasoup-client, shiki...) point at hashed chunks the
// new deploy deleted - the click that needed one just failed. Vite fires this
// event for exactly that; a reload gets the new index whose chunks all exist.
// The once-a-minute guard stops a reload loop when the failure is not a stale
// hash (offline, server down).
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("preload-error-reload") ?? 0);
  if (Date.now() - last < 60_000) return; // let it surface as a normal error
  sessionStorage.setItem("preload-error-reload", String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

// Configuration BEFORE the app mounts. Several modules read the relay and
// api urls while they initialise, and a mount that raced this would have
// them capture the build-time fallback instead of what the instance
// actually serves. A missing config.json resolves immediately.
await loadRuntimeConfig();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
