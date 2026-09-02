<script lang="ts">
  import { identityStore, init } from "$lib/identity/identity.svelte";
  import AppView from "$lib/components/AppView.svelte";
  import Landing from "./Landing.svelte";
  import { normalizeRoomCode } from "$lib/room-code";

  let currentRoute = $state<"landing" | "app">("landing");

  /**
   * The room code out of the address bar, fragment form first.
   *
   * The code IS the membership secret, and a path carries it everywhere a
   * fragment does not: the server's access log, the Referer of every outbound
   * link, and nginx's own og:url rewrite. Invite links are `/r/#<code>` now.
   * `/r/<code>` still parses, because links already handed out do not change.
   */
  function parseRoomCode(pathname: string, hash: string): string | null {
    if (!pathname.startsWith("/r/")) return null;
    const raw =
      hash.length > 1 ? hash.slice(1) : pathname.slice(3).split("/")[0];
    if (!raw) return null;
    try {
      return normalizeRoomCode(decodeURIComponent(raw));
    } catch {
      return normalizeRoomCode(raw);
    }
  }

  /**
   * Move an old path-form invite into the fragment before anything else runs.
   * The request that carried it is already in the server's log, but every
   * later Referer and share of window.location.href would carry it too.
   */
  function upgradeLegacyPath(): void {
    const { pathname, hash, search } = window.location;
    if (!pathname.startsWith("/r/") || hash.length > 1) return;
    const code = pathname.slice(3).split("/")[0];
    if (code) history.replaceState(history.state, "", `/r/${search}#${code}`);
  }

  $effect(() => {
    init();
  });

  $effect(() => {
    if (identityStore.initializing) return;

    upgradeLegacyPath();
    const pathname = window.location.pathname;
    const roomCode = parseRoomCode(pathname, window.location.hash);

    if (roomCode) {
      currentRoute = "app";
    } else if (pathname === "/app") {
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
  });

  function handlePopState() {
    if (identityStore.initializing) return;

    const pathname = window.location.pathname;
    const roomCode = parseRoomCode(pathname, window.location.hash);

    if (roomCode || pathname === "/app") {
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
  }
</script>

<svelte:window onpopstate={handlePopState} />

{#if identityStore.initializing}
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
  </div>
{:else if currentRoute === "landing"}
  <Landing />
{:else}
  <AppView />
{/if}
