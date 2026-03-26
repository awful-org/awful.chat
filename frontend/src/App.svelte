<script lang="ts">
  import { identityStore, init } from "$lib/identity.svelte";
  import AppView from "$lib/components/AppView.svelte";
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
    if (identityStore.initializing) return;
    
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

  function handlePopState() {
    if (identityStore.initializing) return;
    
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

{#if identityStore.initializing}
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
  </div>
{:else if currentRoute === "landing"}
  <Landing />
{:else}
  <AppView />
{/if}
