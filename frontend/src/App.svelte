<script lang="ts">
  import { identityStore, init } from "$lib/identity/identity.svelte";
  import AppView from "$lib/components/AppView.svelte";
  import Landing from "./Landing.svelte";
  import InstallPrompt from "$lib/components/InstallPrompt.svelte";
  import NotifyPrompt from "$lib/components/NotifyPrompt.svelte";
  import ReloadPrompt from "$lib/components/ReloadPrompt.svelte";
  import { notifyState } from "$lib/notify.svelte";
  import { ensurePushSubscription } from "$lib/push.svelte";
  import { parseRoomCode } from "$lib/palette/query";

  let currentRoute = $state<"landing" | "app">("landing");

  /** A percent-encoded URL piece, or the piece itself when it is malformed. */
  function decode(part: string): string {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }

  /**
   * The room code out of the address bar, fragment form first.
   *
   * The code IS the membership secret, and a path carries it everywhere a
   * fragment does not: the server's access log, the Referer of every outbound
   * link, and nginx's own og:url rewrite. Invite links are `/r/#<code>` now.
   * `/r/<code>` still parses, because links already handed out do not change.
   *
   * The palette's parser rather than a local one: it is the only parser that
   * knows every shape a code has ever had AND strips the `web+awfl://` scheme.
   * The manifest registers that protocol as `/r/%s`, so a tapped `web+awfl://`
   * link arrives as an ENCODED url inside the path - which the local parser
   * handed to normalizeRoomCode whole, and every such link opened the landing
   * page instead of the room.
   */
  function urlRoomCode(): string | null {
    const { pathname, hash } = window.location;
    if (!pathname.startsWith("/r/")) return null;
    return parseRoomCode(decode(pathname) + decode(hash));
  }

  /**
   * Move an old path-form invite into the fragment before anything else runs.
   * The request that carried it is already in the server's log, but every
   * later Referer and share of window.location.href would carry it too.
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
    void notifyState.permission;
    void ensurePushSubscription();
  });

  $effect(() => {
    if (identityStore.initializing) return;

    upgradeLegacyPath();
    const pathname = window.location.pathname;
    const roomCode = urlRoomCode();

    if (roomCode) {
      currentRoute = "app";
    } else if (pathname === "/app" || pathname === "/share-target") {
      // /share-target is normally a POST the service worker answers; a GET
      // reaches nginx only when no worker controls the page yet, and the
      // shared payload is already parked in IndexedDB for the app to claim.
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
  });

  function handlePopState() {
    if (identityStore.initializing) return;

    const pathname = window.location.pathname;

    if (urlRoomCode() || pathname === "/app" || pathname === "/share-target") {
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
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

{#if identityStore.initializing}
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
  </div>
{:else if currentRoute === "landing"}
  <Landing />
{:else}
  <AppView />
{/if}
