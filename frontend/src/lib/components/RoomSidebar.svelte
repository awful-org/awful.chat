<script lang="ts">
  import type { Room } from "$lib/storage";
  import { Hash, MessageSquare, Trash2 } from "@lucide/svelte";
  import SidebarControls from "./SidebarControls.svelte";

  interface Props {
    rooms: Room[];
    activeRoomCode: string | null;
    unreadCounts: Map<string, number>;
    isOpen?: boolean;
    onClose?: () => void;
    onSelectRoom: (code: string) => void;
    onRemoveRoom: (code: string) => void;
  }

  let {
    rooms,
    activeRoomCode,
    unreadCounts,
    isOpen = false,
    onClose,
    onSelectRoom,
    onRemoveRoom,
  }: Props = $props();

  let contextMenu = $state<{ code: string; x: number; y: number } | null>(null);

  function openContextMenu(e: MouseEvent, code: string) {
    e.preventDefault();
    contextMenu = { code, x: e.clientX, y: e.clientY };
  }

  function closeContextMenu() {
    contextMenu = null;
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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:window
  onclick={closeContextMenu}
  onkeydown={(e) => {
    if (e.key === "Escape") closeContextMenu();
  }}
/>

{#if rooms.length > 0}
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
    <!-- Header -->
    <div
      class="flex items-center gap-2 border-b border-sidebar-border px-3 py-3 shrink-0"
    >
      <MessageSquare class="size-4 text-muted-foreground" />
      <span
        class="text-xs font-medium text-muted-foreground uppercase tracking-wider font-mono"
      >
        Rooms
      </span>
    </div>

    <!-- Room list -->
    <div class="flex-1 overflow-y-auto p-1.5">
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
                {timeAgo(room.createdAt)}
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
    </div>

    <SidebarControls />
  </aside>

  {#if contextMenu}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      role="menu"
      tabindex="-1"
      class="fixed z-50 min-w-35 rounded-md border border-border bg-popover py-1 shadow-xl"
      style="top: {contextMenu.y}px; left: {contextMenu.x}px"
      onclick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onclick={() => {
          onRemoveRoom(contextMenu!.code);
          closeContextMenu();
        }}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-muted cursor-pointer font-mono"
      >
        <Trash2 class="size-4" />
        Remove from list
      </button>
    </div>
  {/if}
{/if}
