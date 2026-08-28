<script lang="ts">
  import { Tip } from "$lib/components/ui/tooltip";
  import {
    Download,
    FileText,
    Bookmark,
    X,
    Copy,
    Check,
    CheckCheck,
    Clock,
  } from "@lucide/svelte";
  import {
    MessageType,
    type Message,
    type FileEntry,
  } from "$lib/types/message";
  import type { FileTransferSnapshot } from "$lib/transport/types";
  import AudioPlayer from "./AudioPlayer.svelte";
  import GifImage from "./GifImage.svelte";
  import { mediaPrefs } from "$lib/media-prefs.svelte";
  // The queued tooltip must not promise the relay is holding a copy when the
  // sender opted out of the mailbox, in which case no deposit happened.
  import { mailboxPrefs } from "$lib/transport/mailbox.svelte";
  import { putSavedGif, deleteSavedGif, isGifSaved, getAttachmentsByInfoHash } from "$lib/storage";
  import { humanize } from "$lib/mentions";
  import { makeHostApi } from "$lib/plugins/host";
  import { peerIdToDid, transportState, resolveMentionDisplayName } from "$lib/transport/transport.svelte";
  import { getPlugin, getManifest } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { isPluginEnabled } from "$lib/plugins/prefs.svelte";
  import type { ComponentType } from "svelte";

  interface Props {
    msg: Message;
    isOwn: boolean;
    fileTransfers: Map<string, FileTransferSnapshot>;
    onRequestFileDownload: (file: FileEntry, senderId?: string | null) => void;
  }

  type OgPreview = {
    url: string;
    title?: string;
    description?: string;
    siteName?: string;
    image?: string;
    imageWidth?: number;
    imageHeight?: number;
    video?: string;
    videoWidth?: number;
    videoHeight?: number;
    videoContentType?: string;
    mediaType: "video" | "image" | "none";
  };

  let { msg, isOwn, fileTransfers, onRequestFileDownload }: Props = $props();

  let isMobile = $state(false);
  let highlightedCode = $state<string | null>(null);
  let ogPreview = $state<OgPreview | null>(null);
  let gifSaved = $state(false);
  let lightboxUrl = $state<string | null>(null);
  let copiedCode = $state(false);
  let videoPlaying = $state(false);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let videoNaturalWidth = $state(0);
  let videoNaturalHeight = $state(0);
  let pluginCardComponent = $state<ComponentType | null>(null);
  let pluginCardState = $state<unknown>(undefined);
  let pluginCardError = $state<string | null>(null);
  let pluginCardPluginId = $state("");

  $effect(() => {
    linkedUrl;
    videoPlaying = false;
    videoNaturalWidth = 0;
    videoNaturalHeight = 0;
  });

  // Load plugin card component AND its state. Subscribing to the tick is
  // what makes live votes re-render; getCardState is a cache hit after the
  // first build. ($effect callbacks must be sync - an async fn's returned
  // promise is a meaningless cleanup - so the async work is an inner IIFE.)
  // Bridge the store's plain-callback notifications into local reactivity.
  let cardStateTickLocal = $state(0);
  $effect(() => {
    // Only PLUGIN CARDS need to hear state ticks: subscribing every text
    // and file message meant one vote anywhere woke hundreds of callbacks
    // in a long scrollback.
    if (msg.type !== MessageType.PluginCard) return;
    return onCardStateChange(() => (cardStateTickLocal += 1));
  });

  // One host per (plugin, room), like PluginCallTileView/PluginWidgetBox: a
  // fresh host per render meant a fresh now-playing token per state tick,
  // churning the OS media surface on every party action.
  const pluginHostApi = $derived(
    pluginCardPluginId ? makeHostApi(pluginCardPluginId, msg.roomCode) : null
  );

  $effect(() => {
    void cardStateTickLocal;
    if (msg.type !== MessageType.PluginCard) {
      pluginCardComponent = null;
      pluginCardError = null;
      return;
    }
    void (async () => {
      try {
        const payload = JSON.parse(msg.content);
        const { pluginId } = payload;
        pluginCardPluginId = pluginId;
        const plugin = await getPlugin(pluginId);
        if (!plugin) {
          pluginCardError = `Plugin ${pluginId} not found`;
          return;
        }
        if (!plugin.card) {
          pluginCardError = `Plugin ${pluginId} has no card component`;
          return;
        }
        pluginCardState = await getCardState(msg.id, msg.roomCode, plugin);
        pluginCardComponent = plugin.card;
      } catch (err) {
        pluginCardError = `Failed to load plugin card: ${err}`;
      }
    })();
  });

  function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024)
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function isGifUrl(text: string): boolean {
    // Check for direct GIF/WebP file URLs
    if (/^https?:\/\/.+\.(gif|webp)(\?.*)?$/i.test(text)) {
      return true;
    }

    // Check if the entire message is a URL to a known GIF host
    const trimmed = text.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return false;
    }

    try {
      const url = new URL(trimmed);
      const hostname = url.hostname.toLowerCase();
      // Allowlist of known GIF hosting domains and their subdomains
      const allowlist = ['klipy.co', 'tenor.com', 'giphy.com', 'media.giphy.com'];
      return allowlist.some(host =>
        hostname === host || hostname.endsWith('.' + host)
      );
    } catch {
      return false;
    }
  }

  function firstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match ? match[0] : null;
  }

  function transferKey(file: FileEntry, index: number): string {
    return `${msg.id}:${file.infoHash}:${index}`;
  }

  const isFileMessage = $derived(msg.type === MessageType.File);
  const asCodeBlock = $derived.by(() => {
    const match = msg.content.match(/```([\w-]+)?\n([\s\S]*?)```/m);
    if (!match) return null;
    return { lang: match[1] || "text", code: match[2] };
  });
  const codeSegments = $derived.by(() => {
    const match = msg.content.match(/```([\w-]+)?\n([\s\S]*?)```/m);
    if (!match) return null;
    const fullMatch = match[0];
    const startIdx = msg.content.indexOf(fullMatch);
    const endIdx = startIdx + fullMatch.length;

    const before = msg.content.slice(0, startIdx).trim();
    const code = match[2];
    const after = msg.content.slice(endIdx).trim();

    return {
      before,
      lang: match[1] || "text",
      code,
      after,
    };
  });
  const linkedUrl = $derived(firstUrl(msg.content));
  const isGifMessage = $derived(isGifUrl(msg.content));
  const shouldShowOg = $derived(!isFileMessage && !!linkedUrl && !isGifMessage);

  const ogDomain = $derived.by(() => {
    if (!linkedUrl) return "";
    try {
      return new URL(linkedUrl).hostname.replace("www.", "");
    } catch {
      return linkedUrl;
    }
  });

  // aspect-ratio style: video metadata wins over og metadata, og metadata wins over 16/9
  const videoAspectStyle = $derived.by(() => {
    if (videoNaturalWidth && videoNaturalHeight) {
      return `aspect-ratio: ${videoNaturalWidth} / ${videoNaturalHeight};`;
    }
    if (ogPreview?.videoWidth && ogPreview?.videoHeight) {
      return `aspect-ratio: ${ogPreview.videoWidth} / ${ogPreview.videoHeight};`;
    }
    return "aspect-ratio: 16 / 9;";
  });

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

  $effect(() => {
    highlightedCode = null;
    if (!asCodeBlock) return;
    // Loaded on demand: the highlighter engine plus its wasm is well over
    // half a megabyte, and most sessions never see a code block.
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(asCodeBlock.code, {
          lang: asCodeBlock.lang,
          theme: "github-dark",
        })
      )
      .then((html) => {
        highlightedCode = html;
      })
      .catch(() => {
        highlightedCode = `<pre><code>${escapeHtml(asCodeBlock.code)}</code></pre>`;
      });
  });

  $effect(() => {
    ogPreview = null;
    if (!shouldShowOg || !linkedUrl) return;
    const ctrl = new AbortController();
    fetch(
      `${import.meta.env.VITE_API_URL || "https://awful.frav.in"}/og/preview?url=${encodeURIComponent(linkedUrl)}`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((json: OgPreview) => {
        ogPreview = json;
      })
      .catch(() => {});
    return () => ctrl.abort();
  });

  $effect(() => {
    gifSaved = false;
    if (!isGifMessage || !msg.content) return;
    isGifSaved(msg.content).then((saved) => {
      gifSaved = !!saved;
    });
  });

  // Saved-state per uploaded gif in this message, keyed by infoHash.
  let savedFileGifs = $state(new Set<string>());

  $effect(() => {
    savedFileGifs = new Set();
    const gifs = (msg.meta?.files ?? []).filter(
      (f) => f.mimeType === "image/gif"
    );
    if (!gifs.length) return;
    Promise.all(gifs.map((f) => isGifSaved(f.infoHash))).then((results) => {
      savedFileGifs = new Set(
        gifs.filter((_, i) => results[i]).map((f) => f.infoHash)
      );
    });
  });

  async function toggleSaveFileGif(e: MouseEvent, file: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    const existing = await isGifSaved(file.infoHash);
    if (existing) {
      await deleteSavedGif(existing.id);
      const next = new Set(savedFileGifs);
      next.delete(file.infoHash);
      savedFileGifs = next;
      return;
    }
    // Bytes from storage when the attachment persisted them, else from the
    // blob already on screen - saving must not depend on seeders.
    let data = (await getAttachmentsByInfoHash(file.infoHash)).find(
      (a) => a.data
    )?.data;
    if (!data) {
      const blobURL = fileTransfers.get(file.infoHash)?.blobURL;
      if (!blobURL) return;
      data = await (await fetch(blobURL)).arrayBuffer();
    }
    await putSavedGif({
      id: file.infoHash,
      gifId: file.infoHash,
      title: file.filename,
      url: "",
      previewUrl: "",
      mimeType: file.mimeType,
      data,
      savedAt: Date.now(),
    });
    savedFileGifs = new Set([...savedFileGifs, file.infoHash]);
  }

  async function toggleSaveGif(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isGifMessage || !msg.content) return;
    const existing = await isGifSaved(msg.content);
    if (existing) {
      await deleteSavedGif(existing.id);
      gifSaved = false;
      return;
    }
    await putSavedGif({
      // Keyed by the gif URL: double-taps upsert instead of duplicating.
      id: msg.content,
      gifId: msg.content,
      title: `GIF from ${msg.senderName}`,
      url: msg.content,
      previewUrl: msg.content,
      savedAt: Date.now(),
    });
    gifSaved = true;
  }

  async function copyCodeBlock() {
    if (!asCodeBlock) return;
    await navigator.clipboard.writeText(asCodeBlock.code);
    copiedCode = true;
    setTimeout(() => {
      copiedCode = false;
    }, 1200);
  }

  // The shiki-failure fallback: escaping only "<" blocked tag injection but
  // visibly mangled code containing "&"; full escaping matches escapeHtml.
  function escapeForCodeFallback(code: string): string {
    return escapeHtml(code);
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function linkifyText(text: string): string {
    // Order is the security property: escape the whole body FIRST, then
    // decorate. Mention tokens (@[did]) contain no HTML characters so they
    // survive escaping, and humanize() escapes the resolved display name
    // itself before emitting the chip.
    const escaped = escapeHtml(text);
    const mentionized = humanize(escaped, resolveMentionDisplayName);
    const urlRegex = /(https?:\/\/[^\s<]+)/gi;
    return mentionized.replace(
      urlRegex,
      (url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">${url}</a>`
    );
  }



  function onVideoMeta() {
    if (!videoEl) return;
    videoNaturalWidth = videoEl.videoWidth;
    videoNaturalHeight = videoEl.videoHeight;
  }
</script>

<!--
  `leading-normal` is not decoration. `text-sm` shipped a ratio line-height with
  it for free; `text-(length:…)` emits font-size only, so without an explicit
  line-height the body would render on the container's line box and clip at
  larger sizes.
-->
<div
  class="ml-9 text-(length:--chat-font-size) leading-normal text-foreground wrap-break-word"
>
  {#if isFileMessage}
    {#if msg.content}
      <!-- Through linkifyText like every other body: rendered raw, a caption
           showed mention tokens as @[did:key:...] instead of the name. -->
      <p class="whitespace-pre-wrap mb-2">{@html linkifyText(msg.content)}</p>
    {/if}

    <div class="space-y-2">
      {#each msg.meta?.files ?? [] as file, index (transferKey(file, index))}
        {@const transfer = fileTransfers.get(file.infoHash)}
        {@const seederCount = transfer?.seeders ?? (transfer?.seeding ? 1 : 0)}
        <div class="rounded-md border border-border/70 bg-muted/30 p-2.5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm text-foreground">{file.filename}</p>
              <p class="text-xs text-muted-foreground">
                {formatSize(file.size)} • {seederCount} seeder{seederCount === 1
                  ? ""
                  : "s"}
              </p>
            </div>

            {#if !isOwn && (!transfer || transfer.status === "pending" || transfer.status === "failed")}
              <Tip text="Download">
                {#snippet children(props)}
              <button
                {...props}
                type="button"
                class="inline-flex size-7 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground hover:text-foreground cursor-pointer"
                onclick={() => onRequestFileDownload(file, msg.senderId)}
                aria-label="Download file"
              >
                <Download class="size-3.5" />
              </button>
                {/snippet}
              </Tip>
            {/if}
          </div>

          <!-- Only while bytes are actually moving: a finished or seeding
               transfer has nothing left to report. -->
          {#if transfer?.status === "downloading" && !transfer.done && (transfer.progress ?? 0) < 1}
            <div class="mt-2 h-1.5 overflow-hidden rounded bg-muted">
              <div
                class="h-full bg-primary transition-[width]"
                style={`width: ${Math.max(0, Math.min(100, Math.round((transfer.progress || 0) * 100)))}%`}
              ></div>
            </div>
          {/if}

          {#if transfer?.blobURL && file.mimeType.startsWith("image/")}
            <div class="group/gif relative mt-2 inline-block">
              <button
                type="button"
                class="block"
                onclick={() => (lightboxUrl = transfer.blobURL!)}
              >
                <GifImage
                  src={transfer.blobURL}
                  alt={file.filename}
                  class="max-w-xs max-h-56 rounded-md object-contain"
                  loading="lazy"
                  animated={file.mimeType === "image/gif"}
                  animate={mediaPrefs.gifAutoplay ? true : "hover"}
                />
              </button>
              {#if file.mimeType === "image/gif"}
                {@const isFileGifSaved = savedFileGifs.has(file.infoHash)}
                <button
                  type="button"
                  class="absolute right-2 top-2 size-7 rounded-full text-white flex items-center justify-center transition-opacity cursor-pointer {isMobile
                    ? 'opacity-100'
                    : 'opacity-0 group-hover/gif:opacity-100'} {isFileGifSaved
                    ? 'bg-primary'
                    : 'bg-black/60 hover:bg-black/80'}"
                  onclick={(e) => toggleSaveFileGif(e, file)}
                  aria-label={isFileGifSaved ? "Unsave GIF" : "Save GIF"}
                >
                  <Bookmark
                    class="size-4 {isFileGifSaved ? 'fill-current' : ''}"
                  />
                </button>
              {/if}
            </div>
          {:else if transfer?.blobURL && file.mimeType.startsWith("video/")}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={transfer.blobURL}
              controls
              preload="metadata"
              class="mt-2 max-w-xs max-h-56 rounded-md"
            ></video>
          {:else if transfer?.blobURL && file.mimeType.startsWith("audio/")}
            <AudioPlayer
              src={transfer.blobURL}
              label={file.filename}
              class="mt-2 max-w-xs"
            />
          {:else if transfer?.blobURL}
            <a
              href={transfer.blobURL}
              download={file.filename}
              class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <FileText class="size-3.5" />
              Open file
            </a>
          {/if}
        </div>
      {/each}
    </div>
  {:else if codeSegments}
    {#if codeSegments.before}
      <p class="whitespace-pre-wrap mb-2">{@html linkifyText(codeSegments.before)}</p>
    {/if}
    <div
      class="relative overflow-x-auto rounded-md border border-border/70 bg-muted/30 p-2 [&_.shiki]:bg-transparent! {codeSegments.after ? 'mb-2' : ''}"
    >
      <button
        type="button"
        class="absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded border border-border/70 bg-card text-muted-foreground hover:text-foreground"
        onclick={copyCodeBlock}
        aria-label={copiedCode ? "Copied" : "Copy code"}
      >
        {#if copiedCode}
          <Check class="size-3.5" />
        {:else}
          <Copy class="size-3.5" />
        {/if}
      </button>
      {@html highlightedCode ??
        `<pre><code>${escapeHtml(codeSegments.code)}</code></pre>`}
    </div>
    {#if codeSegments.after}
      <p class="whitespace-pre-wrap">{@html linkifyText(codeSegments.after)}</p>
    {/if}
  {:else if isGifMessage}
    <div class="group relative inline-block">
      <button type="button" onclick={() => (lightboxUrl = msg.content)}>
        <GifImage
          src={msg.content}
          alt="GIF"
          class="max-w-xs max-h-56 rounded-md object-contain"
          loading="lazy"
          animated={true}
          animate={mediaPrefs.gifAutoplay ? true : "hover"}
        />
      </button>
      <button
        type="button"
        class="absolute right-2 top-2 size-7 rounded-full text-white flex items-center justify-center transition-opacity cursor-pointer {isMobile
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100'} {gifSaved
          ? 'bg-primary text-primary-foreground'
          : 'bg-black/70'}"
        onclick={toggleSaveGif}
        aria-label={gifSaved ? "Unsave GIF" : "Save GIF"}
      >
        <Bookmark class="size-4 {gifSaved ? 'fill-current' : ''}" />
      </button>
    </div>
  {:else if msg.type === MessageType.PluginCard}
    {#if pluginCardError}
      <div class="inline-block px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
        🔌 Plugin error: {pluginCardError}
      </div>
    {:else if !pluginCardComponent}
      <div class="inline-block px-3 py-2 rounded-md bg-muted/50 text-muted-foreground text-sm animate-pulse">
        Loading plugin...
      </div>
    {:else}
      <!-- Capitalized alias: a lowercase tag is an HTML element to Svelte,
           so <pluginCardComponent> mounted NOTHING - an empty unknown
           element where the poll should be. -->
      {@const PluginCardUi = pluginCardComponent}
      {@const pluginManifest = getManifest(pluginCardPluginId)}
      <!-- Prop is cardState, NOT state: a binding named `state` makes
           Svelte 5 compile the component's own $state(...) runes as store
           subscriptions to the prop - .subscribe crash on mount. -->
      <!-- The frame owns the default card size: every plugin gets the same
           minimum canvas instead of each card guessing its own width, and
           min() keeps it inside the bubble on phones. -->
      <div
        class="inline-block min-w-[min(38rem,100%)] min-h-24 max-w-full rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5"
      >
        <div class="mb-1.5 flex items-center justify-end gap-1.5">
          {#if pluginManifest?.repository}
            <a
              href={pluginManifest.repository}
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-[10px] text-muted-foreground hover:text-primary hover:underline"
            >
              {pluginManifest.name}{pluginManifest.version
                ? ` v${pluginManifest.version}`
                : ""}
            </a>
          {:else}
            <span class="font-mono text-[10px] text-muted-foreground">
              {pluginManifest?.name ?? pluginCardPluginId}{pluginManifest?.version
                ? ` v${pluginManifest.version}`
                : ""}
            </span>
          {/if}
        </div>
        {#if pluginHostApi}
          <PluginCardUi
            card={msg}
            cardState={pluginCardState}
            host={pluginHostApi}
          />
        {/if}
      </div>
    {/if}
  {:else}
    <p class="whitespace-pre-wrap">{@html linkifyText(msg.content)}</p>

    {#if linkedUrl && ogPreview}
      <div
        class="mt-2 max-w-sm overflow-hidden rounded-lg border border-border/70 bg-card"
      >
        {#if ogPreview.mediaType === "video" && ogPreview.video}
          {#if videoPlaying}
            <div class="w-full bg-black" style={videoAspectStyle}>
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                bind:this={videoEl}
                src={ogPreview.video}
                controls
                autoplay
                class="w-full h-full object-contain"
                onloadedmetadata={onVideoMeta}
              ></video>
            </div>
          {:else}
            <button
              type="button"
              class="relative block w-full bg-black group/play"
              style={videoAspectStyle}
              onclick={() => (videoPlaying = true)}
              aria-label="Play video"
            >
              {#if ogPreview.image}
                <img
                  src={ogPreview.image}
                  alt=""
                  class="absolute inset-0 w-full h-full object-cover"
                />
              {/if}
              <div
                class="absolute inset-0 flex items-center justify-center bg-black/35 group-hover/play:bg-black/50 transition-colors"
              >
                <div
                  class="flex size-11 items-center justify-center rounded-full bg-white/90 group-hover/play:bg-white transition-colors"
                >
                  <svg width="14" height="16" viewBox="0 0 14 16" fill="none">
                    <path d="M2 1.5L12.5 8L2 14.5V1.5Z" fill="black" />
                  </svg>
                </div>
              </div>
            </button>
          {/if}
        {:else if ogPreview.mediaType === "image" && ogPreview.image}
          <a
            href={linkedUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="block w-full overflow-hidden bg-muted/20"
            tabindex="-1"
          >
            <img
              src={ogPreview.image}
              alt={ogPreview.title ?? ""}
              class="w-full max-h-80 object-contain object-center"
            />
          </a>
        {/if}
        <!-- text meta - always a link to the site -->
        <a
          href={linkedUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="flex flex-col gap-0.5 px-3 py-2.5 hover:bg-muted/40 transition-colors"
        >
          <span
            class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 11 11"
              fill="none"
              class="shrink-0 opacity-60"
            >
              <circle
                cx="5.5"
                cy="5.5"
                r="4.5"
                stroke="currentColor"
                stroke-width="1.1"
                fill="none"
              />
              <ellipse
                cx="5.5"
                cy="5.5"
                rx="2"
                ry="4.5"
                stroke="currentColor"
                stroke-width="1.1"
                fill="none"
              />
              <line
                x1="1"
                y1="5.5"
                x2="10"
                y2="5.5"
                stroke="currentColor"
                stroke-width="1.1"
              />
            </svg>
            {ogPreview.siteName ?? ogDomain}
          </span>
          {#if ogPreview.title}
            <span
              class="text-[13px] font-semibold leading-snug text-foreground line-clamp-2"
            >
              {ogPreview.title}
            </span>
          {/if}
          {#if ogPreview.description}
            <span
              class="text-xs leading-snug text-muted-foreground line-clamp-2"
            >
              {ogPreview.description}
            </span>
          {/if}
        </a>
      </div>
    {:else if linkedUrl}
      <a
        href={linkedUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="mt-2 inline-flex text-xs text-primary hover:underline"
      >
        {linkedUrl}
      </a>
    {/if}
  {/if}

  {#if isOwn && msg.status}
    <Tip
      text={msg.status === "sending"
        ? mailboxPrefs.enabled
          ? "Queued - waiting in their offline inbox"
          : "Queued - will send when the recipient is reachable"
        : msg.status.charAt(0).toUpperCase() + msg.status.slice(1)}
    >
      {#snippet children(props)}
        <span
          {...props}
          class="ml-1.5 inline-flex items-center align-text-bottom"
          aria-label="Message {msg.status}"
        >
          {#if msg.status === "sending"}
            <Clock class="size-3 text-muted-foreground" />
          {:else if msg.status === "sent"}
            <Check class="size-3 text-muted-foreground" />
          {:else if msg.status === "delivered"}
            <CheckCheck class="size-3 text-muted-foreground" />
          {:else}
            <CheckCheck class="size-3 text-primary" />
          {/if}
        </span>
      {/snippet}
    </Tip>
  {/if}
</div>

{#if lightboxUrl}
  <div
    class="fixed inset-0 z-50 grid place-items-center p-4"
    role="dialog"
    aria-modal="true"
    tabindex="0"
    onkeydown={(e) => {
      if (e.key === "Escape") lightboxUrl = null;
    }}
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/80"
      onclick={() => (lightboxUrl = null)}
      aria-label="Close preview"
    ></button>
    <button
      type="button"
      class="absolute right-4 top-4 z-10 size-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center"
      onclick={() => {
        lightboxUrl = null;
      }}
      aria-label="Close"
    >
      <X class="size-4" />
    </button>
    <button type="button" class="relative z-10 cursor-default">
      <img
        src={lightboxUrl}
        alt="Preview"
        class="max-h-[90vh] max-w-[90vw] object-contain rounded-md"
      />
    </button>
  </div>
{/if}
