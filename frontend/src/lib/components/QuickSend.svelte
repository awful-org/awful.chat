<script lang="ts">
  /**
   * /qs - the whole page. No sidebar, no chat, no identity: what the code
   * names is a two-person room that exists for as long as this tab does.
   */
  import { onDestroy, onMount } from "svelte";
  import { Check, Copy, Download, Link2, Upload } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { formatRoomCode } from "$lib/room-code";
  import { formatSize } from "$lib/utils";
  import {
    acceptFile,
    offerFiles,
    quickSend,
    startQuickSend,
    stopQuickSend,
  } from "$lib/quick/quick-send.svelte";

  let copied = $state(false);
  let dragging = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const link = $derived(
    quickSend.code ? `${window.location.origin}/qs#${quickSend.code}` : ""
  );
  /** A transfer still moving is the only thing a tab close would destroy. */
  const busy = $derived(
    [...quickSend.transfers.values()].some((t) => t.status === "downloading")
  );

  onMount(() => {
    void start();
    // A pasted link arrives as a hash change on an already-open page.
    const onHash = () => void start();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  onDestroy(stopQuickSend);

  async function start() {
    const fromLink = window.location.hash.slice(1);
    await startQuickSend(fromLink || undefined);
    // The code IS the secret, so it lives in the fragment and never in the
    // path - same reasoning as room invites, see App.svelte. Writing it back
    // makes the address bar the link to share, and survives a reload.
    if (!fromLink && quickSend.code) {
      history.replaceState(history.state, "", `/qs#${quickSend.code}`);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard denied: the address bar already holds the same link.
    }
  }

  async function take(list: FileList | null) {
    if (!list?.length) return;
    await offerFiles([...list]);
    if (input) input.value = ""; // so the same file can be picked twice
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    void take(e.dataTransfer?.files ?? null);
  }
</script>

<svelte:window
  onbeforeunload={(e) => {
    if (!busy) return;
    e.preventDefault();
    return "";
  }}
/>

<div class="min-h-screen bg-background text-foreground flex justify-center p-4">
  <div class="w-full max-w-xl space-y-6 py-10">
    <header class="space-y-1">
      <h1 class="text-2xl font-semibold">Quick send</h1>
      <p class="text-sm text-muted-foreground">
        Send a file to one person. No account, nothing stored: the file goes
        straight to them over an encrypted peer-to-peer link, and closing this
        tab ends it.
      </p>
    </header>

    {#if quickSend.status === "connecting"}
      <p class="text-sm text-muted-foreground">Connecting...</p>
    {:else if quickSend.status === "failed"}
      <div class="rounded-lg border border-destructive/40 p-4 space-y-3">
        <p class="text-sm">{quickSend.error ?? "Could not connect."}</p>
        <Button variant="outline" size="sm" onclick={() => void start()}>
          Try again
        </Button>
      </div>
    {:else if quickSend.status === "ready"}
      <section class="rounded-lg border border-border p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <code class="text-lg font-mono tracking-wide">
            {formatRoomCode(quickSend.code)}
          </code>
          <Button variant="outline" size="sm" onclick={copyLink}>
            {#if copied}
              <Check class="size-4" /> Copied
            {:else}
              <Copy class="size-4" /> Copy link
            {/if}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground flex items-center gap-1.5">
          <Link2 class="size-3.5 shrink-0" />
          {#if quickSend.peers === 0}
            Waiting for the other side. Send them the link.
          {:else if quickSend.peers === 1}
            One person is here.
          {:else}
            {quickSend.peers} people are here - anyone with the link can join.
          {/if}
        </p>
      </section>

      <section
        class="rounded-lg border border-dashed p-6 text-center transition-colors {dragging
          ? 'border-primary bg-primary/5'
          : 'border-border'}"
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
        aria-label="Add files to send"
      >
        <Upload class="size-6 mx-auto mb-2 text-muted-foreground" />
        <p class="text-sm text-muted-foreground mb-3">
          Drop files here, or
        </p>
        <input
          bind:this={input}
          type="file"
          multiple
          class="hidden"
          onchange={(e) => void take(e.currentTarget.files)}
        />
        <Button variant="outline" size="sm" onclick={() => input?.click()}>
          Choose files
        </Button>
      </section>

      {#if quickSend.offered.length}
        <section class="space-y-2">
          <h2 class="text-sm font-medium">Sending</h2>
          {#each quickSend.offered as file (file.infoHash)}
            {@const transfer = quickSend.transfers.get(file.infoHash)}
            <div
              class="rounded-lg border border-border p-3 flex items-center justify-between gap-3"
            >
              <div class="min-w-0">
                <p class="text-sm truncate">{file.filename}</p>
                <p class="text-xs text-muted-foreground">
                  {formatSize(file.size)} • {transfer?.peers
                    ? `${transfer.peers} downloading`
                    : "ready"}
                </p>
              </div>
            </div>
          {/each}
        </section>
      {/if}

      {#if quickSend.incoming.length}
        <section class="space-y-2">
          <h2 class="text-sm font-medium">Offered to you</h2>
          {#each quickSend.incoming as file (file.infoHash)}
            {@const transfer = quickSend.transfers.get(file.infoHash)}
            <div class="rounded-lg border border-border p-3 space-y-2">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm truncate">{file.filename}</p>
                  <p class="text-xs text-muted-foreground">
                    {formatSize(file.size)}
                  </p>
                </div>
                {#if transfer?.blobURL}
                  <!-- The bytes are already here; this is the save. -->
                  <Button
                    variant="outline"
                    size="sm"
                    href={transfer.blobURL}
                    download={file.filename}
                  >
                    <Download class="size-4" /> Save
                  </Button>
                {:else if transfer?.status === "failed"}
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() => acceptFile(file.infoHash, true)}
                  >
                    Retry
                  </Button>
                {:else if transfer?.status === "downloading"}
                  <span class="text-xs text-muted-foreground tabular-nums">
                    {Math.round((transfer.progress ?? 0) * 100)}%
                  </span>
                {:else}
                  <Button size="sm" onclick={() => acceptFile(file.infoHash)}>
                    Accept
                  </Button>
                {/if}
              </div>
              {#if transfer?.status === "downloading"}
                <div class="h-1 rounded bg-muted overflow-hidden">
                  <div
                    class="h-full bg-primary transition-[width]"
                    style="width: {Math.round((transfer.progress ?? 0) * 100)}%"
                  ></div>
                </div>
              {:else if transfer?.status === "failed"}
                <p class="text-xs text-destructive">
                  {transfer.error ?? "Transfer failed."}
                </p>
              {/if}
            </div>
          {/each}
        </section>
      {/if}
    {/if}

    <p class="text-xs text-muted-foreground">
      The relay introduces the two of you and TURN may carry the connection
      when neither side is directly reachable - the file itself never touches a
      server. Anyone holding the link can join, so send it to one person.
    </p>
  </div>
</div>
