<script lang="ts">
  import type { Room } from "$lib/storage";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { dropIndex, moveItem, slotTop, type RowBox } from "$lib/room-order";
  import {
    GripVertical,
    Hash,
    Pin,
    PinOff,
    MessageSquare,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    Trash2,
    User,
    Users,
  } from "@lucide/svelte";
  import SidebarControls from "./SidebarControls.svelte";
  import PluginWidgetSlots from "./PluginWidgetSlots.svelte";
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
    /** Desktop icon rail. Ignored below sm, where the sidebar is a slide-over. */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    onSelectRoom: (code: string) => void;
    onSelectDm: (peerId: string) => void;
    onAddToPhonebook: (peerId: string) => void;
    onRemoveFromPhonebook: (peerId: string) => void;
    onRemoveDmConversation: (peerId: string) => void;
    dmContextActions?: DmContextAction[];
    onRemoveRoom: (code: string) => void;
    /** Pin or unpin. `rooms` already lists the pinned (pinnedAt) first. */
    onTogglePin: (code: string) => void;
    /** The full room order after a drag or keyboard move, as roomCodes. */
    onReorderRooms: (order: string[]) => void;
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
    collapsed = false,
    onToggleCollapsed,
    onSelectRoom,
    onSelectDm,
    onAddToPhonebook,
    onRemoveFromPhonebook,
    onRemoveDmConversation,
    dmContextActions,
    onRemoveRoom,
    onTogglePin,
    onReorderRooms,
    onOpenCreateJoin,
    onOpenPhonebook,
  }: Props = $props();

  let contextMenu = $state<{ code: string; x: number; y: number } | null>(null);

  // Drag-to-reorder, expanded room list only. The lifted row follows the
  // pointer while the others slide aside (animate:flip on a PREVIEW order);
  // the order is committed once, on drop. Pointer capture on the grip keeps
  // move/up events coming wherever the pointer goes, and the keyed {#each}
  // keeps that grip the same element as its row moves, so capture survives.
  const SETTLE_MS = 180;
  const EDGE_PX = 40;
  const FLIP_MS = 180;

  let listEl = $state<HTMLDivElement | null>(null);
  let drag = $state<{
    code: string;
    /** The order when the drag began; `from`/`to` index into it. */
    base: string[];
    from: number;
    to: number;
    /** Pixels from the row's current slot to where it is drawn. */
    dy: number;
    order: string[];
    /** Released: the pointer no longer moves it. */
    dropping: boolean;
    /** Animating dy to 0, into its slot. */
    gliding: boolean;
  } | null>(null);
  // Pre-drag geometry, in the list's scroll coordinates so auto-scroll does
  // not invalidate it. Not state: nothing renders from it directly.
  let rowBoxes: RowBox[] = [];
  let startContentY = 0;
  let lastClientY = 0;
  let scrollFrame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  // Pinned rooms sit above the rest and do not drag; every index the drag
  // code uses is into `movable`, so nothing can be dropped above a pin.
  const pinnedList = $derived(rooms.filter((r) => r.pinnedAt != null));
  const pinnedSet = $derived(new Set(pinnedList.map((r) => r.roomCode)));
  const movable = $derived(rooms.filter((r) => r.pinnedAt == null));
  const roomsByCode = $derived(new Map(rooms.map((r) => [r.roomCode, r])));
  const displayRooms = $derived(
    drag
      ? drag.order.flatMap((code) => roomsByCode.get(code) ?? [])
      : movable
  );

  function contentY(clientY: number): number {
    const rect = listEl!.getBoundingClientRect();
    return clientY - rect.top + listEl!.scrollTop;
  }

  function startRoomDrag(e: PointerEvent, roomCode: string): void {
    if (e.button !== 0 || !listEl || drag) return;
    const from = movable.findIndex((r) => r.roomCode === roomCode);
    if (from === -1) return;
    const listTop = listEl.getBoundingClientRect().top - listEl.scrollTop;
    rowBoxes = [...listEl.querySelectorAll<HTMLElement>("[data-drag-row]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - listTop, height: r.height };
    });
    if (rowBoxes.length !== movable.length) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    lastClientY = e.clientY;
    startContentY = contentY(e.clientY);
    const base = movable.map((r) => r.roomCode);
    drag = {
      code: roomCode,
      base,
      from,
      to: from,
      dy: 0,
      order: base,
      dropping: false,
      gliding: false,
    };
    navigator.vibrate?.(8);
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function updateDrag(): void {
    if (!drag || drag.dropping) return;
    const delta = contentY(lastClientY) - startContentY;
    const { from } = drag;
    const center = rowBoxes[from].top + rowBoxes[from].height / 2 + delta;
    const to = dropIndex(rowBoxes, from, center);
    if (to !== drag.to) {
      drag.to = to;
      drag.order = moveItem(drag.base, from, to);
    }
    drag.dy = rowBoxes[from].top + delta - slotTop(rowBoxes, from, to);
  }

  function onRoomDragMove(e: PointerEvent): void {
    if (!drag) return;
    lastClientY = e.clientY;
    updateDrag();
  }

  // Dragging near the list's edge scrolls it, so a room can travel further
  // than the part of the list on screen.
  function autoScroll(): void {
    if (!drag || drag.dropping || !listEl) return;
    const rect = listEl.getBoundingClientRect();
    const speed =
      lastClientY < rect.top + EDGE_PX
        ? -Math.ceil((rect.top + EDGE_PX - lastClientY) / 4)
        : lastClientY > rect.bottom - EDGE_PX
          ? Math.ceil((lastClientY - (rect.bottom - EDGE_PX)) / 4)
          : 0;
    if (speed !== 0) {
      listEl.scrollTop += speed;
      updateDrag();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function finishDrag(commit: boolean): void {
    if (!drag || drag.dropping) return;
    cancelAnimationFrame(scrollFrame);
    const d = drag;
    const heldTop = slotTop(rowBoxes, d.from, d.to) + d.dy;
    if (commit && d.to !== d.from) {
      onReorderRooms(d.order);
    } else {
      d.to = d.from;
      d.order = d.base;
    }
    d.dropping = true;
    // A cancel moves the row's slot back under it; keep it drawn where it is
    // held for this frame, then glide it into the slot instead of snapping.
    d.dy = heldTop - slotTop(rowBoxes, d.from, d.to);
    requestAnimationFrame(() => {
      if (drag !== d) return;
      d.gliding = true;
      d.dy = 0;
    });
    settleTimer = setTimeout(() => {
      drag = null;
      settleTimer = null;
    }, SETTLE_MS + 20);
  }

  function endRoomDrag(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    finishDrag(e.type === "pointerup");
  }

  function onDragKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && drag && !drag.dropping) {
      e.preventDefault();
      finishDrag(false);
    }
  }

  // Keyboard reorder on the focused grip: the same move without a pointer.
  function onGripKeydown(e: KeyboardEvent, roomCode: string): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (drag) return;
    const from = movable.findIndex((r) => r.roomCode === roomCode);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (from === -1 || to < 0 || to >= movable.length) return;
    e.preventDefault();
    onReorderRooms(moveItem(movable.map((r) => r.roomCode), from, to));
  }

  function rowStyle(roomCode: string): string {
    if (drag?.code !== roomCode) return "";
    const lift = drag.dropping ? "" : " scale(1.02)";
    const glide = drag.gliding
      ? `transition: transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1);`
      : "";
    return `transform: translateY(${drag.dy}px)${lift}; ${glide}`;
  }

  $effect(() => () => {
    cancelAnimationFrame(scrollFrame);
    if (settleTimer) clearTimeout(settleTimer);
  });
  let dmContextMenu = $state<{
    peerId: string;
    inPhonebook: boolean;
    x: number;
    y: number;
  } | null>(null);

  // The Rooms switch had no counter while the DMs switch did, so unread room
  // traffic was invisible from the DMs tab. Same rule as the per-room badges:
  // the room on screen is being read, so it does not count.
  const roomUnreadTotal = $derived(
    rooms.reduce(
      (sum, room) =>
        room.roomCode === activeRoomCode
          ? sum
          : sum + (unreadCounts.get(room.roomCode) ?? 0),
      0
    )
  );

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
    onDragKeydown(e);
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
      sm:static sm:translate-x-0 sm:z-auto sm:transition-[width] sm:duration-200
      {collapsed ? 'sm:w-14' : 'sm:w-68'}
      {isOpen ? 'translate-x-0' : '-translate-x-full'}"
>
  <!-- Header - h-13 is shared with the chat header (ChatView) so they align.
       The safe-area inset is ADDED to that height rather than eaten out of
       it: the sidebar is `fixed inset-y-0` on a phone, so with a translucent
       status bar its first row sat under the clock. Both headers here and
       the chat header carry the identical expression, which is what keeps
       the three of them level. -->
  {#if collapsed}
    <div
      class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center justify-center border-b border-sidebar-border pt-[env(safe-area-inset-top)]"
    >
      <Tip text="Expand sidebar" side="right">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={onToggleCollapsed}
            aria-label="Expand sidebar"
            class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
          >
            <PanelLeftOpen class="size-4" />
          </button>
        {/snippet}
      </Tip>
    </div>
  {:else}
  <div
    class="flex h-[calc(3.25rem+env(safe-area-inset-top))] items-center justify-between border-b border-sidebar-border px-3 pt-[env(safe-area-inset-top)] shrink-0"
  >
    <div class="flex items-center gap-2">
      <Tip text="Collapse sidebar" side="bottom">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
          >
            <PanelLeftClose class="size-4" />
          </button>
        {/snippet}
      </Tip>
      <span
        class="select-none text-xs font-semibold text-muted-foreground mt-0.75 uppercase tracking-wider font-mono"
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
  {/if}

  {#if collapsed}
    <div class="flex flex-col items-center gap-1 px-2 pt-1.5">
      <Tip text="Rooms" side="right">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => onChangeTab("rooms")}
            aria-label="Rooms"
            class="relative inline-flex size-9 items-center justify-center rounded-md transition-colors cursor-pointer {activeTab ===
            'rooms'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50'}"
          >
            <Hash class="size-4" />
            {#if roomUnreadTotal > 0}
              <span
                class="absolute -top-1 -right-1 inline-flex min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold items-center justify-center px-1 tabular-nums"
              >
                {Math.min(roomUnreadTotal, 99)}
              </span>
            {/if}
          </button>
        {/snippet}
      </Tip>
      <Tip text="DMs" side="right">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => onChangeTab("users")}
            aria-label="DMs"
            class="relative inline-flex size-9 items-center justify-center rounded-md transition-colors cursor-pointer {activeTab ===
            'users'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50'}"
          >
            <MessageSquare class="size-4" />
            {#if dmUnreadTotal > 0}
              <span
                class="absolute -top-1 -right-1 inline-flex min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold items-center justify-center px-1 tabular-nums"
              >
                {Math.min(dmUnreadTotal, 99)}
              </span>
            {/if}
          </button>
        {/snippet}
      </Tip>
      {#if activeTab === "rooms" && onOpenCreateJoin && shouldShowAddBtn}
        <Tip text="Create or join a room" side="right">
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={onOpenCreateJoin}
              aria-label="Create or join room"
              class="inline-flex size-9 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent/40 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent cursor-pointer"
            >
              <Plus class="size-4" />
            </button>
          {/snippet}
        </Tip>
      {:else if activeTab === "users" && onOpenPhonebook}
        <Tip text="Phonebook" side="right">
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={onOpenPhonebook}
              aria-label="Open phonebook"
              class="inline-flex size-9 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent/40 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent cursor-pointer"
            >
              <Users class="size-4" />
            </button>
          {/snippet}
        </Tip>
      {/if}
    </div>
  {:else}
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
      {#if roomUnreadTotal > 0}
        <span
          class="ml-1 inline-flex min-w-4.5 h-4.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold items-center justify-center px-1 tabular-nums"
        >
          {Math.min(roomUnreadTotal, 99)}
        </span>
      {/if}
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
  {/if}

  <!-- Room list -->
  <div bind:this={listEl} class="flex-1 overflow-y-auto p-1.5">
    {#if collapsed}
      {#if activeTab === "rooms"}
        {#each rooms as room (room.roomCode)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            role="none"
            oncontextmenu={(e) => openContextMenu(e, room.roomCode)}
          >
            <Tip text={room.name || room.roomCode} side="right">
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  onclick={() => onSelectRoom(room.roomCode)}
                  class="relative mb-1 flex w-full items-center justify-center rounded-md p-2 transition-colors cursor-pointer hover:bg-accent/50 {activeRoomCode ===
                  room.roomCode
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground'}"
                >
                  <Hash class="size-4 shrink-0 opacity-70" />
                  {#if (unreadCounts.get(room.roomCode) ?? 0) > 0 && activeRoomCode !== room.roomCode}
                    <span
                      class="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center px-1 tabular-nums"
                    >
                      {Math.min(unreadCounts.get(room.roomCode) ?? 0, 99)}
                    </span>
                  {/if}
                </button>
              {/snippet}
            </Tip>
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
            <Tip text={entry.nickname} side="right">
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  onclick={() => onSelectDm(entry.peerId)}
                  class="relative mb-1 flex w-full items-center justify-center rounded-md p-2 transition-colors cursor-pointer hover:bg-accent/50 {activeDmPeerId ===
                  entry.peerId
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground'}"
                >
                  <div
                    class="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground text-xs font-semibold font-mono"
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
                  {#if (dmUnreadCounts.get(entry.peerId) ?? 0) > 0}
                    <span
                      class="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center px-1 tabular-nums"
                    >
                      {Math.min(dmUnreadCounts.get(entry.peerId) ?? 0, 99)}
                    </span>
                  {/if}
                </button>
              {/snippet}
            </Tip>
          </div>
        {/each}
      {/if}
    {:else}
    {#if activeTab === "rooms" && rooms.length === 0}
      <div
        class="flex h-full select-none flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <div class="w-8 opacity-50">
          <Hash class="size-full" />
        </div>
        No rooms yet
      </div>
    {:else if activeTab === "users" && phonebook.length === 0}
      <div
        class="flex h-full select-none flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <div class="w-8 opacity-50">
          <User class="size-full" />
        </div>
        No DMs yet
      </div>
    {/if}

    {#snippet roomButton(room: Room)}
      <button
        type="button"
        onclick={() => onSelectRoom(room.roomCode)}
        class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors cursor-pointer hover:bg-accent/50
          {activeRoomCode === room.roomCode
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground'}"
      >
        <Hash class="mt-0.5 size-3.5 shrink-0 opacity-50" />
        <div class="min-w-0 flex-1">
          <div class="select-text truncate text-sm font-medium font-mono">
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
    {/snippet}

    {#if activeTab === "rooms"}
      <!-- Pinned: on top, in pin order, and not draggable. The pin sits in
           the grip's slot so the names line up with the rows below. -->
      {#each pinnedList as room (room.roomCode)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="none"
          data-room-code={room.roomCode}
          animate:flip={{ duration: FLIP_MS, easing: cubicOut }}
          class="flex items-center gap-0.5 rounded-md"
          oncontextmenu={(e) => openContextMenu(e, room.roomCode)}
        >
          <span class="shrink-0 p-1 text-muted-foreground/60" title="Pinned">
            <Pin class="size-3.5" />
          </span>
          {@render roomButton(room)}
        </div>
      {/each}
      {#if pinnedList.length > 0 && displayRooms.length > 0}
        <div class="mx-2.5 my-1 h-px bg-sidebar-border" role="separator"></div>
      {/if}
      {#each displayRooms as room (room.roomCode)}
        {@const lifted = drag?.code === room.roomCode}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="none"
          data-room-code={room.roomCode}
          data-drag-row
          animate:flip={{ duration: lifted ? 0 : FLIP_MS, easing: cubicOut }}
          style={rowStyle(room.roomCode)}
          class="group relative flex items-center gap-0.5 rounded-md transition-shadow duration-150 {lifted
            ? 'z-10 bg-sidebar ring-1 ring-border'
            : ''} {lifted && !drag?.dropping ? 'shadow-lg' : ''}"
          oncontextmenu={(e) => openContextMenu(e, room.roomCode)}
        >
          <button
            type="button"
            aria-label="Reorder {room.name || room.roomCode}"
            title="Drag, or press ↑/↓, to reorder"
            onpointerdown={(e) => startRoomDrag(e, room.roomCode)}
            onpointermove={onRoomDragMove}
            onpointerup={endRoomDrag}
            onpointercancel={endRoomDrag}
            onkeydown={(e) => onGripKeydown(e, room.roomCode)}
            class="shrink-0 touch-none rounded p-1 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 {lifted
              ? 'cursor-grabbing text-foreground opacity-100'
              : 'cursor-grab text-muted-foreground/60 opacity-0 hover:text-muted-foreground'}"
          >
            <GripVertical class="size-3.5" />
          </button>
          {@render roomButton(room)}
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
    {/if}
  </div>

  {#if !collapsed}
    <PluginWidgetSlots />
  {/if}
  <CallStatus {collapsed} />
  <SidebarControls {collapsed} />
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
        onTogglePin(contextMenu!.code);
        closeContextMenu();
      }}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-muted cursor-pointer font-mono"
    >
      {#if pinnedSet.has(contextMenu.code)}
        <PinOff class="size-4" />
        Unpin
      {:else}
        <Pin class="size-4" />
        Pin to top
      {/if}
    </button>
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
