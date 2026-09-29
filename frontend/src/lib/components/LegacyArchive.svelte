<script lang="ts">
  import { transportState, loadMoreMessages } from "$lib/transport/transport.svelte";
  let { roomCode, roomName, onOpenSidebar, onLeave }: {
    roomCode: string; roomName: string;
    onOpenSidebar?: () => void; onLeave: () => void;
  } = $props();
  let loading = $state(false);
  let more = $state(true);
  $effect(() => { roomCode; more = transportState.historyCapped; });
  async function older() {
    const first = transportState.messages[0];
    if (!first || loading) return;
    loading = true;
    try { more = await loadMoreMessages({ lamport: first.lamport, id: first.id }); }
    finally { loading = false; }
  }
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Legacy room archive">
  <header class="flex items-center gap-3 border-b p-4">
    <button onclick={onOpenSidebar} aria-label="Open sidebar">Rooms</button>
    <h1 class="flex-1 font-semibold">{roomName}</h1>
    <button onclick={onLeave}>Close archive</button>
  </header>
  <p class="border-b p-4 text-sm text-muted-foreground" role="status">
    Read-only legacy archive. Only messages and attachments saved on this device are available.
    Create a secure room to continue chatting.
  </p>
  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    {#if more}<button onclick={older} disabled={loading}>Load older messages</button>{/if}
    {#each transportState.messages.filter(m => m.roomCode === roomCode) as msg (msg.id)}
      <article id="msg-{msg.id}" class="mb-4">
        <p class="text-sm text-muted-foreground">{msg.senderName || msg.senderId}</p>
        <!-- Plain text deliberately avoids executable plugin cards and remote previews. -->
        <p class="whitespace-pre-wrap break-words">{msg.content}</p>
        {#each msg.meta?.files ?? [] as file}
          {@const transfer = transportState.fileTransfers.get(file.infoHash)}
          {#if transfer?.blobURL}
            <a class="block underline" href={transfer.blobURL} download={file.filename}>{file.filename}</a>
          {:else}
            <p class="text-sm text-muted-foreground">{file.filename} — not saved on this device</p>
          {/if}
        {/each}
      </article>
    {/each}
  </div>
</section>
