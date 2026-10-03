<script lang="ts">
  /**
   * The old room's history, on top of the secure room that replaced it
   * (room-security/legacy-move.ts).
   *
   * Read straight from this device's storage under the old room's own code:
   * those messages are signed for the old room and are never sent anywhere,
   * so they are shown, not re-filed. Rendered the way the legacy archive is
   * - plain text and locally saved attachments, no plugin cards, no remote
   * previews - since nothing in an old room was written for the new one.
   *
   * Collapsed until asked for: it can be a whole room's worth of history, and
   * nobody opening the new room needs it read from disk first.
   */
  import { onDestroy } from "svelte";
  import { getAttachmentsWithData, getMessages } from "$lib/storage";
  import { transportState, type Message } from "$lib/transport/transport.svelte";
  import { ChevronDown, ChevronUp, History } from "@lucide/svelte";
  import { safeBlobType } from "$lib/safe-mime";

  let { roomCode, roomName }: { roomCode: string; roomName: string } = $props();

  let open = $state(false);
  let loading = $state(false);
  let more = $state(false);
  let messages = $state<Message[]>([]);
  /** infoHash -> object URL of the bytes saved on this device. */
  let files = $state(new Map<string, string>());
  let loadedFor = "";

  function revokeAll(): void {
    for (const url of files.values()) URL.revokeObjectURL(url);
    files = new Map();
  }

  async function loadFirst(): Promise<void> {
    if (loadedFor === roomCode) return;
    loadedFor = roomCode;
    loading = true;
    try {
      const out = { capped: false };
      messages = await getMessages(roomCode, undefined, out);
      more = out.capped;
      const saved = new Map<string, string>();
      for (const a of await getAttachmentsWithData(roomCode)) {
        // Legacy rows hold plaintext bytes; anything encrypted is not one of
        // this archive's and would only be ciphertext here.
        if (!a.data || a.encryption || saved.has(a.infoHash)) continue;
        saved.set(a.infoHash, URL.createObjectURL(new Blob([a.data], { type: safeBlobType(a.mimeType) })));
      }
      revokeAll();
      files = saved;
    } finally {
      loading = false;
    }
  }

  async function loadOlder(): Promise<void> {
    const first = messages[0];
    if (!first || loading) return;
    loading = true;
    try {
      const out = { capped: false };
      const page = await getMessages(roomCode, { lamport: first.lamport, id: first.id }, out);
      messages = [...page, ...messages];
      more = out.capped;
    } finally {
      loading = false;
    }
  }

  function toggle(): void {
    open = !open;
    if (open) void loadFirst();
  }

  onDestroy(revokeAll);
</script>

<section aria-label="Messages from before the move" class="mb-3 border-b border-border/60 pb-3">
  <button
    type="button"
    onclick={toggle}
    aria-expanded={open}
    class="flex w-full items-center justify-center gap-2 rounded-md py-2 font-mono text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground cursor-pointer"
  >
    <History class="size-3.5" />
    <span>Earlier messages from "{roomName}", before the move</span>
    {#if open}<ChevronUp class="size-3.5" />{:else}<ChevronDown class="size-3.5" />{/if}
  </button>

  {#if open}
    <div class="mt-2 flex flex-col gap-3 opacity-80">
      <!-- Read from this device, never re-sent: each member of the old room
           sees their own copy here, and people new to the room see none. -->
      <p class="text-center font-mono text-xs text-muted-foreground">
        Everyone who was in "{roomName}" sees their own copy of these.
        People who join later don't.
      </p>
      {#if more}
        <button
          type="button"
          onclick={() => void loadOlder()}
          disabled={loading}
          class="self-center rounded px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >{loading ? "Loading..." : "Load older"}</button>
      {/if}
      {#if !loading && messages.length === 0}
        <p class="text-center font-mono text-xs italic text-muted-foreground">
          Nothing from the old room is saved on this device.
        </p>
      {/if}
      {#each messages as msg (msg.id)}
        <article class="flex flex-col gap-0.5">
          <span class="font-mono text-xs text-muted-foreground">{transportState.peerNames.get(msg.senderDid || msg.senderId) || msg.senderName || msg.senderId}</span>
          {#if msg.content}
            <p class="whitespace-pre-wrap break-words text-sm text-foreground">{msg.content}</p>
          {/if}
          {#each msg.meta?.files ?? [] as file (file.infoHash)}
            {@const url = files.get(file.infoHash)}
            {#if url}
              {#if file.mimeType.startsWith("image/")}
                <img src={url} alt={file.filename} class="max-h-60 max-w-full self-start rounded object-contain" />
              {:else}
                <a class="self-start text-sm text-primary hover:underline" href={url} download={file.filename}>{file.filename}</a>
              {/if}
            {:else}
              <span class="font-mono text-xs text-muted-foreground">{file.filename} - not saved on this device</span>
            {/if}
          {/each}
        </article>
      {/each}
      <p class="text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Moved to a secure room
      </p>
    </div>
  {/if}
</section>
