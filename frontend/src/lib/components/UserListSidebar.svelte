<script lang="ts">
  import {
    transportState,
    peerIdToDid,
    didToPeerId,
    selfId,
    isRelayed,
    openDmConversation,
    addToPhonebook,
    removeFromPhonebook,
  } from "$lib/transport.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { identityStore } from "$lib/identity.svelte";
  import { UserPlus, UserRoundMinus, Users, Workflow } from "@lucide/svelte";
  import { roomsStore, refreshPhonebook } from "$lib/rooms.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";

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
    isOnline: boolean;
    isSelf: boolean;
    isRelayed: boolean;
  }

  const roomUsers = $derived(transportState.roomUsers);
  const peers = $derived(transportState.peers);
  const peerNames = $derived(transportState.peerNames);
  const peerAvatars = $derived(transportState.peerAvatars);

  const selfDid = $derived(selfId());
  const ownDid = $derived(identityStore.did);

  $effect(() => {
    loadProfile();
  });

  const users = $derived.by(() => {
    const allUsers: User[] = [];

    for (const did of roomUsers) {
      const isSelf = did === selfDid || did === ownDid;
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

      if (isSelf) {
        name = profileStore.nickname || "You";
        avatarUrl = profileStore.avatarUrl || null;
      } else {
        name = peerNames.get(did) || did.slice(0, 12);
        avatarUrl = peerAvatars.get(did) || null;
      }

      allUsers.push({
        did,
        peerId: mappedPeerId,
        name,
        avatarUrl,
        isOnline,
        isSelf,
        isRelayed: userIsRelayed,
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

  const onlineUsers = $derived(users.filter((u) => u.isOnline));
  const offlineUsers = $derived(users.filter((u) => !u.isOnline));

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
    return name.charAt(0).toUpperCase();
  }

  function looksLikePeerId(value: string): boolean {
    return value.startsWith("12D3") || value.startsWith("Qm");
  }

  let userMenu = $state<{ user: User; x: number; y: number } | null>(null);

  function openUserMenu(e: MouseEvent, user: User): void {
    if (user.isSelf) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = clampMenuPosition(e.clientX, e.clientY);
    userMenu = { user, x: pos.x, y: pos.y };
  }

  function openUserMenuAtElement(
    e: MouseEvent,
    user: User,
    el: HTMLElement | null
  ): void {
    e.preventDefault();
    e.stopPropagation();
    if (user.isSelf || !el) return;
    const rect = el.getBoundingClientRect();
    const pos = clampMenuPosition(
      e.clientX || rect.left + Math.min(220, rect.width * 0.6),
      e.clientY || rect.top + rect.height * 0.6
    );
    userMenu = {
      user,
      x: pos.x,
      y: pos.y,
    };
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
    return roomsStore.phonebook.some((entry) => entry.peerId === peerId);
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
      await onOpenDm(peerId);
    } else {
      await openDmConversation(peerId);
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
    tabindex="0"
    oncontextmenu={(e) => openUserMenu(e, user)}
    onclick={(e) =>
      openUserMenuAtElement(e, user, e.currentTarget as HTMLElement)}
    onkeydown={(e) => {
      if (!user.isSelf && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openUserMenuAtElement(
          e as unknown as MouseEvent,
          user,
          e.currentTarget as HTMLElement
        );
      }
    }}
    class="flex items-center ml-2 gap-3 px-2 py-1.5 rounded-md transition-colors {user.isOnline
      ? 'hover:bg-muted/50'
      : 'opacity-60 hover:bg-muted/30'}"
  >
    <div class="relative shrink-0">
      <div
        class="size-8 rounded-full overflow-hidden flex items-center justify-center text-xs font-semibold
          {user.isSelf
          ? 'bg-primary/20 text-primary'
          : 'bg-secondary text-secondary-foreground'}"
      >
        {#if user.avatarUrl}
          <img
            src={user.avatarUrl}
            alt={user.name}
            class="size-full object-cover"
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
      <div
        class="text-sm font-medium truncate {user.isSelf
          ? 'text-primary'
          : ''} flex items-center gap-1"
      >
        {user.isSelf ? `${user.name} (You)` : user.name}
        {#if user.isRelayed}
          <Workflow class="size-3 text-blue-500 shrink-0" />
        {/if}
      </div>
      <div class="text-xs text-muted-foreground truncate">
        {user.isOnline ? "Online" : "Offline"}
      </div>
    </div>
  </div>
{/snippet}

{#snippet SectionDivider(label: string, count: number)}
  <div class="flex items-center gap-2 px-2 py-1.5">
    <span
      class="text-xs font-semibold text-muted-foreground uppercase tracking-wide"
      >{label}</span
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
      <ScrollArea class="flex-1 overflow-y-auto">
        {@render UserListContent()}
      </ScrollArea>
    </DrawerContent>
  </Drawer>
{:else if open}
  <aside
    class="w-60 border-l border-border bg-background flex flex-col h-full shrink-0"
  >
    <div class="border-b border-border p-3 flex items-center gap-2">
      <Users class="size-4 text-muted-foreground" />
      <span class="text-sm font-medium">Users</span>
      <Badge variant="secondary" class="text-muted-foreground"
        >{users.length}</Badge
      >
    </div>
    <ScrollArea class="flex-1">
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
  >
    <button
      type="button"
      disabled={!userMenu.user.peerId}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted cursor-pointer"
      onclick={() =>
        userMenu?.user.peerId && handleOpenDm(userMenu.user.peerId)}
    >
      <Users class="size-4" />
      {userMenu.user.peerId ? "DM user" : "DM unavailable"}
    </button>
    {#if userMenu.user.peerId && !isInPhonebook(userMenu.user.peerId)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted cursor-pointer"
        onclick={() =>
          userMenu?.user.peerId && handleAddToPhonebook(userMenu.user.peerId)}
      >
        <UserPlus class="size-4" />
        Add to phonebook
      </button>
    {:else if userMenu.user.peerId}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-muted cursor-pointer"
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
