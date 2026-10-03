<script lang="ts">
  /**
   * The app's address before its first unlock: the setup screen, or the
   * unlock screen and its way into a restore - what AppView shows while
   * locked, in a chunk of its own.
   *
   * AppView brings everything with it (libp2p, the call UI, the settings:
   * about 2 MB), and the first visit from an invite link, the most common
   * first visit there is, waited for all of it before showing a form that
   * needs none of it. App.svelte shows this instead until the identity is
   * unlocked, and AppView from then on, its own lock screen included.
   */
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { consumeRoomLocation, parkedRoom } from "$lib/room-location";
  import IdentitySetup from "./IdentitySetup.svelte";
  import UnlockIdentity from "./UnlockIdentity.svelte";

  // What AppView does when it mounts locked: the invitation leaves the
  // address bar at once, and waits in memory for AppView to join it.
  parkedRoom.code = consumeRoomLocation() ?? parkedRoom.code;

  // And on every navigation, as AppView's popstate handler does while locked:
  // the address is the truth, an address with no room included.
  function handlePopState() {
    parkedRoom.code = consumeRoomLocation();
  }

  function handleHashChange(event: HashChangeEvent) {
    // Fragment navigation can emit popstate before hashchange. If popstate
    // already consumed/replaced this URL, don't clear its pending invitation.
    if (event.newURL === window.location.href) handlePopState();
  }

  let lockedView = $state<"unlock" | "restore">("unlock");

  // The setup's avatar picker searches GIFs with svelte-query, which wants a
  // client in context: AppView's, when AppView showed this.
  const queryClient = new QueryClient();
</script>

<svelte:window onpopstate={handlePopState} onhashchange={handleHashChange} />

<QueryClientProvider client={queryClient}>
  {#if !identityStore.keypair}
    <IdentitySetup />
  {:else if lockedView === "restore"}
    <IdentitySetup
      initialStep="restore"
      onCancelToUnlock={() => {
        lockedView = "unlock";
      }}
    />
  {:else}
    <UnlockIdentity
      onRecover={() => {
        lockedView = "restore";
      }}
    />
  {/if}
</QueryClientProvider>
