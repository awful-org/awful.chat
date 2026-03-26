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
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";

  const queryClient = new QueryClient();

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : null;
  }

  let pendingRoomCode = $state<string | null>(
    parseRoomCode(window.location.pathname)
  );

  let joiningRoom = $state(false);

  $effect(() => {
    if (identityStore.isUnlocked) {
      loadRooms();
      loadProfile();
      if (pendingRoomCode) {
        const code = pendingRoomCode;
        pendingRoomCode = null;
        joiningRoom = true;
        handleJoin(code, "").finally(() => {
          joiningRoom = false;
        });
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
  let createJoinOpen = $state(false);
  let isMobile = $state(false);
  let incomingSharedFiles = $state<File[]>([]);
  let incomingSharedText = $state("");

  async function consumeSharedIfPresent() {
    const payload = await consumeLatestSharedPayload();
    if (!payload) return;
    incomingSharedFiles = payload.files;
    incomingSharedText = payload.text ?? payload.url ?? "";
    history.replaceState({}, "", "/app");
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

  function openCreateJoin() {
    createJoinOpen = true;
  }

  async function handleJoinFromModal(
    roomCode: string,
    displayName: string,
    roomName?: string
  ) {
    await handleJoin(roomCode, displayName, roomName);
    createJoinOpen = false;
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

  $effect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => {
      isMobile = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
</script>

<svelte:window onpopstate={handlePopState} />

<QueryClientProvider client={queryClient}>
  {#if identityStore.loading && !identityStore.keypair}
    <div class="min-h-screen bg-background flex items-center justify-center">
      <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
    </div>
  {:else if joiningRoom}
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
      <RoomSidebar
        rooms={roomsStore.rooms}
        {activeRoomCode}
        unreadCounts={roomsStore.unreadCounts}
        isOpen={sidebarOpen}
        onClose={() => (sidebarOpen = false)}
        onSelectRoom={handleSelectRoom}
        onRemoveRoom={handleRemoveRoom}
        onOpenCreateJoin={openCreateJoin}
      />
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
          {#if incomingSharedFiles.length > 0 || incomingSharedText}
            <Dialog.Root open={incomingSharedFiles.length > 0 || !!incomingSharedText}>
              <Dialog.Portal>
                <Dialog.Overlay
                  class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                />
                <Dialog.Content
                  class="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg"
                >
                  {#if incomingSharedText && incomingSharedFiles.length === 0}
                    <Dialog.Title class="text-lg font-semibold">
                      Sharing text
                    </Dialog.Title>
                  {:else if incomingSharedFiles.length > 0}
                    <Dialog.Title class="text-lg font-semibold">
                      Sending {incomingSharedFiles.length} file{incomingSharedFiles.length ===
                      1
                        ? ""
                        : "s"}
                    </Dialog.Title>
                  {/if}

                  {#if roomsStore.rooms.length > 0}
                    <Dialog.Description
                      class="mt-1 text-sm text-muted-foreground"
                    >
                      Choose a room to send to
                    </Dialog.Description>
                    <div class="mt-4 flex flex-col gap-2">
                      {#each roomsStore.rooms as room (room.roomCode)}
                        <button
                          type="button"
                          class="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
                          onclick={() => handleSelectRoom(room.roomCode)}
                        >
                          <span class="font-medium"
                            >{room.name || room.roomCode}</span
                          >
                          <span class="text-xs text-muted-foreground"
                            >{room.roomCode.slice(0, 8)}...</span
                          >
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <p class="mt-4 text-sm text-muted-foreground">
                      No rooms available. Join or create a room first.
                    </p>
                  {/if}
                  <Dialog.Close
                    class="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
                  >
                    <X class="size-4" />
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          {/if}
          <RoomCreateJoin
            toggleSidebar={() => {
              sidebarOpen = !sidebarOpen;
            }}
            onJoin={handleJoin}
            error={joinError}
          />
        {/if}
      </div>
      <ReloadPrompt />
      <InstallPrompt />

      <Dialog.Root bind:open={createJoinOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          />
          <Dialog.Content
            class="fixed w-sm top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 p-0 border-0 [&>div]:bg-transparent [&>div]:min-h-0 [&>div]:p-0"
          >
            <RoomCreateJoin onJoin={handleJoinFromModal} error={joinError} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  {/if}
</QueryClientProvider>
