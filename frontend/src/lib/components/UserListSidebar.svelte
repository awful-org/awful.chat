<script lang="ts">
  import {
    transportState,
    peerIdToDid,
    didToPeerId,
    selfId,
    peerId as selfPeerId,
    isRelayed,
    getRoomUsers,
  } from "$lib/transport/transport.svelte";
  import { looksLikePeerId } from "$lib/identity/identity-utils";
  import {
    openDmPanel,
    addToPhonebook,
    removeFromPhonebook,
  } from "$lib/transport/dm.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import GifImage from "./GifImage.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import {
    Headphones,
    UserPlus,
    UserRoundMinus,
    Users,
    Workflow,
  } from "@lucide/svelte";
  import { roomsStore, refreshPhonebook } from "$lib/rooms.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Tip } from "$lib/components/ui/tooltip";
  import { nameEffectStyle } from "$lib/name-effect";
  import { RELAY_TIP } from "$lib/copy";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
  import UserProfileCard from "./UserProfileCard.svelte";
  import { openSettings } from "$lib/ui-state.svelte";

  interface Props {
    open: boolean;
    onToggle: () => void;
    onOpenDm?: (peerId: string) => void;
  }

  let { open, onToggle, onOpenDm }: Props = $props();

  interface User {
    did: string;
    peerId: string | null;
    name: string;
    avatarUrl: string | null;
    color: string | null;
    nameEffect: string | null;
    gradient2: string | null;
    gradient3: string | null;
    tagText: string | null;
    tagTextColor: string | null;
    tagChipColor: string | null;
    isOnline: boolean;
    isSelf: boolean;
    isRelayed: boolean;
    inCall: boolean;
    sharing: boolean;
  }

  const roomUsers = $derived(transportState.roomUsers);
  const peers = $derived(transportState.peers);
  const peerNames = $derived(transportState.peerNames);
  const peerAvatars = $derived(transportState.peerAvatars);
  const peerColors = $derived(transportState.peerColors);
  const peerProfileMeta = $derived(transportState.peerProfileMeta);

  const selfDid = $derived(selfId());
  const ownDid = $derived(identityStore.did);

  $effect(() => {
    loadProfile();
    getRoomUsers();
  });

  const users = $derived.by(() => {
    const allUsers: User[] = [];

    for (const did of roomUsers) {
      const isSelf =
        did === selfDid || did === ownDid || did === selfPeerId();
      const connectedPeerId = peers.find(
        (peerId) => peerIdToDid(peerId) === did
      );
      const mappedPeerId =
        connectedPeerId ??
        didToPeerId(did) ??
        (looksLikePeerId(did) ? did : null);
      const directlyConnected = peers.includes(did);
      const isOnline =
        isSelf ||
        !!connectedPeerId ||
        directlyConnected ||
        (!!mappedPeerId && peers.includes(mappedPeerId));
      const relayedPeerId = connectedPeerId ?? mappedPeerId;
      const userIsRelayed =
        !!relayedPeerId && isOnline && isRelayed(relayedPeerId);

      let name: string;
      let avatarUrl: string | null = null;
      let color: string | null = null;
      let nameEffect: string | null = null;
      let gradient2: string | null = null;
      let gradient3: string | null = null;
      let tagText: string | null = null;
      let tagTextColor: string | null = null;
      let tagChipColor: string | null = null;

      if (isSelf) {
        name = profileStore.nickname || "You";
        avatarUrl = profileStore.avatarUrl || null;
        color = profileStore.color || null;
        nameEffect = profileStore.nameEffect || null;
        gradient2 = profileStore.gradient2 || null;
        gradient3 = profileStore.gradient3 || null;
        tagText = profileStore.tagText || null;
        tagTextColor = profileStore.tagTextColor || null;
        tagChipColor = profileStore.tagChipColor || null;
      } else {
        // roomUsers can carry a raw peerId while these maps are DID-keyed.
        const nameKey = peerIdToDid(did) || did;
        name = peerNames.get(nameKey) || peerNames.get(did) || did.slice(0, 12);
        avatarUrl = peerAvatars.get(nameKey) || peerAvatars.get(did) || null;
        color =
          displayPrefs.showPeerNicknameColors
            ? peerColors.get(nameKey) || peerColors.get(did) || null
            : null;
        // Name effect: respect showPeerNicknameColors like color does
        nameEffect = displayPrefs.showPeerNicknameColors
          ? peerProfileMeta.get(nameKey)?.nameEffect || peerProfileMeta.get(did)?.nameEffect || null
          : null;
        // The tag is content like the name, not decoration - it ignores the
        // colors pref.
        const meta = peerProfileMeta.get(nameKey) ?? peerProfileMeta.get(did);
        gradient2 = meta?.gradient2 || null;
        gradient3 = meta?.gradient3 || null;
        tagText = meta?.tagText || null;
        tagTextColor = meta?.tagTextColor || null;
        tagChipColor = meta?.tagChipColor || null;
      }

      // In a call in THIS room: presence is announced per peer, self via
      // local state. Grouped separately in the list, like a voice channel.
      const inCall = isSelf
        ? transportState.inCall &&
          transportState.callRoomCode === transportState.roomCode
        : (!!mappedPeerId &&
            transportState.callPeerRooms.get(mappedPeerId) ===
              transportState.roomCode) ||
          transportState.callPeerRooms.get(did) === transportState.roomCode;

      // A pending entry means they are sharing and we are not watching;
      // watching moves them out of pending and into watchingTransmissionPeerId.
      const sharing = isSelf
        ? transportState.screenSharing
        : [mappedPeerId, did].some(
            (k) =>
              !!k &&
              (transportState.pendingTransmissions.has(k) ||
                transportState.watchingTransmissionPeerId === k)
          );

      allUsers.push({
        did,
        peerId: mappedPeerId,
        name,
        avatarUrl,
        color,
        nameEffect,
        isOnline,
        isSelf,
        isRelayed: userIsRelayed,
        inCall,
        sharing: inCall && sharing,
        tagText,
        tagTextColor,
        tagChipColor,
        gradient2,
        gradient3,
      });
    }

    return allUsers.sort((a, b) => {
      if (a.isSelf && !b.isSelf) return -1;
      if (!a.isSelf && b.isSelf) return 1;
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.name.localeCompare(b.name);
    });
  });

  const inCallUsers = $derived(users.filter((u) => u.inCall));
  const onlineUsers = $derived(users.filter((u) => u.isOnline && !u.inCall));
  const offlineUsers = $derived(users.filter((u) => !u.isOnline && !u.inCall));

  let isMobile = $state(false);

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

  function getInitials(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }

  let userMenu = $state<{ user: User; x: number; y: number } | null>(null);
  let selectedUserForProfile = $state<User | null>(null);

  function openUserMenu(e: MouseEvent, user: User): void {
    if (user.isSelf) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = clampMenuPosition(e.clientX, e.clientY);
    userMenu = { user, x: pos.x, y: pos.y };
  }

  function openProfileCard(user: User): void {
    selectedUserForProfile = user;
  }

  function clampMenuPosition(x: number, y: number): { x: number; y: number } {
    if (typeof window === "undefined") return { x, y };
    const menuWidth = 250;
    const menuHeight = 170;
    let adjustedX = x;
    if (x + menuWidth > window.innerWidth) {
      adjustedX = x - menuWidth;
    }
    if (adjustedX < 0) adjustedX = 0;
    const adjustedY = Math.max(0, Math.min(y, window.innerHeight - menuHeight));
    return { x: adjustedX, y: adjustedY };
  }

  function closeUserMenu(): void {
    userMenu = null;
  }

  function isInPhonebook(peerId: string): boolean {
    // An entry may be keyed by peerId or DID; compare every form.
    const did = peerIdToDid(peerId);
    return roomsStore.phonebook.some(
      (entry) =>
        entry.peerId === peerId ||
        entry.did === peerId ||
        (!!did && (entry.peerId === did || entry.did === did))
    );
  }

  async function handleAddToPhonebook(peerId: string): Promise<void> {
    await addToPhonebook(peerId);
    await refreshPhonebook();
    closeUserMenu();
  }

  async function handleRemoveFromPhonebook(peerId: string): Promise<void> {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
    closeUserMenu();
  }

  async function handleOpenDm(peerId: string): Promise<void> {
    if (onOpenDm) {
      onOpenDm(peerId);
    } else {
      // No host to switch the view for us, so the panel: openDmConversation
      // only moves the transport, leaving the pane rendering the room it is
      // still keyed to and the DM invisible.
      await openDmPanel(peerId);
    }
    closeUserMenu();
  }
</script>

<svelte:window
  onclick={closeUserMenu}
  onkeydown={(e) => {
    if (e.key === "Escape") closeUserMenu();
  }}
/>

{#snippet UserItem(user: User)}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    role="button"
    tabindex={user.isSelf ? -1 : 0}
    aria-disabled={user.isSelf}
    oncontextmenu={(e) => openUserMenu(e, user)}
    onclick={() => openProfileCard(user)}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openProfileCard(user);
      }
    }}
    class="flex items-center ml-2 gap-3 px-2 py-1.5 rounded-md transition-colors {user.isSelf
      ? user.isOnline
        ? ''
        : 'opacity-60'
      : user.isOnline
        ? 'hover:bg-muted/50 cursor-pointer'
        : 'opacity-60 hover:bg-muted/30 cursor-pointer'}"
  >
    <div class="relative shrink-0 rounded-full">
      <div
        class="size-8 rounded-full overflow-hidden flex items-center justify-center text-xs font-semibold font-mono
          {user.isSelf
          ? 'bg-primary/20 text-primary'
          : 'bg-secondary text-secondary-foreground'}"
        style={user.color ? `color: ${user.color}` : ""}
      >
        {#if user.avatarUrl}
          <GifImage
            src={user.avatarUrl}
            alt={user.name}
            class="size-full object-cover"
            animate="hover"
          />
        {:else}
          {getInitials(user.name)}
        {/if}
      </div>
      <div
        class="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background {user.isOnline
          ? 'bg-green-500'
          : 'bg-muted-foreground'}"
      ></div>
    </div>
    <div class="min-w-0 flex-1">
      {#if true}
        {@const effectStyle = nameEffectStyle(user.nameEffect ?? undefined, user.color ?? undefined, user.gradient2 ?? undefined, user.gradient3 ?? undefined)}
        <div
          class="text-sm font-medium truncate {user.isSelf
            ? 'text-primary'
            : ''} flex items-center gap-1"
        >
          <!-- Effect on the NAME SPAN only. On the container, rainbow's
               hue-rotate is a filter and filters transform the whole
               subtree - the tag chip's colors rotated with it. -->
          <span
            class="truncate {effectStyle.class}"
            style={effectStyle.style || (user.color ? `color: ${user.color}` : "")}
          >{user.isSelf ? `${user.name} (You)` : user.name}</span>
          {#if user.tagText}
            <span
              class="shrink-0 rounded px-1 py-px font-mono text-[10px] font-semibold uppercase leading-4"
              style={`background-color: ${user.tagChipColor ?? "#e5e7eb"}; color: ${user.tagTextColor ?? "#000000"}`}
            >{user.tagText}</span>
          {/if}
          <!-- Relayed badge: always shown, not gated on showConnectionInfo.
               That setting controls only the floating panel on the right. -->
          {#if user.isRelayed}
            <Tip text={RELAY_TIP}>
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  aria-label="Relayed connection"
                  class="inline-flex shrink-0 cursor-help"
                >
                  <Workflow class="size-3 text-blue-500" />
                </button>
              {/snippet}
            </Tip>
          {/if}
        </div>
      {/if}
      <div class="text-xs truncate {user.inCall
          ? 'text-primary'
          : 'text-muted-foreground'}">
        {user.sharing
          ? "Sharing screen"
          : user.inCall
            ? "In call"
            : user.isOnline
              ? "Online"
              : "Offline"}
      </div>
    </div>
  </div>
{/snippet}

{#snippet SectionDivider(label: string, count: number, Icon?: typeof Users)}
  <!-- The icon slot is always reserved so every section's label and count
       start at the same x, icon or not - ragged headers read as misaligned. -->
  <div class="flex items-center gap-2 px-3 py-1.5">
    {#if Icon}
      <Icon class="size-4 shrink-0 {label === 'In call'
          ? 'text-primary'
          : 'text-muted-foreground'}" />
    {:else}
      <span class="size-4 shrink-0"></span>
    {/if}
    <span
      class="text-xs font-semibold uppercase tracking-wider font-mono {label ===
      'In call'
        ? 'text-primary'
        : 'text-muted-foreground'}">{label}</span
    >
    <Badge variant="secondary" class="text-muted-foreground">{count}</Badge>
  </div>
{/snippet}

{#snippet UserListContent()}
  <div class="p-2 space-y-1">
    {#if users.length === 0}
      <div class="text-center py-8 text-sm text-muted-foreground">
        No users in this room
      </div>
    {:else}
      {#if inCallUsers.length > 0}
        <div class="rounded-lg border border-primary/20 bg-primary/5 pb-1 mb-2">
          {@render SectionDivider("In call", inCallUsers.length, Headphones)}
          {#each inCallUsers as user (user.did)}
            {@render UserItem(user)}
          {/each}
        </div>
      {/if}
      {#if onlineUsers.length > 0}
        {@render SectionDivider("Online", onlineUsers.length)}
        {#each onlineUsers as user (user.did)}
          {@render UserItem(user)}
        {/each}
      {/if}
      {#if offlineUsers.length > 0}
        <div class="pt-1">
          {@render SectionDivider("Offline", offlineUsers.length)}
          {#each offlineUsers as user (user.did)}
            {@render UserItem(user)}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

{#if isMobile}
  <Drawer {open} onOpenChange={onToggle} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground overflow-hidden h-2/3">
      <DrawerHeader class="px-4 py-3 border-b border-border shrink-0">
        <DrawerTitle class="m-auto font-semibold flex items-center gap-2">
          <Users class="size-4 text-muted-foreground" />
          Users
          <Badge variant="secondary" class="text-muted-foreground"
            >{users.length}</Badge
          >
        </DrawerTitle>
      </DrawerHeader>
      <ScrollArea class="flex-1 min-h-0 overflow-y-auto">
        {@render UserListContent()}
      </ScrollArea>
    </DrawerContent>
  </Drawer>
{:else if open}
  <aside
    class="w-60 border-l border-border bg-background flex flex-col h-full shrink-0"
  >
    <div
      class="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3"
    >
      <Users class="size-4 text-muted-foreground" />
      <span class="text-xs font-semibold uppercase tracking-wider font-mono"
        >Users</span
      >
      <Badge variant="secondary" class="text-muted-foreground"
        >{users.length}</Badge
      >
    </div>
    <ScrollArea class="flex-1 min-h-0">
      {@render UserListContent()}
    </ScrollArea>
  </aside>
{/if}

{#if userMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="menu"
    tabindex="-1"
    class="fixed z-50 min-w-40 rounded-md border border-border bg-popover py-1 shadow-xl"
    style="top: {userMenu.y}px; left: {userMenu.x}px"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <button
      type="button"
      disabled={!userMenu.user.peerId}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-muted cursor-pointer"
      onclick={() =>
        userMenu?.user.peerId && handleOpenDm(userMenu.user.peerId)}
    >
      <Users class="size-4" />
      {userMenu.user.peerId ? "Send DM" : "DM unavailable"}
    </button>
    {#if userMenu.user.peerId && !isInPhonebook(userMenu.user.peerId)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-muted cursor-pointer"
        onclick={() =>
          userMenu?.user.peerId && handleAddToPhonebook(userMenu.user.peerId)}
      >
        <UserPlus class="size-4" />
        Add to phonebook
      </button>
    {:else if userMenu.user.peerId}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono text-destructive hover:bg-muted cursor-pointer"
        onclick={() =>
          userMenu?.user.peerId &&
          handleRemoveFromPhonebook(userMenu.user.peerId)}
      >
        <UserRoundMinus class="size-4" />
        Remove from phonebook
      </button>
    {/if}
  </div>
{/if}

{#if selectedUserForProfile}
  <UserProfileCard
    open={!!selectedUserForProfile}
    onOpenChange={(open) => {
      if (!open) selectedUserForProfile = null;
    }}
    did={selectedUserForProfile.did}
    name={selectedUserForProfile.name}
    avatarUrl={selectedUserForProfile.avatarUrl ?? undefined}
    color={selectedUserForProfile.color ?? undefined}
    onEdit={() => openSettings("profile")}
    onMessage={selectedUserForProfile.peerId
      ? () => {
          const pid = selectedUserForProfile!.peerId!;
          selectedUserForProfile = null;
          handleOpenDm(pid);
        }
      : undefined}
    onTogglePhonebook={selectedUserForProfile.peerId
      ? () => {
          const pid = selectedUserForProfile!.peerId!;
          if (isInPhonebook(pid)) handleRemoveFromPhonebook(pid);
          else handleAddToPhonebook(pid);
        }
      : undefined}
    inPhonebook={selectedUserForProfile.peerId
      ? isInPhonebook(selectedUserForProfile.peerId)
      : false}
  />
{/if}
