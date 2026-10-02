<script lang="ts">
  import { identityStore, init } from "$lib/identity/identity.svelte";
  import Landing from "./Landing.svelte";
  import InstallPrompt from "$lib/components/InstallPrompt.svelte";
  import NotifyPrompt from "$lib/components/NotifyPrompt.svelte";
  import ReloadPrompt from "$lib/components/ReloadPrompt.svelte";
  import { notifyState } from "$lib/notify.svelte";
  import { ensurePushSubscription } from "$lib/push.svelte";
  import { parseRoomCode } from "$lib/palette/query";
  import { applyRouteMeta } from "$lib/page-meta";
  // The app, its setup and unlock screens, /qs and /qc are chunks of their
  // own, so the landing page paints from a small entry; and the routes are
  // pages.ts's, which main.ts preloads from before this mounts.
  import {
    loadPage,
    prefetchPage,
    routeFor,
    type LazyPage,
    type Route,
  } from "./pages";

  let currentRoute = $state<Route>("landing");

  /**
   * Whether the app keeps the screen while locked. Until the first unlock of
   * this page the app's address shows the gate, the setup and unlock screens
   * in a chunk of their own (IdentityGate), and AppView loads only after it:
   * it is about 2 MB, and an invite link's first visit waited for all of it
   * before showing a form that needs none of it. From the first unlock on,
   * AppView keeps the screen and shows its own lock screen, as it always
   * did: locking must not close the room that was open.
   */
  let appOpened = $state(false);
  $effect(() => {
    if (currentRoute === "app" && identityStore.isUnlocked) appOpened = true;
  });
  const gateShown = $derived(
    currentRoute === "app" &&
      !identityStore.initializing &&
      !identityStore.isUnlocked &&
      !appOpened
  );

  // While the gate waits for a password, fetch the app behind it - once the
  // gate is in, so its own download never shares the line with the app's.
  $effect(() => {
    if (!gateShown) return;
    loadPage("gate").then(
      () => prefetchPage("app"),
      () => {}
    );
  });

  /** A percent-encoded URL piece, or the piece itself when it is malformed. */
  function decode(part: string): string {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }

  /**
   * Move an old path-form invite into the fragment before anything else runs.
   * The request that carried it is already in the server's log, but every
   * later Referer and share of window.location.href would carry it too.
   *
   * The code IS the membership secret, and a path carries it everywhere a
   * fragment does not: the server's access log, the Referer of every outbound
   * link, and nginx's own og:url rewrite. Invite links are `/r/#<code>` now.
   * The palette's parser rather than a local one: it is the only parser that
   * knows every shape a code has ever had AND strips the `web+awfl://` scheme,
   * which the manifest registers as `/r/#%s`.
   */
  function upgradeLegacyPath(): void {
    const { pathname, hash, search } = window.location;
    if (!pathname.startsWith("/r/") || hash.length > 1) return;
    // The parsed code when there is one, so a protocol-handler link is
    // rewritten to the plain `/r/#<code>` form rather than to itself.
    const code =
      parseRoomCode(decode(pathname)) ?? pathname.slice(3).split("/")[0];
    if (code) history.replaceState(history.state, "", `/r/${search}#${code}`);
  }

  $effect(() => {
    init();
  });

  // Push, once there is an identity to be pushed to. Reads the permission so
  // that allowing notifications in the browser's own site settings subscribes
  // this device without a reload.
  $effect(() => {
    if (!identityStore.isUnlocked) return;
    // Never on a quick page. A guest's identity dies with the tab and would
    // leave a device mailbox on the relay for an identity that no longer
    // exists; and an account unlocked to take a quick call did not ask to
    // re-register push from here. The ROUTE decides, not the storage scope,
    // which on /qc only moves once the person has chosen who to be.
    if (currentRoute === "qs" || currentRoute === "qc") return;
    void notifyState.permission;
    void ensurePushSubscription();
  });

  $effect(() => {
    if (identityStore.initializing) return;

    upgradeLegacyPath();
    currentRoute = routeFor(window.location.pathname);
    // /qs and /qc are the only routes worth finding from a search, so they
    // say who they are instead of canonicalising to the root - see page-meta.
    applyRouteMeta(currentRoute);
  });

  function handlePopState() {
    if (identityStore.initializing) return;

    currentRoute = routeFor(window.location.pathname);
    applyRouteMeta(currentRoute);
  }
</script>

<svelte:window onpopstate={handlePopState} />

<!--
  Above the route switch, and outside the initializing branch, on purpose.
  These three used to live inside AppView, which means the landing page and
  the locked app had no service worker (so the browser would not offer to
  install the site anybody arrives at) and never asked for notifications.
  ReloadPrompt registers the worker; both prompts are self-limiting, so the
  copies AppView still renders are inert.
-->
<ReloadPrompt />
<InstallPrompt />
<NotifyPrompt />

{#snippet waiting()}
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
  </div>
{/snippet}

<!--
  A page that is not in the startup bundle: the same pulse while its chunk
  arrives, and a way out if it never does (offline on a first visit, say).
-->
{#snippet lazyPage(page: LazyPage)}
  {#await loadPage(page)}
    {@render waiting()}
  {:then Page}
    <Page />
  {:catch}
    <div
      class="min-h-screen bg-background flex flex-col items-center justify-center gap-3 p-4 text-center"
    >
      <p class="font-mono text-xs text-muted-foreground">
        Awful.chat could not load. Check your connection and try again.
      </p>
      <button
        type="button"
        class="font-mono text-xs text-foreground underline"
        onclick={() => window.location.reload()}>Try again</button
      >
    </div>
  {/await}
{/snippet}

<!--
  /qc before the spinner: its "use my account" unlock can auto-login with a
  remembered password, and that raises `initializing` too. Swapping the page
  for the spinner destroyed it mid-unlock; the remount then read the tab's
  session as a guest's and called under a throwaway identity instead. The
  route is only ever "qc" once boot has finished, so this skips nothing.
-->
{#if currentRoute === "qc"}
  {@render lazyPage("qc")}
{:else if identityStore.initializing}
  {@render waiting()}
{:else if currentRoute === "qs"}
  {@render lazyPage("qs")}
{:else if currentRoute === "landing"}
  <Landing />
{:else if gateShown}
  {@render lazyPage("gate")}
{:else}
  {@render lazyPage("app")}
{/if}
