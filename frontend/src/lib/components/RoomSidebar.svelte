<script lang="ts">
  import type { Room } from "$lib/storage";
  import {
    Hash,
    MessageSquare,
    Plus,
    Trash2,
    User,
    Users,
  } from "@lucide/svelte";
  import SidebarControls from "./SidebarControls.svelte";
  import GifImage from "./GifImage.svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import CallStatus from "./CallStatus.svelte";
  import { transportState, peerIdToDid } from "$lib/transport/transport.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";

  interface DmPreview {
    text: string;
    ts: number;
  }

  interface PhonebookEntry {
    peerId: string;
    nickname: string;
    avatarUrl?: string | null;
    addedAt: number;
    inPhonebook?: boolean;
  }

  type DmContextAction =
    | { type: "add"; peerId: string }
    | { type: "removePhonebook"; peerId: string }
    | { type: "removeConversation"; peerId: string };

  interface Props {
    rooms: Room[];
    phonebook: PhonebookEntry[];
    dmPreviews: Map<string, DmPreview>;
    dmUnreadCounts: Map<string, number>;
    dmUnreadTotal: number;
    activeRoomCode: string | null;
    activeDmPeerId: string | null;
    activeTab: "rooms" | "users";
    onChangeTab: (tab: "rooms" | "users") => void;
    unreadCounts: Map<string, number>;
    roomActivity: Map<string, number>;
    isOpen?: boolean;
    onClose?: () => void;
    onSelectRoom: (code: string) => void;
    onSelectDm: (peerId: string) => void;
    onAddToPhonebook: (peerId: string) => void;
    onRemoveFromPhonebook: (peerId: string) => void;
    onRemoveDmConversation: (peerId: string) => void;
    dmContextActions?: DmContextAction[];
    onRemoveRoom: (code: string) => void;
    onOpenCreateJoin?: () => void;
    onOpenPhonebook?: () => void;
  }

  let {
    rooms,
    phonebook,
    dmPreviews,
    dmUnreadCounts,
    dmUnreadTotal,
    activeRoomCode,
    activeDmPeerId,
    activeTab,
    onChangeTab,
    unreadCounts,
    roomActivity,
    isOpen = false,
    onClose,
    onSelectRoom,
    onSelectDm,
    onAddToPhonebook,
    onRemoveFromPhonebook,
    onRemoveDmConversation,
    dmContextActions,
    onRemoveRoom,
    onOpenCreateJoin,
    onOpenPhonebook,
  }: Props = $props();

  let contextMenu = $state<{ code: string; x: number; y: number } | null>(null);
  let dmContextMenu = $state<{
    peerId: string;
    inPhonebook: boolean;
    x: number;
    y: number;
  } | null>(null);

  // Same clamp the other context menus use, so a right-click near the edge
  // does not render the menu offscreen.
  function clampMenu(x: number, y: number) {
    if (typeof window === "undefined") return { x, y };
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - 168)),
      y: Math.max(8, Math.min(y, window.innerHeight - 96)),
    };
  }

  function openContextMenu(e: MouseEvent, code: string) {
    e.preventDefault();
    contextMenu = { code, ...clampMenu(e.clientX, e.clientY) };
  }

  function closeContextMenu() {
    contextMenu = null;
    dmContextMenu = null;
    confirmingRemove = false;
    confirmingRemoveDm = false;
  }

  const peerColors = $derived(transportState.peerColors);

  function colorForPeer(peerId: string): string | undefined {
    const did = peerIdToDid(peerId);
    if (!displayPrefs.showPeerNicknameColors) return undefined;
    return peerColors.get(peerId) ?? (did ? peerColors.get(did) : undefined);
  }

  // Deleting a room or conversation destroys its stored history, so it takes
  // a second click, like the erase flows in settings.
  let confirmingRemove = $state(false);
  let confirmingRemoveDm = $state(false);

  function openDmContextMenu(
    e: MouseEvent,
    peerId: string,
    inPhonebook: boolean
  ) {
    e.preventDefault();
    e.stopPropagation();
    dmContextMenu = { peerId, inPhonebook, ...clampMenu(e.clientX, e.clientY) };
  }

  function isInPhonebook(peerId: string): boolean {
    return phonebook.some(
      (entry) => entry.peerId === peerId && entry.inPhonebook
    );
  }

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  let href = $state(window.location.href);

  $effect(() => {
    const onPop = () => (href = window.location.href);

    const origPush = history.pushState.bind(history);
    history.pushState = (...args) => {
      origPush(...args);
      href = window.location.href;
    };

    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      history.pushState = origPush;
    };
  });

  let shouldShowAddBtn = $derived(true);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:window
  onclick={closeContextMenu}
  onkeydown={(e) => {
    if (e.key === "Escape") closeContextMenu();
  }}
/>

<!-- Mobile backdrop -->
{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-30 bg-black/50 sm:hidden"
    onclick={onClose}
    aria-hidden="true"
  ></div>
{/if}

<aside
  class="flex h-dvh w-68 shrink-0 flex-col border-r border-sidebar-border bg-sidebar
      fixed inset-y-0 left-0 z-40 transition-transform duration-200
      sm:static sm:translate-x-0 sm:z-auto sm:transition-none
      {isOpen ? 'translate-x-0' : '-translate-x-full'}"
>
  <!-- Header - h-13 is shared with the chat header (ChatView) so they align. -->
  <div
    class="flex h-13 items-center justify-between border-b border-sidebar-border px-3 shrink-0"
  >
    <div class="flex items-center gap-2">
      <MessageSquare class="size-4 text-muted-foreground" />
      <span
        class="text-xs font-semibold text-muted-foreground mt-0.75 uppercase tracking-wider font-mono"
      >
        {activeTab === "rooms" ? "Rooms" : "DMs"}
      </span>
    </div>
    {#if activeTab === "rooms" && onOpenCreateJoin && shouldShowAddBtn}
      <Tip text="Create or join a room" side="bottom">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={onOpenCreateJoin}
            class="inline-flex size-7 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent/40 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
            aria-label="Create or join room"
          >
            <Plus class="size-4" />
          </button>
        {/snippet}
      </Tip>
    {:else if activeTab === "users" && onOpenPhonebook}
      <Tip text="Phonebook" side="bottom">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={onOpenPhonebook}
            class="inline-flex size-7 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent/40 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
            aria-label="Open phonebook"
          >
            <Users class="size-4" />
          </button>
        {/snippet}
      </Tip>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-1 px-2 pt-1.5">
    <button
      type="button"
      class="rounded-md px-2 py-1.5 text-xs font-mono transition-colors cursor-pointer {activeTab ===
      'rooms'
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50'}"
      onclick={() => onChangeTab("rooms")}
    >
      Rooms
    </button>
    <button
      type="button"
      class="rounded-md px-2 py-1.5 text-xs font-mono transition-colors cursor-pointer {activeTab ===
      'users'
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50'}"
      onclick={() => onChangeTab("users")}
    >
      DMs
      {#if dmUnreadTotal > 0}
        <span
          class="ml-1 inline-flex min-w-4.5 h-4.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold items-center justify-center px-1 tabular-nums"
        >
          {Math.min(dmUnreadTotal, 99)}
        </span>
      {/if}
    </button>
  </div>

  <!-- Room list -->
  <div class="flex-1 overflow-y-auto p-1.5">
    {#if activeTab === "rooms" && rooms.length === 0}
      <div
        class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <div class="w-8 opacity-50">
          <Hash class="size-full" />
        </div>
        No rooms yet
      </div>
    {:else if activeTab === "users" && phonebook.length === 0}
      <div
        class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <div class="w-8 opacity-50">
          <User class="size-full" />
        </div>
        No DMs yet
      </div>
    {/if}

    {#if activeTab === "rooms"}
      {#each rooms as room (room.roomCode)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="none"
          oncontextmenu={(e) => openContextMenu(e, room.roomCode)}
        >
          <button
            type="button"
            onclick={() => onSelectRoom(room.roomCode)}
            class="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors cursor-pointer hover:bg-accent/50
              {activeRoomCode === room.roomCode
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground'}"
          >
            <Hash class="mt-0.5 size-3.5 shrink-0 opacity-50" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium font-mono">
                {room.name || room.roomCode}
              </div>
              <div class="truncate text-xs opacity-60 font-mono">
                {timeAgo(roomActivity.get(room.roomCode) ?? room.createdAt)}
              </div>
            </div>
            {#if (unreadCounts.get(room.roomCode) ?? 0) > 0 && activeRoomCode !== room.roomCode}
              <span
                class="ml-auto shrink-0 min-w-4.5 h-4.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1 tabular-nums"
              >
                {Math.min(unreadCounts.get(room.roomCode) ?? 0, 99)}
              </span>
            {/if}
          </button>
        </div>
      {/each}
    {:else}
      {#each phonebook as entry (entry.peerId)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="none"
          oncontextmenu={(e) =>
            openDmContextMenu(e, entry.peerId, !!entry.inPhonebook)}
        >
          <button
            type="button"
            onclick={() => onSelectDm(entry.peerId)}
            class="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors cursor-pointer hover:bg-accent/50
        {activeDmPeerId === entry.peerId
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground'}"
          >
            <div
              class="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground text-xs font-semibold font-mono"
              style={colorForPeer(entry.peerId)
                ? `color: ${colorForPeer(entry.peerId)}`
                : ""}
            >
              {#if entry.avatarUrl}
                <GifImage
                  src={entry.avatarUrl}
                  alt={entry.nickname}
                  class="size-full rounded-full object-cover"
                  animate="hover"
                />
              {:else}
                {(entry.nickname || "?").charAt(0).toUpperCase()}
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <div
                class="truncate text-sm font-medium font-mono"
                style={colorForPeer(entry.peerId)
                  ? `color: ${colorForPeer(entry.peerId)}`
                  : ""}
              >
                {entry.nickname}
              </div>
              <div class="truncate text-xs opacity-60 font-mono">
                {dmPreviews.get(entry.peerId)?.text ||
                  entry.peerId.slice(0, 16)}
              </div>
            </div>
            {#if dmPreviews.get(entry.peerId)?.ts}
              <span class="shrink-0 text-[10px] opacity-60 font-mono">
                {timeAgo(dmPreviews.get(entry.peerId)!.ts)}
              </span>
            {/if}
            {#if (dmUnreadCounts.get(entry.peerId) ?? 0) > 0}
              <span
                class="ml-1 shrink-0 min-w-4.5 h-4.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1 tabular-nums"
              >
                {Math.min(dmUnreadCounts.get(entry.peerId) ?? 0, 99)}
              </span>
            {/if}
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <CallStatus />
  <SidebarControls />
</aside>

{#if contextMenu && activeTab === "rooms"}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="fixed z-50 min-w-35 rounded-md border border-border bg-popover py-1 shadow-xl"
    style="top: {contextMenu.y}px; left: {contextMenu.x}px"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <button
      type="button"
      onclick={() => {
        if (!confirmingRemove) {
          confirmingRemove = true;
          return;
        }
        onRemoveRoom(contextMenu!.code);
        closeContextMenu();
      }}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-muted cursor-pointer font-mono {confirmingRemove
        ? 'bg-destructive/10'
        : ''}"
    >
      <Trash2 class="size-4" />
      {confirmingRemove ? "Click again to confirm" : "Remove room"}
    </button>
  </div>
{/if}

{#if dmContextMenu && activeTab === "users"}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="fixed z-50 min-w-35 rounded-md border border-border bg-popover py-1 shadow-xl"
    style="top: {dmContextMenu.y}px; left: {dmContextMenu.x}px"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each dmContextActions?.length ? dmContextActions : isInPhonebook(dmContextMenu.peerId) ? [{ type: "removePhonebook", peerId: dmContextMenu.peerId }, { type: "removeConversation", peerId: dmContextMenu.peerId }] : [{ type: "add", peerId: dmContextMenu.peerId }, { type: "removeConversation", peerId: dmContextMenu.peerId }] as action}
      <button
        type="button"
        onclick={() => {
          if (action.type === "add") onAddToPhonebook(action.peerId);
          if (action.type === "removePhonebook")
            onRemoveFromPhonebook(action.peerId);
          if (action.type === "removeConversation") {
            if (!confirmingRemoveDm) {
              confirmingRemoveDm = true;
              return;
            }
            onRemoveDmConversation(action.peerId);
          }
          closeContextMenu();
        }}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted cursor-pointer font-mono {action.type ===
          'removeConversation' || action.type === 'removePhonebook'
          ? 'text-destructive'
          : ''}"
      >
        {#if action.type === "add"}
          <User class="size-4" />
          Add to phonebook
        {:else if action.type === "removePhonebook"}
          <Trash2 class="size-4" />
          Remove from phonebook
        {:else}
          <Trash2 class="size-4" />
          {confirmingRemoveDm ? "Click again to confirm" : "Remove conversation"}
        {/if}
      </button>
    {/each}
  </div>
{/if}
