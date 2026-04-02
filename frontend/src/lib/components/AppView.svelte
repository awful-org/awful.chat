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
    connect,
    openDmConversation,
    dmConversationCodeFor,
    removeDmConversation,
    addToPhonebook,
    removeFromPhonebook,
    peerIdToDid,
  } from "$lib/transport.svelte";
  import {
    roomsStore,
    loadRooms,
    saveRoom,
    removeRoom,
    refreshPhonebook,
    refreshDmRooms,
  } from "$lib/rooms.svelte";
  import {
    getMessages,
    getUnreadCount,
    getPeerProfile,
    putPhonebookEntry,
    type PhonebookEntry,
  } from "$lib/storage";
  import { loadProfile } from "$lib/profile.svelte";
  import { consumeLatestSharedPayload } from "$lib/share-target";
  import ReloadPrompt from "./ReloadPrompt.svelte";
  import InstallPrompt from "./InstallPrompt.svelte";
  import { Dialog } from "bits-ui";
  import { Star, StarOff, Trash2, Users, X } from "@lucide/svelte";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";

  const queryClient = new QueryClient();

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : null;
  }

  let pendingRoomCode = $state<string | null>(
    parseRoomCode(window.location.pathname)
  );

  let joiningRoom = $state(false);
  let bootstrapped = $state(false);

  $effect(() => {
    if (!identityStore.isUnlocked || bootstrapped) return;
    bootstrapped = true;
    connect();
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
  });

  $effect(() => {
    if (!identityStore.isUnlocked) return;
    consumeSharedIfPresent().catch(() => {});
  });

  let activeRoomCode = $state<string | null>(null);
  let activeRoomName = $state<string>("");
  let activeDmPeerId = $state<string | null>(null);
  let sidebarTab = $state<"rooms" | "users">("rooms");
  let dmPreviews = $state(new Map<string, { text: string; ts: number }>());
  let dmInbox = $state(
    new Map<
      string,
      {
        roomCode: string;
        peerId: string;
        nickname: string;
        avatarUrl: string | null;
        ts: number;
        text: string;
      }
    >()
  );
  let dmUnread = $state(new Map<string, number>());
  let dmBuildRun = 0;
  const dmUnreadTotal = $derived(
    [...dmUnread.values()].reduce((sum, n) => sum + n, 0)
  );
  const dmLatestByPeer = $derived.by(() => {
    const byPeer = new Map<
      string,
      typeof dmInbox extends Map<any, infer V> ? V : never
    >();
    for (const entry of dmInbox.values()) {
      const current = byPeer.get(entry.peerId);
      if (!current || entry.ts > current.ts) byPeer.set(entry.peerId, entry);
    }
    return byPeer;
  });
  const dmUnreadByPeer = $derived.by(() => {
    const byPeer = new Map<string, number>();
    for (const [roomCode, count] of dmUnread) {
      const entry = dmInbox.get(roomCode);
      if (!entry) continue;
      byPeer.set(entry.peerId, (byPeer.get(entry.peerId) ?? 0) + count);
    }
    return byPeer;
  });
  let lockedView = $state<"unlock" | "restore">("unlock");
  let sidebarOpen = $state(false);
  let joinError = $state<string | null>(null);
  let createJoinOpen = $state(false);
  let phonebookOpen = $state(false);
  let isMobile = $state(false);
  let incomingSharedFiles = $state<File[]>([]);
  let incomingSharedText = $state("");

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
      activeDmPeerId = null;
      sidebarTab = "rooms";
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
    activeDmPeerId = null;
    history.pushState({}, "", "/app");
  }

  async function handleCloseDmView() {
    activeRoomCode = null;
    activeRoomName = "";
    activeDmPeerId = null;
    transportState.chatMode = "room";
    transportState.activeDmPeerId = null;
    transportState.roomName = "";
    await refreshDmRooms();
    history.pushState({}, "", "/app");
  }

  async function handleRemoveRoom(code?: string) {
    if (!code) code = activeRoomCode!;
    await removeRoom(code);
    if (activeRoomCode === code) {
      handleLeave();
    }
  }

  async function handleSelectRoom(code: string) {
    if (code === activeRoomCode) {
      sidebarOpen = false;
      return;
    }
    const room = roomsStore.rooms.find((r) => r.roomCode === code);
    if (
      transportState.roomCode === code &&
      transportState.chatMode === "room"
    ) {
      activeRoomCode = code;
      activeRoomName = room?.name || code;
      activeDmPeerId = null;
      sidebarTab = "rooms";
      sidebarOpen = false;
      return;
    }
    await handleJoin(code, "", room?.name);
    activeDmPeerId = null;
    sidebarTab = "rooms";
    sidebarOpen = false;
  }

  function dmTitleFor(peerId: string): string {
    const did = peerIdToDid(peerId);
    return (
      roomsStore.phonebook.find((p) => p.peerId === peerId)?.nickname ||
      transportState.peerNames.get(did) ||
      transportState.peerNames.get(peerId) ||
      dmLatestByPeer.get(peerId)?.nickname ||
      peerId.slice(0, 12)
    );
  }

  async function handleSelectDm(peerId: string) {
    await openDmConversation(peerId);
    const resolvedPeerId = transportState.activeDmPeerId;
    if (!resolvedPeerId) return;
    // Normalize to DID since dmInbox uses participantDid which is always a DID
    const normalizedPeerId = peerIdToDid(resolvedPeerId) || resolvedPeerId;
    // After openDmConversation, the roomCode is set in transportState
    activeRoomCode =
      transportState.roomCode ??
      dmLatestByPeer.get(normalizedPeerId)?.roomCode ??
      (await dmConversationCodeFor(normalizedPeerId));
    activeRoomName = dmTitleFor(normalizedPeerId);
    transportState.roomName = activeRoomName;
    activeDmPeerId = normalizedPeerId;
    sidebarTab = "users";
    sidebarOpen = false;
    history.pushState({}, "", "/app");
    await refreshDmRooms();
    const dmCode = activeRoomCode;
    if (!dmCode) return;
    const msgs = await getMessages(dmCode);
    const latest = msgs[msgs.length - 1];
    if (latest) {
      await markSeenForDm(dmCode, latest.lamport);
    }
  }

  async function markSeenForDm(
    roomCode: string,
    lamport: number
  ): Promise<void> {
    const { markRoomSeen } = await import("$lib/storage");
    await markRoomSeen(roomCode, lamport);
    const next = new Map(dmUnread);
    next.set(roomCode, 0);
    dmUnread = next;
    const dmRoomIndex = roomsStore.dmRooms.findIndex(
      (r) => r.roomCode === roomCode
    );
    if (dmRoomIndex !== -1) {
      roomsStore.dmRooms[dmRoomIndex] = {
        ...roomsStore.dmRooms[dmRoomIndex],
        lastSeenLamport: lamport,
      };
    }
    transportState.dmVersion += 1;
  }

  async function handleRemoveDm(peerId: string) {
    if (activeDmPeerId === peerId && isDmActive) {
      await handleCloseDmView();
    }
    await removeDmConversation(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
    dmPreviews.delete(peerId);
    dmPreviews = new Map(dmPreviews);
    const nextInbox = new Map(dmInbox);
    for (const [roomCode, entry] of dmInbox) {
      if (entry.peerId === peerId) nextInbox.delete(roomCode);
    }
    dmInbox = nextInbox;
    const nextUnread = new Map(dmUnread);
    for (const [roomCode, entry] of dmInbox) {
      if (entry.peerId === peerId) nextUnread.delete(roomCode);
    }
    dmUnread = nextUnread;
    if (activeDmPeerId === peerId) {
      activeDmPeerId = null;
      activeRoomCode = null;
      activeRoomName = "";
      transportState.roomName = "";
    }
  }

  async function handleAddToPhonebook(peerId: string) {
    await addToPhonebook(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
  }

  async function handleRemoveFromPhonebook(peerId: string) {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
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
      const room = roomsStore.rooms.find((r) => r.roomCode === code);
      handleJoin(code, "", room?.name);
    } else if (!code && activeRoomCode) {
      activeRoomCode = null;
      activeRoomName = "";
      activeDmPeerId = null;
      transportState.chatMode = "room";
      transportState.activeDmPeerId = null;
      transportState.roomName = "";
    }
  }

  const myId = $derived(selfId());
  const hasSidebar = $derived(roomsStore.rooms.length > 0);
  const isDmActive = $derived(transportState.chatMode === "dm");
  const dmEntries = $derived.by(() => {
    const map = new Map<
      string,
      {
        peerId: string;
        nickname: string;
        avatarUrl?: string | null;
        addedAt: number;
        inPhonebook: boolean;
      }
    >();
    const phonebookByPeer = new Map<string, PhonebookEntry>(
      roomsStore.phonebook.map((p) => [p.peerId, p])
    );
    for (const [_, data] of dmInbox) {
      const peerId = data.peerId;
      const pb = phonebookByPeer.get(peerId);
      const did = peerIdToDid(peerId);
      if (!map.has(peerId)) {
        map.set(peerId, {
          peerId,
          nickname:
            transportState.peerNames.get(did) ||
            transportState.peerNames.get(peerId) ||
            pb?.nickname ||
            data.nickname,
          avatarUrl:
            transportState.peerAvatars.get(did) ||
            transportState.peerAvatars.get(peerId) ||
            data.avatarUrl,
          addedAt: data.ts,
          inPhonebook: !!pb,
        });
      }
      if (!dmPreviews.has(peerId) && data.text) {
        dmPreviews.set(peerId, { text: data.text, ts: data.ts });
      }
    }
    return [...map.values()].sort((a, b) => {
      const aFav = !!roomsStore.phonebook.find((p) => p.peerId === a.peerId)
        ?.favorite;
      const bFav = !!roomsStore.phonebook.find((p) => p.peerId === b.peerId)
        ?.favorite;
      if (aFav !== bFav) return aFav ? -1 : 1;
      return b.addedAt - a.addedAt;
    });
  });

  async function toggleFavorite(peerId: string) {
    const existing = roomsStore.phonebook.find((p) => p.peerId === peerId);
    if (!existing) return;
    await putPhonebookEntry({ ...existing, favorite: !existing.favorite });
    await refreshPhonebook();
  }

  async function removePhonebookContact(peerId: string) {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
  }

  const sortedPhonebook = $derived.by(() => {
    return [...roomsStore.phonebook]
      .map((entry) => {
        const did = peerIdToDid(entry.peerId);
        return {
          ...entry,
          nickname:
            transportState.peerNames.get(did) ||
            transportState.peerNames.get(entry.peerId) ||
            dmInbox.get(entry.peerId)?.nickname ||
            entry.nickname,
          avatarUrl:
            transportState.peerAvatars.get(did) ||
            transportState.peerAvatars.get(entry.peerId) ||
            dmInbox.get(entry.peerId)?.avatarUrl ||
            null,
        };
      })
      .sort((a, b) => {
        const favDiff = Number(!!b.favorite) - Number(!!a.favorite);
        if (favDiff !== 0) return favDiff;
        return a.nickname.localeCompare(b.nickname);
      });
  });

  $effect(() => {
    if (!identityStore.isUnlocked) return;
    refreshPhonebook().catch(() => {});
    refreshDmRooms().catch(() => {});
  });

  $effect(() => {
    roomsStore.dmRooms.length;
    transportState.messages.length;
    transportState.dmVersion;
    transportState.peerNames.size;
    transportState.peerAvatars.size;
    (async () => {
      const run = ++dmBuildRun;
      const next = new Map<string, { text: string; ts: number }>();
      const nextInbox = new Map<
        string,
        {
          roomCode: string;
          peerId: string;
          nickname: string;
          avatarUrl: string | null;
          ts: number;
          text: string;
        }
      >();
      const unreadNext = new Map<string, number>();

      for (const room of roomsStore.dmRooms) {
        const peerId = room.participantDid;
        if (!peerId) continue;

        const did = peerIdToDid(peerId);
        let source = await getMessages(room.roomCode);

        const activeDid = peerIdToDid(transportState.activeDmPeerId ?? "");
        const roomDid = peerIdToDid(peerId);
        if (transportState.chatMode === "dm" && activeDid === roomDid) {
          source = transportState.messages;
        }

        const last = source[source.length - 1];
        const profile = await getPeerProfile(did).catch(() => undefined);
        const firstRemote = source.find(
          (m) => m.senderId !== selfId() && m.senderName !== "You"
        );
        const messageDid = firstRemote?.senderId;
        const messageProfile = messageDid
          ? await getPeerProfile(messageDid).catch(() => undefined)
          : undefined;

        const nickname =
          messageProfile?.nickname ||
          transportState.peerNames.get(did) ||
          transportState.peerNames.get(peerId) ||
          profile?.nickname ||
          peerId.slice(0, 12);
        const avatarUrl =
          messageProfile?.pfpURL ||
          transportState.peerAvatars.get(did) ||
          transportState.peerAvatars.get(peerId) ||
          profile?.pfpURL ||
          null;

        nextInbox.set(room.roomCode, {
          roomCode: room.roomCode,
          peerId,
          nickname,
          avatarUrl,
          ts: last?.timestamp ?? room.createdAt,
          text: last?.content || (last?.type === "file" ? "[file]" : ""),
        });

        if (last) {
          next.set(peerId, {
            text:
              last.content || (last.type === "file" ? "[file]" : "(message)"),
            ts: last.timestamp,
          });
        }

        const self = selfId();
        const unread = await getUnreadCount(
          room.roomCode,
          room.lastSeenLamport,
          self
        );
        unreadNext.set(room.roomCode, unread);
      }

      if (run !== dmBuildRun) return;
      dmPreviews = next;
      dmInbox = nextInbox;
      dmUnread = unreadNext;
    })().catch(() => {});
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
        phonebook={dmEntries}
        {dmPreviews}
        dmUnreadCounts={dmUnreadByPeer}
        {dmUnreadTotal}
        {activeRoomCode}
        {activeDmPeerId}
        activeTab={sidebarTab}
        onChangeTab={(tab) => (sidebarTab = tab)}
        unreadCounts={roomsStore.unreadCounts}
        isOpen={sidebarOpen}
        onClose={() => (sidebarOpen = false)}
        onSelectRoom={handleSelectRoom}
        onSelectDm={handleSelectDm}
        onAddToPhonebook={handleAddToPhonebook}
        onRemoveFromPhonebook={handleRemoveFromPhonebook}
        onRemoveDmConversation={handleRemoveDm}
        onRemoveRoom={handleRemoveRoom}
        onOpenCreateJoin={openCreateJoin}
        onOpenPhonebook={() => (phonebookOpen = true)}
      />
      <div class="flex-1 min-w-0">
        {#if activeRoomCode}
          <ChatView
            roomCode={activeRoomCode}
            roomName={transportState.roomName || activeRoomName}
            selfId={myId}
            onLeave={() =>
              isDmActive && activeDmPeerId
                ? handleRemoveDm(activeDmPeerId)
                : handleRemoveRoom()}
            onOpenSidebar={hasSidebar ? () => (sidebarOpen = true) : undefined}
            onOpenDm={handleSelectDm}
            {incomingSharedFiles}
            {incomingSharedText}
            onConsumeIncomingShared={clearIncomingShared}
          />
        {:else}
          {#if incomingSharedFiles.length > 0 || incomingSharedText}
            <Dialog.Root
              open={incomingSharedFiles.length > 0 || !!incomingSharedText}
            >
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

      {#if isMobile}
        <Drawer
          open={phonebookOpen}
          onOpenChange={(v) => (phonebookOpen = v)}
          direction="bottom"
        >
          <DrawerContent
            class="bg-card text-card-foreground overflow-hidden h-2/3"
          >
            <DrawerHeader class="px-4 py-3 border-b border-border shrink-0">
              <DrawerTitle class="m-auto font-semibold flex items-center gap-2">
                <Users class="size-4 text-muted-foreground" />
                Phonebook
              </DrawerTitle>
            </DrawerHeader>
            <div class="p-3 overflow-y-auto space-y-2">
              {#each sortedPhonebook as entry (entry.peerId)}
                <div
                  class="flex items-center gap-2 rounded-md border border-border p-2"
                >
                  <div
                    class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold flex items-center justify-center shrink-0"
                  >
                    {#if entry.avatarUrl}
                      <img
                        src={entry.avatarUrl}
                        alt={entry.nickname}
                        class="size-full object-cover"
                      />
                    {:else}
                      {entry.nickname.charAt(0).toUpperCase()}
                    {/if}
                  </div>
                  <button
                    class="min-w-0 flex-1 text-left"
                    onclick={() => {
                      phonebookOpen = false;
                      handleSelectDm(entry.peerId);
                    }}
                  >
                    <div class="truncate text-sm font-medium">
                      {entry.nickname}
                    </div>
                    <div class="truncate text-xs text-muted-foreground">
                      {entry.peerId.slice(0, 16)}
                    </div>
                  </button>
                  <button
                    class="size-8 inline-flex items-center justify-center"
                    onclick={() => toggleFavorite(entry.peerId)}
                  >
                    {#if entry.favorite}
                      <Star class="size-4 text-yellow-500" />
                    {:else}
                      <StarOff class="size-4 text-muted-foreground" />
                    {/if}
                  </button>
                  <button
                    class="size-8 inline-flex items-center justify-center"
                    onclick={() => removePhonebookContact(entry.peerId)}
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </button>
                </div>
              {/each}
            </div>
          </DrawerContent>
        </Drawer>
      {:else}
        <Dialog.Root
          open={phonebookOpen}
          onOpenChange={(v) => (phonebookOpen = v)}
        >
          <Dialog.Portal>
            <Dialog.Overlay
              class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            />
            <Dialog.Content
              class="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg"
            >
              <Dialog.Title
                class="text-lg font-semibold flex items-center gap-2"
              >
                <Users class="size-4" />
                Phonebook
              </Dialog.Title>
              <div class="mt-4 max-h-96 overflow-y-auto space-y-2">
                {#each sortedPhonebook as entry (entry.peerId)}
                  <div
                    class="flex items-center gap-2 rounded-md border border-border p-2"
                  >
                    <div
                      class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold flex items-center justify-center shrink-0"
                    >
                      {#if entry.avatarUrl}
                        <img
                          src={entry.avatarUrl}
                          alt={entry.nickname}
                          class="size-full object-cover"
                        />
                      {:else}
                        {entry.nickname.charAt(0).toUpperCase()}
                      {/if}
                    </div>
                    <button
                      class="min-w-0 flex-1 text-left"
                      onclick={() => {
                        phonebookOpen = false;
                        handleSelectDm(entry.peerId);
                      }}
                    >
                      <div class="truncate text-sm font-medium">
                        {entry.nickname}
                      </div>
                      <div class="truncate text-xs text-muted-foreground">
                        {entry.peerId.slice(0, 16)}
                      </div>
                    </button>
                    <button
                      class="size-8 inline-flex items-center justify-center"
                      onclick={() => toggleFavorite(entry.peerId)}
                    >
                      {#if entry.favorite}
                        <Star class="size-4 text-yellow-500" />
                      {:else}
                        <StarOff class="size-4 text-muted-foreground" />
                      {/if}
                    </button>
                    <button
                      class="size-8 inline-flex items-center justify-center"
                      onclick={() => removePhonebookContact(entry.peerId)}
                    >
                      <Trash2 class="size-4 text-destructive" />
                    </button>
                  </div>
                {/each}
              </div>
              <Dialog.Close
                class="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
              >
                <X class="size-4" />
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      {/if}
    </div>
  {/if}
</QueryClientProvider>
