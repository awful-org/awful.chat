<script lang="ts">
  /**
   * /qs - the whole page. No sidebar, no chat, no identity: what the code
   * names is a swarm that exists for as long as somebody in it holds the
   * file. Everyone who finishes one serves it on, so "the sender" stops
   * being a role after the first delivery.
   */
  import { onDestroy, onMount } from "svelte";
  import { Check, Copy, Download, Upload, Users } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatQuickCode } from "$lib/room-code";
  import { formatSize } from "$lib/utils";
  import {
    acceptFile,
    offerFiles,
    quickSend,
    quickSendLink,
    setQuickSendMode,
    startQuickSend,
    stopQuickSend,
  } from "$lib/quick/quick-send.svelte";

  let copied = $state(false);
  let dragging = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const link = $derived(quickSend.code ? quickSendLink(quickSend.code) : "");
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

<div
  class="min-h-dvh overflow-y-auto bg-background text-foreground flex items-center justify-center p-4 font-mono"
>
  <Card.Root class="w-full max-w-md bg-card border-border text-card-foreground">
    <Card.Header class="pb-4">
      <div class="flex items-center gap-2 mb-1">
        <div
          class="w-2 h-2 rounded-full {quickSend.peers > 0
            ? 'bg-primary'
            : 'bg-muted-foreground'}"
        ></div>
        <Card.Title class="text-lg font-mono font-semibold">
          Quick send
        </Card.Title>
      </div>
      <Card.Description class="text-muted-foreground text-xs font-mono">
        Hand a file to one person or several · no account · multi-peer, so the
        bytes go straight between you
      </Card.Description>
    </Card.Header>

    {#if quickSend.status === "connecting"}
      <Card.Content>
        <p class="text-xs text-muted-foreground font-mono">Connecting...</p>
      </Card.Content>
    {:else if quickSend.status === "failed"}
      <Card.Content class="space-y-3">
        <p class="text-xs text-destructive font-mono">
          {quickSend.error ?? "Could not connect."}
        </p>
        <Button
          variant="outline"
          size="sm"
          class="font-mono"
          onclick={() => void start()}
        >
          Try again
        </Button>
      </Card.Content>
    {:else if quickSend.status === "closed"}
      <Card.Content class="space-y-2">
        <p class="text-sm font-mono">Delivered · this link is closed.</p>
        <p class="text-xs text-muted-foreground font-mono leading-relaxed">
          Somebody has the whole file, so nothing more is served from here and
          the link no longer reaches anything. Whoever received it still has
          it - a one-time link limits who can fetch it from you, not what they
          do with it afterwards.
        </p>
      </Card.Content>
    {:else if quickSend.status === "ready"}
      <Card.Content class="space-y-4">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <code class="text-base font-mono tracking-wide text-foreground">
              {formatQuickCode(quickSend.code)}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onclick={copyLink}
              class="font-mono text-xs"
            >
              {#if copied}
                <Check class="size-3.5" /> Copied
              {:else}
                <Copy class="size-3.5" /> Copy link
              {/if}
            </Button>
          </div>
          <p
            class="text-xs text-muted-foreground font-mono flex items-center gap-1.5"
          >
            <Users class="size-3.5 shrink-0" />
            {#if quickSend.peers === 0}
              Waiting for the other side · send them the link
            {:else if quickSend.peers === 1}
              One person is here
            {:else if quickSend.heardMode === "once"}
              {quickSend.peers} people are here · only the first to finish
              gets it
            {:else}
              {quickSend.peers} people are here · they share with each other
            {/if}
          </p>
        </div>

        {#if quickSend.isHost}
          <label class="flex items-start gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={quickSend.mode === "once"}
              onchange={(e) =>
                setQuickSendMode(e.currentTarget.checked ? "once" : "multi")}
              class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer"
            />
            <span
              class="text-xs text-muted-foreground group-hover:text-foreground transition-colors font-mono leading-relaxed"
            >
              One-time link · closes as soon as one person has the file, and
              they do not share it on. Use it when the link might outlive the
              handover.
            </span>
          </label>
        {:else if quickSend.heardMode === "once"}
          <p class="text-xs text-muted-foreground font-mono leading-relaxed">
            One-time link · you are the only recipient, and this page will not
            share the file on to anyone else.
          </p>
        {/if}

        <div
          class="rounded-lg border border-dashed p-6 text-center transition-colors {dragging
            ? 'border-primary bg-primary/5'
            : 'border-border'}"
          ondragover={(e) => {
            e.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
          role="region"
          aria-label="Add files to send"
        >
          <Upload class="size-6 mx-auto mb-2 text-muted-foreground" />
          <p class="text-xs text-muted-foreground font-mono mb-3">
            Drop files here, or
          </p>
          <input
            bind:this={input}
            type="file"
            multiple
            class="hidden"
            onchange={(e) => void take(e.currentTarget.files)}
          />
          <Button
            variant="outline"
            size="sm"
            class="font-mono"
            onclick={() => input?.click()}
          >
            Choose files
          </Button>
        </div>

        {#if quickSend.offered.length}
          <div class="space-y-2">
            <h2 class="text-xs font-mono font-medium text-muted-foreground">
              Sending
            </h2>
            {#each quickSend.offered as file (file.infoHash)}
              {@const transfer = quickSend.transfers.get(file.infoHash)}
              <div
                class="rounded-lg border border-border p-3 flex items-center justify-between gap-3"
              >
                <div class="min-w-0">
                  <p class="text-sm font-mono truncate">{file.filename}</p>
                  <p class="text-xs text-muted-foreground font-mono">
                    {formatSize(file.size)} · {transfer?.peers
                      ? `${transfer.peers} connected`
                      : "ready"}{(transfer?.seeders ?? 0) > 0
                      ? ` · ${transfer?.seeders} also sharing`
                      : ""}
                  </p>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if quickSend.incoming.length}
          <div class="space-y-2">
            <h2 class="text-xs font-mono font-medium text-muted-foreground">
              Offered to you
            </h2>
            {#each quickSend.incoming as file (file.infoHash)}
              {@const transfer = quickSend.transfers.get(file.infoHash)}
              <div class="rounded-lg border border-border p-3 space-y-2">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-sm font-mono truncate">{file.filename}</p>
                    <p class="text-xs text-muted-foreground font-mono">
                      {formatSize(file.size)}{transfer?.seeding
                        ? " · sharing it on"
                        : ""}
                    </p>
                  </div>
                  {#if transfer?.blobURL}
                    <!-- The bytes are already here; this is the save. -->
                    <Button
                      variant="outline"
                      size="sm"
                      class="font-mono"
                      href={transfer.blobURL}
                      download={file.filename}
                    >
                      <Download class="size-4" /> Save
                    </Button>
                  {:else if transfer?.status === "failed"}
                    <Button
                      variant="outline"
                      size="sm"
                      class="font-mono"
                      onclick={() => acceptFile(file.infoHash, true)}
                    >
                      Retry
                    </Button>
                  {:else if transfer?.status === "downloading"}
                    <span
                      class="text-xs text-muted-foreground font-mono tabular-nums"
                    >
                      {Math.round((transfer.progress ?? 0) * 100)}%
                    </span>
                  {:else}
                    <Button
                      size="sm"
                      class="font-mono"
                      onclick={() => acceptFile(file.infoHash)}
                    >
                      Accept
                    </Button>
                  {/if}
                </div>
                {#if transfer?.status === "downloading"}
                  <div class="h-1 rounded bg-muted overflow-hidden">
                    <div
                      class="h-full bg-primary transition-[width]"
                      style="width: {Math.round(
                        (transfer.progress ?? 0) * 100
                      )}%"
                    ></div>
                  </div>
                {:else if transfer?.status === "failed"}
                  <p class="text-xs text-destructive font-mono">
                    {transfer.error ?? "Transfer failed."}
                  </p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </Card.Content>
    {/if}

    <Card.Footer>
      <p class="text-xs text-muted-foreground font-mono leading-relaxed">
        The relay introduces you and TURN may carry the connection when two
        sides cannot reach each other directly · the file itself never touches
        a server. Everyone holding the link is in one swarm and serves what
        they have finished, so the sender can leave once somebody has it -
        which also means anyone with the link can join. Send it to the people
        you mean to.
      </p>
    </Card.Footer>
  </Card.Root>
</div>
