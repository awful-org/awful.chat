<script lang="ts">
  /**
   * /qs - the whole page. No sidebar, no chat, no identity: what the code
   * names is a swarm that exists for as long as somebody in it holds the
   * file. Everyone who finishes one serves it on, so "the sender" stops
   * being a role after the first delivery.
   */
  import { onDestroy, onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import QRCode from "qrcode";
  import { Check, Copy, Download, Loader2, QrCode, Upload, UserPlus, Users, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { formatSize } from "$lib/utils";
  import type { FileDescriptor } from "$lib/transport/types";
  import {
    acceptFile,
    declineFile,
    offerFiles,
    quickSend,
    removeOfferedFile,
    quickSendLink,
    setQuickSendMode,
    startQuickSend,
    stopQuickSend,
  } from "$lib/quick/quick-send.svelte";

  let copied = $state(false);
  let dragging = $state(false);
  let showQr = $state(false);
  let qr = $state("");
  let showHow = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  /** Offers this page asked for, so Accept turns into progress at once. */
  const asked = new SvelteSet<string>();

  const link = $derived(quickSend.code ? quickSendLink(quickSend.code) : "");
  const shownLink = $derived(link.replace(/^https?:\/\//, ""));
  const alone = $derived(quickSend.peers === 0);
  /** A transfer still moving is the only thing a tab close would destroy. */
  const busy = $derived(
    [...quickSend.transfers.values()].some((t) => t.status === "downloading")
  );
  const pending = $derived(quickSend.incoming.filter(isPending));

  /** Download speed per file, smoothed, from how fast its progress moves. */
  const samples = new Map<string, { at: number; bytes: number; rate: number }>();
  let speeds = $state<Record<string, number>>({});
  $effect(() => {
    const now = performance.now();
    const next: Record<string, number> = {};
    // A declined or removed file leaves the map without passing through a
    // status that would have cleared its sample.
    for (const hash of samples.keys()) if (!quickSend.transfers.has(hash)) samples.delete(hash);
    for (const [hash, t] of quickSend.transfers) {
      if (t.status !== "downloading") { samples.delete(hash); continue; }
      const bytes = (t.progress ?? 0) * t.size;
      const prev = samples.get(hash);
      if (!prev) { samples.set(hash, { at: now, bytes, rate: 0 }); continue; }
      const seconds = (now - prev.at) / 1000;
      if (seconds >= 0.5) {
        const rate = Math.max(0, (bytes - prev.bytes) / seconds);
        prev.rate = prev.rate ? prev.rate * 0.7 + rate * 0.3 : rate;
        prev.at = now;
        prev.bytes = bytes;
      }
      if (prev.rate) next[hash] = prev.rate;
    }
    speeds = next;
  });

  $effect(() => {
    if (!showQr || !link) { qr = ""; return; }
    let current = true;
    void QRCode.toDataURL(link, { width: 280, margin: 2 })
      .then((image) => { if (current) qr = image; })
      .catch(() => {});
    return () => { current = false; };
  });

  onMount(() => {
    void start();
    // A pasted link arrives as a hash change on an already-open page.
    const onHash = () => void start();
    const onHide = () => stopQuickSend();
    window.addEventListener("hashchange", onHash);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("pagehide", onHide);
    };
  });

  onDestroy(stopQuickSend);

  async function start() {
    const fromLink = window.location.hash.slice(1);
    asked.clear();
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

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes("Files");
  }

  // Any file dragged over the page is caught, whatever the state: left to
  // the browser, a drop opens the file and navigates away from the session.
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = quickSend.status === "ready";
    if (!dragging && e.dataTransfer) e.dataTransfer.dropEffect = "none";
  }

  function onDragLeave(e: DragEvent) {
    // Leaving for a child is not leaving the page.
    if (!e.relatedTarget) dragging = false;
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = false;
    if (quickSend.status === "ready") void take(e.dataTransfer?.files ?? null);
  }

  function isPending(file: FileDescriptor): boolean {
    if (asked.has(file.infoHash)) return false;
    const t = quickSend.transfers.get(file.infoHash);
    return !t?.blobURL && t?.status !== "downloading" && t?.status !== "failed";
  }

  function accept(file: FileDescriptor, retry = false) {
    asked.add(file.infoHash);
    acceptFile(file.infoHash, retry);
  }

  function acceptAll() {
    for (const file of pending) accept(file);
  }

  function decline(file: FileDescriptor) {
    asked.delete(file.infoHash);
    void declineFile(file.infoHash);
  }

  function leave() {
    // pagehide tears the session down; beforeunload asks first if a
    // download is still running.
    window.location.assign("/");
  }

  const peopleText = $derived(
    alone ? "Just you" : `${quickSend.peers + 1} in the room`
  );

  function yoursStatus(file: FileDescriptor): string {
    const t = quickSend.transfers.get(file.infoHash);
    // The seeder set counts this device too.
    const others = Math.max(0, (t?.seeders ?? 0) - 1);
    if (alone) return "Offered · waiting for someone to join";
    if (others >= quickSend.peers) return "Everyone here has it";
    const parts = [others ? `${others} of ${quickSend.peers} have it` : "Offered · nobody has it yet"];
    if (t?.peers) parts.push(`${t.peers} connected`);
    return parts.join(" · ");
  }

  function downloadStatus(file: FileDescriptor): string {
    const t = quickSend.transfers.get(file.infoHash);
    if (t?.status !== "downloading") return "Connecting…";
    const progress = t.progress ?? 0;
    const parts = [`${Math.round(progress * 100)}%`];
    const rate = speeds[file.infoHash];
    if (rate) {
      parts.push(`${formatSize(Math.round(rate))}/s`);
      const left = (file.size * (1 - progress)) / rate;
      parts.push(left < 60 ? `~${Math.max(1, Math.round(left))} s left` : `~${Math.round(left / 60)} min left`);
    }
    return parts.join(" · ");
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
  class="min-h-dvh overflow-y-auto bg-background text-foreground font-mono text-[13px] px-4 py-8 sm:py-12"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="presentation"
>
  <input
    bind:this={input}
    type="file"
    multiple
    class="hidden"
    onchange={(e) => void take(e.currentTarget.files)}
  />

  <main
    class="mx-auto max-w-[860px] rounded-xl border bg-card text-card-foreground overflow-hidden transition-colors {dragging
      ? 'border-primary'
      : 'border-border'}"
  >
    <header class="px-6 py-5 flex flex-col gap-3.5 border-b border-border">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class="text-lg font-bold flex items-center gap-2.5">
          <span
            class="size-2 rounded-full {quickSend.status === 'ready' && !alone
              ? 'bg-primary'
              : 'bg-muted-foreground'}"
          ></span>
          Quick send
        </h1>
        {#if quickSend.status === "ready"}
          <span class="text-xs text-muted-foreground flex items-center gap-1.5">
            <Users class="size-3.5" />
            {peopleText}{quickSend.heardMode === "once" ? " · one-time link" : ""}
          </span>
        {/if}
      </div>

      {#if quickSend.status === "ready"}
        <div class="flex gap-2">
          <span
            class="flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-2.5 text-muted-foreground truncate select-all"
            title={link}>{shownLink}</span
          >
          <Button
            variant={alone ? "default" : "outline"}
            class="h-11 shrink-0 font-mono text-xs"
            onclick={copyLink}
          >
            {#if copied}
              <Check class="size-3.5" /> Copied
            {:else}
              <Copy class="size-3.5" /> Copy link
            {/if}
          </Button>
          <Button
            variant="outline"
            size="icon"
            class="size-11 shrink-0"
            aria-label={showQr ? "Hide QR code" : "Show QR code"}
            aria-expanded={showQr}
            onclick={() => (showQr = !showQr)}
          >
            <QrCode class="size-4" />
          </Button>
        </div>
        {#if showQr}
          <div class="flex flex-col items-center gap-2 py-2">
            {#if qr}
              <img
                src={qr}
                alt="QR code of the quick send link"
                class="size-44 rounded-lg [image-rendering:pixelated]"
              />
            {:else}
              <div class="size-44 rounded-lg bg-muted animate-pulse"></div>
            {/if}
            <p class="text-xs text-muted-foreground">Scan to join from a phone</p>
          </div>
        {/if}
      {/if}
    </header>

    {#if quickSend.status === "connecting" || quickSend.status === "idle"}
      <p class="px-6 py-8 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 class="size-3.5 animate-spin" /> Connecting…
      </p>
    {:else if quickSend.status === "failed"}
      <div class="px-6 py-6 space-y-3">
        <p class="text-xs text-destructive">
          {quickSend.error ?? "Could not connect."}
        </p>
        <Button variant="outline" size="sm" class="font-mono" onclick={() => void start()}>
          Try again
        </Button>
      </div>
    {:else if quickSend.status === "closed"}
      <div class="px-6 py-6 space-y-2">
        <p class="text-sm">Delivered · this link is closed.</p>
        <p class="text-xs text-muted-foreground leading-relaxed">
          Somebody has the whole file, so nothing more is served from here and
          the link no longer reaches anything. Whoever received it still has
          it - a one-time link limits who can fetch it from you, not what they
          do with it afterwards.
        </p>
      </div>
    {:else}
      {#if quickSend.error}
        <p class="px-6 pt-4 text-xs text-destructive" role="alert">{quickSend.error}</p>
      {/if}

      <div class="grid md:grid-cols-2">
        <section
          class="min-w-0 px-6 pt-5 pb-6 flex flex-col gap-2.5 border-b md:border-b-0 md:border-r border-border"
          aria-labelledby="qs-yours"
        >
          <div class="flex items-center justify-between min-h-7">
            <h2 id="qs-yours" class="text-xs font-medium text-muted-foreground">Yours</h2>
            {#if quickSend.offered.length}
              <span class="text-xs text-muted-foreground">{quickSend.offered.length} offered</span>
            {/if}
          </div>

          {#if !quickSend.offered.length && !quickSend.preparing.length}
            <div
              class="rounded-[10px] border border-dashed px-4 py-7 flex flex-col items-center gap-2.5 text-center transition-colors {dragging
                ? 'border-primary bg-primary/5'
                : 'border-input'}"
            >
              <Upload class="size-5.5 text-muted-foreground" />
              <span class="text-muted-foreground">Drop files here, or</span>
              <Button variant="secondary" class="h-11 font-mono" onclick={() => input?.click()}>
                Choose files
              </Button>
            </div>
          {/if}

          {#each quickSend.preparing as file (file.id)}
            <div class="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5" aria-live="polite">
              <div class="flex-1 min-w-0 flex flex-col gap-1.5">
                <div class="flex justify-between gap-2">
                  <span class="truncate">{file.filename}</span>
                  <span class="text-xs text-muted-foreground shrink-0">{formatSize(file.size)}</span>
                </div>
                <span class="text-xs text-muted-foreground">
                  Encrypting · large files take a while
                </span>
              </div>
              <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" />
            </div>
          {/each}

          {#each quickSend.offered as file (file.infoHash)}
            <div class="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
              <div class="flex-1 min-w-0 flex flex-col gap-1.5">
                <div class="flex justify-between gap-2">
                  <span class="truncate">{file.filename}</span>
                  <span class="text-xs text-muted-foreground shrink-0">{formatSize(file.size)}</span>
                </div>
                <span class="text-xs text-muted-foreground truncate">{yoursStatus(file)}</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                class="shrink-0 text-muted-foreground"
                aria-label="Stop offering {file.filename}"
                title="Stop offering it and delete the cached copy"
                onclick={() => void removeOfferedFile(file.infoHash)}
              >
                <X class="size-3.5" />
              </Button>
            </div>
          {/each}

          {#if quickSend.offered.length || quickSend.preparing.length}
            <button
              type="button"
              class="min-h-11 rounded-lg border border-dashed text-xs text-muted-foreground hover:text-foreground hover:border-ring transition-colors cursor-pointer {dragging
                ? 'border-primary bg-primary/5'
                : 'border-input'}"
              onclick={() => input?.click()}
            >
              + Add more, or drop files anywhere
            </button>
          {/if}
        </section>

        <section class="min-w-0 px-6 pt-5 pb-6 flex flex-col gap-2.5" aria-labelledby="qs-offered">
          <div class="flex items-center justify-between min-h-7">
            <h2 id="qs-offered" class="text-xs font-medium text-muted-foreground flex items-center gap-2">
              Offered to you
              {#if pending.length}
                <span
                  class="text-[11px] font-bold rounded-full px-1.5 bg-primary text-primary-foreground"
                  aria-label="{pending.length} waiting">{pending.length}</span
                >
              {/if}
            </h2>
            {#if pending.length > 1}
              <button
                type="button"
                class="text-xs text-primary py-1 cursor-pointer hover:underline underline-offset-4"
                onclick={acceptAll}
              >
                Accept all
              </button>
            {/if}
          </div>

          {#if !quickSend.incoming.length}
            <div class="rounded-[10px] border border-border px-4 py-7 flex flex-col items-center gap-2 text-center">
              <UserPlus class="size-5.5 text-muted-foreground" />
              {#if alone}
                <span>Nobody else is here yet</span>
                <span class="text-xs text-muted-foreground max-w-64">
                  Send them the link. When someone joins and shares, it shows up here.
                </span>
              {:else}
                <span>Nothing offered yet</span>
                <span class="text-xs text-muted-foreground max-w-64">
                  When someone here shares a file, it shows up here.
                </span>
              {/if}
            </div>
          {/if}

          {#each quickSend.incoming as file (file.infoHash)}
            {@const transfer = quickSend.transfers.get(file.infoHash)}
            {@const waiting = isPending(file)}
            <div
              class="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 {waiting
                ? 'border-input bg-muted/40'
                : 'border-border'}"
            >
              <div class="flex-1 min-w-0 flex flex-col gap-1.5">
                <div class="flex justify-between gap-2">
                  <span class="truncate">{file.filename}</span>
                  <span class="text-xs text-muted-foreground shrink-0">{formatSize(file.size)}</span>
                </div>
                {#if !waiting && transfer?.status !== "failed"}
                  <div class="h-[3px] rounded-sm bg-muted overflow-hidden">
                    <div
                      class="h-full bg-primary transition-[width]"
                      style="width: {transfer?.blobURL ? 100 : Math.round((transfer?.progress ?? 0) * 100)}%"
                    ></div>
                  </div>
                {/if}
                {#if transfer?.status === "failed"}
                  <span class="text-xs text-destructive">{transfer.error ?? "Transfer failed."}</span>
                {:else if transfer?.blobURL}
                  <span class="text-xs text-muted-foreground">
                    Done{transfer.seeding ? " · sharing it on" : ""}
                  </span>
                {:else if waiting}
                  <span class="text-xs text-muted-foreground">Accept to download</span>
                {:else}
                  <span class="text-xs text-muted-foreground tabular-nums">{downloadStatus(file)}</span>
                {/if}
              </div>

              {#if transfer?.blobURL}
                <!-- The bytes are already here; this is the save. -->
                <Button
                  variant="outline"
                  size="icon-sm"
                  class="shrink-0"
                  href={transfer.blobURL}
                  download={file.filename}
                  aria-label="Save {file.filename}"
                  title="Save"
                >
                  <Download class="size-4" />
                </Button>
              {:else if transfer?.status === "failed"}
                <Button variant="outline" size="sm" class="shrink-0 font-mono text-xs" onclick={() => accept(file, true)}>
                  Retry
                </Button>
              {:else if waiting}
                <div class="flex items-center gap-0.5 shrink-0">
                  <Button size="sm" class="font-mono text-xs" onclick={() => accept(file)}>Accept</Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground"
                    aria-label="Decline {file.filename}"
                    onclick={() => decline(file)}
                  >
                    <X class="size-3.5" />
                  </Button>
                </div>
              {:else}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 text-muted-foreground"
                  aria-label="Cancel downloading {file.filename}"
                  onclick={() => decline(file)}
                >
                  <X class="size-3.5" />
                </Button>
              {/if}
            </div>
          {/each}
        </section>
      </div>
    {/if}

    <footer class="px-6 py-3 border-t border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {#if quickSend.status === "ready" && quickSend.isHost}
        <label
          class="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer min-h-8"
          title="The link closes as soon as one person has the file, and they do not share it on. Use it when the link might outlive the handover."
        >
          <input
            type="checkbox"
            checked={quickSend.mode === "once"}
            onchange={(e) => setQuickSendMode(e.currentTarget.checked ? "once" : "multi")}
            class="size-4 rounded border-input bg-background accent-primary cursor-pointer"
          />
          Close room after the first handover
        </label>
      {:else if quickSend.status === "ready" && quickSend.heardMode === "once"}
        <span class="text-xs text-muted-foreground">
          One-time link · this page will not share the file on
        </span>
      {:else}
        <span></span>
      {/if}
      <div class="flex items-center gap-4">
        <button
          type="button"
          class="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline py-2 cursor-pointer"
          aria-expanded={showHow}
          aria-controls="qs-how"
          onclick={() => (showHow = !showHow)}
        >
          How it works
        </button>
        {#if quickSend.status === "ready"}
          <button
            type="button"
            class="text-xs text-destructive hover:underline underline-offset-4 py-2 cursor-pointer"
            onclick={leave}
          >
            Leave room
          </button>
        {/if}
      </div>
    </footer>

    {#if showHow}
      <p id="qs-how" class="px-6 pb-4 text-xs text-muted-foreground leading-relaxed">
        Hand a file to one person or several, with no account. The relay
        introduces you and TURN may carry the connection when two sides cannot
        reach each other directly · the file itself never touches a server.
        Everyone holding the link is in one swarm and serves what they have
        finished, so the sender can leave once somebody has it - which also
        means anyone with the link can join. Send it to the people you mean to.
      </p>
    {/if}
  </main>
  <p class="mx-auto mt-3 max-w-[860px] text-center text-xs text-muted-foreground">
    Peer-to-peer · no account · anyone with the link can join
  </p>
</div>
