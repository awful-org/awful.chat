<script lang="ts">
  import { tick } from "svelte";
  import { transportState, loadMoreMessages } from "$lib/transport/transport.svelte";
  import { Button } from "$lib/components/ui/button";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import { Badge } from "$lib/components/ui/badge";
  import { Archive, ArrowRight, FileText, Menu, X } from "@lucide/svelte";
  let { roomCode, roomName, onOpenSidebar, onLeave, moved = false, onMove, onOpenMoved }: {
    roomCode: string; roomName: string;
    onOpenSidebar?: () => void; onLeave: () => void;
    /** Already moved to a secure room (room-security/legacy-move.ts). */
    moved?: boolean;
    /** Opens the move popup again - it asks people to check DMs first. */
    onMove?: () => void;
    onOpenMoved?: () => void;
  } = $props();
  let loading = $state(false);
  let more = $state(true);
  let list = $state<HTMLElement | null>(null);
  $effect(() => { roomCode; more = transportState.historyCapped; });
  const messages = $derived(transportState.messages.filter(m => m.roomCode === roomCode));

  // Opens at the newest message, like the chat view.
  let scrolledFor = "";
  $effect(() => {
    if (!list || messages.length === 0 || scrolledFor === roomCode) return;
    scrolledFor = roomCode;
    void tick().then(() => { if (list) list.scrollTop = list.scrollHeight; });
  });

  async function older() {
    const first = transportState.messages[0];
    if (!first || loading) return;
    loading = true;
    // Keep the reader's place while older messages land above it.
    const fromBottom = list ? list.scrollHeight - list.scrollTop : 0;
    try {
      more = await loadMoreMessages({ lamport: first.lamport, id: first.id });
      await tick();
      if (list) list.scrollTop = list.scrollHeight - fromBottom;
    }
    finally { loading = false; }
  }

  function formatStamp(ts: number): string {
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
</script>

<!-- Sized like ChatView: its parent only has a min-height, so without this
     the list never becomes the scroll container. -->
<section
  use:viewportHeight
  class="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
  aria-label="Legacy room archive"
>
  <header
    class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border px-4 pt-[env(safe-area-inset-top)]"
  >
    {#if onOpenSidebar}
      <Button
        variant="ghost"
        size="icon"
        onclick={onOpenSidebar}
        aria-label="Open rooms sidebar"
        class="sm:hidden shrink-0 cursor-pointer -ml-1 text-muted-foreground hover:text-foreground"
      >
        <Menu class="size-4" />
      </Button>
    {/if}
    <h1 class="min-w-0 select-text truncate text-sm font-semibold text-foreground">
      {roomName || roomCode}
    </h1>
    <Badge variant="outline" class="gap-1 text-xs shrink-0 border-border text-muted-foreground">
      <Archive class="size-3" />
      Read-only
    </Badge>
    <Button
      variant="ghost"
      size="sm"
      onclick={onLeave}
      aria-label="Close archive"
      class="ml-auto shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground cursor-pointer"
    >
      <X class="size-3.5" />
      <span class="hidden sm:inline">Close archive</span>
    </Button>
  </header>

  <div
    role="status"
    class="mx-4 mt-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
  >
    {#if moved}
      <p class="flex-1">This room moved to a secure room.</p>
      {#if onOpenMoved}
        <Button
          variant="outline"
          size="sm"
          onclick={onOpenMoved}
          class="shrink-0 font-mono text-xs cursor-pointer"
        >
          Open the new room
          <ArrowRight class="size-3.5" />
        </Button>
      {/if}
    {:else}
      <p class="flex-1">
        From an older version of Awful.chat, and it can't send messages
        anymore. Only what's saved on this device is here.
      </p>
      {#if onMove}
        <Button
          variant="outline"
          size="sm"
          onclick={onMove}
          class="shrink-0 font-mono text-xs cursor-pointer"
        >
          Move to a secure room
        </Button>
      {/if}
    {/if}
  </div>

  <div bind:this={list} class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    {#if more && messages.length > 0}
      <div class="mb-2 flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          onclick={older}
          disabled={loading}
          class="font-mono text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {loading ? "Loading..." : "Load older messages"}
        </Button>
      </div>
    {/if}
    {#each messages as msg (msg.id)}
      <article id="msg-{msg.id}" class="py-1.5">
        <div class="flex min-w-0 items-baseline gap-2">
          <span class="truncate text-sm font-medium text-foreground">
            {transportState.peerNames.get(msg.senderDid || msg.senderId) || msg.senderName || msg.senderId}
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">{formatStamp(msg.timestamp)}</span>
        </div>
        <!-- Plain text deliberately avoids executable plugin cards and remote previews. -->
        <p class="select-text whitespace-pre-wrap break-words text-sm text-foreground">{msg.content}</p>
        {#each msg.meta?.files ?? [] as file}
          {@const transfer = transportState.fileTransfers.get(file.infoHash)}
          {#if transfer?.blobURL}
            <a
              class="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground hover:bg-accent"
              href={transfer.blobURL}
              download={file.filename}
            >
              <FileText class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate">{file.filename}</span>
            </a>
          {:else}
            <p class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <FileText class="size-3.5 shrink-0" />
              <span class="truncate">{file.filename}</span>
              <span class="shrink-0">· not on this device</span>
            </p>
          {/if}
        {/each}
      </article>
    {:else}
      <p class="py-10 text-center text-xs text-muted-foreground">
        Nothing from this room is saved on this device.
      </p>
    {/each}
  </div>
</section>
