<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { identityStore } from "$lib/identity.svelte";
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
  import { consumeLatestSharedPayload } from "$lib/share-target";
  import ReloadPrompt from "./ReloadPrompt.svelte";
  import InstallPrompt from "./InstallPrompt.svelte";

  const queryClient = new QueryClient();

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : null;
  }

  let pendingRoomCode = $state<string | null>(
    parseRoomCode(window.location.pathname)
  );

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

  $effect(() => {
    if (!identityStore.isUnlocked) return;
    consumeSharedIfPresent().catch(() => {});
  });

  let activeRoomCode = $state<string | null>(null);
  let activeRoomName = $state<string>("");
  let lockedView = $state<"unlock" | "restore">("unlock");
  let sidebarOpen = $state(false);
  let joinError = $state<string | null>(null);
  let incomingSharedFiles = $state<File[]>([]);
  let incomingSharedText = $state("");

  async function consumeSharedIfPresent() {
    const payload = await consumeLatestSharedPayload();
    if (!payload) return;
    incomingSharedFiles = payload.files;
    incomingSharedText = payload.text ?? payload.url ?? "";
    history.replaceState({}, "", "/app");
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

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
    history.pushState({}, "", "/app");
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

  function clearIncomingShared() {
    incomingSharedFiles = [];
    incomingSharedText = "";
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
            {incomingSharedFiles}
            {incomingSharedText}
            onConsumeIncomingShared={clearIncomingShared}
          />
        {:else}
          {#if incomingSharedFiles.length > 0}
            <div class="border-b border-border bg-muted/30 px-4 py-3">
              <p class="text-sm text-foreground">
                Shared {incomingSharedFiles.length} file{incomingSharedFiles.length ===
                1
                  ? ""
                  : "s"} ready to send.
              </p>
              {#if roomsStore.rooms.length > 0}
                <div class="mt-2 flex flex-wrap gap-2">
                  {#each roomsStore.rooms as room (room.roomCode)}
                    <button
                      type="button"
                      class="rounded border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                      onclick={() => handleSelectRoom(room.roomCode)}
                    >
                      Send to {room.name || room.roomCode}
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="mt-1 text-xs text-muted-foreground">
                  Join or create a room, then shared files will be staged
                  automatically.
                </p>
              {/if}
            </div>
          {/if}
          <RoomCreateJoin
            {toggleSidebar}
            onJoin={handleJoin}
            error={joinError}
          />
        {/if}
      </div>
      <ReloadPrompt />
      <InstallPrompt />
    </div>
  {/if}
</QueryClientProvider>
