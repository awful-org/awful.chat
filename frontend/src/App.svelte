<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { identityStore, init } from "$lib/identity.svelte";
  import IdentitySetup from "$lib/components/IdentitySetup.svelte";
  import UnlockIdentity from "$lib/components/UnlockIdentity.svelte";
  import RoomCreateJoin from "$lib/components/RoomCreateJoin.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import RoomSidebar from "$lib/components/RoomSidebar.svelte";
  import {
    transportState,
    joinRoom,
    leaveRoom,
    selfId,
    setRoomName,
  } from "$lib/transport.svelte";
  import {
    roomsStore,
    loadRooms,
    saveRoom,
    removeRoom,
  } from "$lib/rooms.svelte";
  import { loadProfile } from "$lib/profile.svelte";
  import ReloadPrompt from "$lib/components/ReloadPrompt.svelte";

  const queryClient = new QueryClient();

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : null;
  }

  let pendingRoomCode = $state<string | null>(
    parseRoomCode(window.location.pathname)
  );

  $effect(() => {
    init();
  });

  $effect(() => {
    if (identityStore.isUnlocked) {
      loadRooms();
      loadProfile();
      if (pendingRoomCode) {
        const code = pendingRoomCode;
        pendingRoomCode = null;
        handleJoin(code, "");
      }
    }
  });

  let activeRoomCode = $state<string | null>(null);
  let activeRoomName = $state<string>("");
  let lockedView = $state<"unlock" | "restore">("unlock");
  let sidebarOpen = $state(false);
  let joinError = $state<string | null>(null);

  async function handleJoin(
    roomCode: string,
    _displayName: string,
    roomName?: string
  ) {
    joinError = null;
    try {
      await joinRoom(roomCode);
      const label =
        roomName ||
        roomsStore.rooms.find((r) => r.roomCode === roomCode)?.name ||
        roomCode;
      activeRoomCode = roomCode;
      activeRoomName = label;
      setRoomName(label);
      await saveRoom(roomCode, label);
      history.pushState({ roomCode }, "", `/r/${roomCode}`);
    } catch (err) {
      joinError = err instanceof Error ? err.message : String(err);
    }
  }

  function handleLeave() {
    leaveRoom();
    activeRoomCode = null;
    activeRoomName = "";
    history.pushState({}, "", "/");
  }

  async function handleRemoveRoom(code?: string) {
    if (!code) code = activeRoomCode!;
    await removeRoom(code);
    if (activeRoomCode === code) {
      handleLeave();
    }
  }

  function handleSelectRoom(code: string) {
    if (code === activeRoomCode) {
      sidebarOpen = false;
      return;
    }
    leaveRoom();
    const room = roomsStore.rooms.find((r) => r.roomCode === code);
    handleJoin(code, "", room?.name);
    sidebarOpen = false;
  }

  function handlePopState() {
    const code = parseRoomCode(window.location.pathname);
    if (code && code !== activeRoomCode) {
      leaveRoom();
      const room = roomsStore.rooms.find((r) => r.roomCode === code);
      handleJoin(code, "", room?.name);
    } else if (!code && activeRoomCode) {
      leaveRoom();
      activeRoomCode = null;
      activeRoomName = "";
    }
  }

  const myId = $derived(selfId());
  const hasSidebar = $derived(roomsStore.rooms.length > 0);
</script>

<svelte:window onpopstate={handlePopState} />

<QueryClientProvider client={queryClient}>
  {#if identityStore.loading && !identityStore.keypair}
    <div class="min-h-screen bg-background flex items-center justify-center">
      <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
    </div>
  {:else if !identityStore.keypair}
    <IdentitySetup />
  {:else if !identityStore.isUnlocked}
    {#if lockedView === "restore"}
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
  {:else}
    <div class="min-h-screen bg-background text-foreground font-mono flex">
      {#if hasSidebar}
        <RoomSidebar
          rooms={roomsStore.rooms}
          {activeRoomCode}
          unreadCounts={roomsStore.unreadCounts}
          isOpen={sidebarOpen}
          onClose={() => (sidebarOpen = false)}
          onSelectRoom={handleSelectRoom}
          onRemoveRoom={handleRemoveRoom}
        />
      {/if}
      <div class="flex-1 min-w-0">
        {#if activeRoomCode}
          <ChatView
            roomCode={activeRoomCode}
            roomName={transportState.roomName || activeRoomName}
            selfId={myId}
            onLeave={() => handleRemoveRoom()}
            onOpenSidebar={hasSidebar ? () => (sidebarOpen = true) : undefined}
          />
        {:else}
          <RoomCreateJoin onJoin={handleJoin} error={joinError} />
        {/if}
      </div>
    </div>
  {/if}
</QueryClientProvider>

<ReloadPrompt />
