<script lang="ts">
  import { identityStore, init } from "$lib/identity.svelte";
  import AppView from "$lib/components/AppView.svelte";
  import ReloadPrompt from "$lib/components/ReloadPrompt.svelte";
  import Landing from "./Landing.svelte";

  let currentRoute = $state<"landing" | "app">("landing");

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : null;
  }

  $effect(() => {
    init();
  });

  $effect(() => {
    const pathname = window.location.pathname;
    const roomCode = parseRoomCode(pathname);

    if (roomCode) {
      currentRoute = "app";
    } else if (pathname === "/app") {
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
  });

  $effect(() => {
    if (identityStore.isUnlocked && currentRoute === "landing") {
      const roomCode = parseRoomCode(window.location.pathname);
      if (roomCode) {
        history.replaceState({}, "", `/r/${roomCode}`);
      } else {
        history.replaceState({}, "", "/app");
      }
      currentRoute = "app";
    }
  });

  function handlePopState() {
    const pathname = window.location.pathname;
    const roomCode = parseRoomCode(pathname);

    if (roomCode || pathname === "/app") {
      currentRoute = "app";
    } else {
      currentRoute = "landing";
    }
  }
</script>

<svelte:window onpopstate={handlePopState} />

{#if currentRoute === "landing"}
  <Landing />
{:else}
  <AppView />
{/if}

<ReloadPrompt />
