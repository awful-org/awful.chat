<script module lang="ts">
  /** infoHashes auto-download already asked for, across every message
   *  component - one request per file per session, however often rows
   *  re-render or the same file appears in several rooms. */
  const _autoRequested = new Set<string>();
</script>

<script lang="ts">
  import { apiUrl } from "$lib/runtime-config";
  import { Tip } from "$lib/components/ui/tooltip";
  import {
    ChevronDown,
    Download,
    Unplug,
    ExternalLink,
    Minimize2,
    FileText,
    Bookmark,
    X,
    Copy,
    Check,
    CheckCheck,
    Clock,
    Pin as PinIcon,
    PinOff,
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
  import { mediaBoxStyle } from "$lib/image-size";
  import { INLINE_FILE_MAX_BYTES } from "$lib/transport/files.svelte";

  import {
    convertImage,
    convertTargets,
    saveBlob,
    withExtension,
  } from "$lib/image-convert";
  import {
    actualSizeZoom,
    clampPan,
    clampZoom,
    distance,
    midpoint,
    MIN_ZOOM,
    zoomAbout,
    type Point,
  } from "$lib/image-zoom";
  import {
    highlightLanguage,
    highlightText,
    previewKind,
    renderMarkdown,
  } from "$lib/text-preview";
  import { makeHostApi } from "$lib/plugins/host";
  import { peerIdToDid, transportState, resolveMentionDisplayName } from "$lib/transport/transport.svelte";
  import {
    getPlugin,
    getManifest,
    unsupportedRequirements,
  } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import {
    isPluginEnabled,
    pluginPrefs,
    pinWidget,
    unpinWidget,
  } from "$lib/plugins/prefs.svelte";
  import type { PluginComponent } from "$lib/plugins/api";

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

  /**
   * Whether a not-yet-loaded media file deserves its skeleton. An active
   * download obviously does. A PENDING one does too when it is small enough
   * to auto-materialize (inline bytes ride the message, and stored bytes
   * hydrate on room open) - that pending window is where the layout shift
   * actually happens, on every reload and every live image, and gating on
   * "downloading" alone meant the skeleton practically never rendered. A
   * pending file ABOVE the inline cap needs a manual Download click, and a
   * skeleton there would pulse forever next to its own Download button.
   */
  // Opt-in auto-download: fetch media attachments as soon as their message
  // renders, exactly what clicking Download would do. Media only - a stray
  // zip stays a manual click - and never retried after a failure, so a dead
  // seeder does not turn into a request loop.
  $effect(() => {
    if (!mediaPrefs.autoDownloadMedia || isOwn) return;
    for (const file of msg.meta?.files ?? []) {
      if (!/^(image|video|audio)\//.test(file.mimeType)) continue;
      const transfer = fileTransfers.get(file.infoHash);
      if (transfer && transfer.status !== "pending") continue;
      if (_autoRequested.has(file.infoHash)) continue;
      _autoRequested.add(file.infoHash);
      onRequestFileDownload(file, msg.senderId);
    }
  });

  function expectsBytesSoon(
    status: string | undefined,
    size: number
  ): boolean {
    if (status === "downloading") return true;
    // No transfer entry at all is the FIRST render: the entry registers a
    // beat after the message row does, and waiting for it meant the chip
    // appeared, then the skeleton, then the image - the skeleton losing the
    // race it exists to win. A small file materializes either way.
    return (
      (status === undefined || status === "pending") &&
      size <= INLINE_FILE_MAX_BYTES
    );
  }

  // `Message.content` is a TypeScript claim, not a runtime guarantee: a wire
  // message is JSON.parse output that is only cast, so a peer can put a number
  // or an object there and it still signs and verifies. Every use below calls
  // string methods (.match, .indexOf, .slice), and one throw inside a $derived
  // takes down the whole message list until reload - so coerce once, here.
  const content = $derived(typeof msg.content === "string" ? msg.content : "");

  let isMobile = $state(false);
  let highlightedCode = $state<string | null>(null);
  let ogPreview = $state<OgPreview | null>(null);
  let gifSaved = $state(false);
  /**
   * The open lightbox. An object rather than a bare URL because the download
   * menu needs the filename to save under and the mime type to decide which
   * conversions are worth offering.
   */
  type Lightbox = {
    url: string;
    filename: string;
    mimeType: string;
    /** Absent for a remote GIF, whose bytes we do not hold. */
    size?: number;
  };
  let lightbox = $state<Lightbox | null>(null);
  let formatsOpen = $state(false);
  let converting = $state<string | null>(null);
  let convertError = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewHtml = $state<string | null>(null);
  let previewCode = $state<string | null>(null);
  let previewError = $state<string | null>(null);
  /** Markdown opens rendered; the toggle is for reading the source itself. */
  let previewMode = $state<"rendered" | "source">("rendered");

  const lightboxKind = $derived(
    lightbox
      ? lightbox.mimeType.startsWith("image/")
        ? "image"
        : previewKind(lightbox.filename, lightbox.mimeType, lightbox.size ?? 0)
      : null
  );

  /**
   * Conversion needs the bytes on this origin: a canvas fed a cross-origin
   * image is tainted and toBlob throws. A remote GIF has no size recorded
   * either, which is the same signal, so both cases fall back to Original.
   */
  const lightboxFormats = $derived(
    lightbox && lightbox.size !== undefined
      ? convertTargets(lightbox.mimeType)
      : []
  );

  // ── Lightbox zoom ────────────────────────────────────────────────────
  let zoom = $state(MIN_ZOOM);
  let pan = $state<Point>({ x: 0, y: 0 });
  let imgEl = $state<HTMLImageElement | null>(null);
  /** Live pointers, so two of them can be read as a pinch. */
  const pointers = new Map<number, Point>();
  let pinchStart = $state<{ gap: number; zoom: number } | null>(null);
  let dragFrom = $state<{ pointer: Point; pan: Point } | null>(null);
  /**
   * A pan just happened, so the click that follows it is not a click.
   *
   * The backdrop closes the viewer, and a drag that begins on the image and
   * ends over the backdrop would otherwise close it every time.
   */
  let panned = false;

  const viewport = () => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  });

  /** The image's untransformed layout box - offsetWidth ignores transforms. */
  const layoutSize = () => ({
    width: imgEl?.offsetWidth ?? 0,
    height: imgEl?.offsetHeight ?? 0,
  });

  function resetZoom() {
    zoom = MIN_ZOOM;
    pan = { x: 0, y: 0 };
    pointers.clear();
    pinchStart = null;
    dragFrom = null;
    panned = false;
  }

  /** Zoom to `next`, holding whatever is under `at` (relative to centre). */
  function applyZoom(next: number, at: Point) {
    const to = clampZoom(next);
    if (to === zoom) return;
    pan = clampPan(zoomAbout(pan, zoom, to, at), layoutSize(), viewport(), to);
    zoom = to;
  }

  /** A pointer position relative to the image's centre. */
  function fromCentre(e: { clientX: number; clientY: number }): Point {
    const r = imgEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return {
      x: e.clientX - (r.left + r.width / 2),
      y: e.clientY - (r.top + r.height / 2),
    };
  }

  function onWheel(e: WheelEvent) {
    // Or the chat scrolls behind the overlay while you zoom.
    e.preventDefault();
    applyZoom(zoom * Math.exp(-e.deltaY * 0.0015), fromCentre(e));
  }

  /**
   * Single click, not double.
   *
   * The usual argument for double-click is that a single one dismisses the
   * viewer - but not here: only the backdrop closes it, and a click on the
   * picture itself did nothing at all. So the cheaper gesture was free, and
   * spending the expensive one bought nothing.
   *
   * A pan ends in a click, so that one is swallowed rather than toggling
   * zoom every time you finish dragging.
   */
  function onImageClick(e: MouseEvent) {
    if (panned) {
      panned = false;
      return;
    }
    if (zoom > MIN_ZOOM) {
      resetZoom();
      return;
    }
    const target = actualSizeZoom(
      imgEl?.naturalWidth ?? 0,
      imgEl?.offsetWidth ?? 0
    );
    // An image that fits already has nothing to reveal at "actual size", so
    // fall back to a plain step in rather than doing nothing.
    applyZoom(target > MIN_ZOOM ? target : 2.5, fromCentre(e));
  }

  function onPointerDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    panned = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { gap: distance(a, b), zoom };
      dragFrom = null;
    } else if (zoom > MIN_ZOOM) {
      dragFrom = { pointer: { x: e.clientX, y: e.clientY }, pan };
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const gap = distance(a, b);
      if (pinchStart.gap > 0) {
        const centre = midpoint(a, b);
        applyZoom(
          pinchStart.zoom * (gap / pinchStart.gap),
          fromCentre({ clientX: centre.x, clientY: centre.y })
        );
        panned = true;
      }
      return;
    }

    if (!dragFrom) return;
    const next = {
      x: dragFrom.pan.x + (e.clientX - dragFrom.pointer.x),
      y: dragFrom.pan.y + (e.clientY - dragFrom.pointer.y),
    };
    if (Math.abs(next.x - pan.x) > 2 || Math.abs(next.y - pan.y) > 2) {
      panned = true;
    }
    pan = clampPan(next, layoutSize(), viewport(), zoom);
  }

  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) dragFrom = null;
  }

  function openLightbox(next: Lightbox) {
    resetZoom();
    lightbox = next;
    formatsOpen = false;
    convertError = null;
    previewText = null;
    previewHtml = null;
    previewCode = null;
    previewError = null;
    previewMode = "rendered";
  }

  function closeLightbox() {
    lightbox = null;
    formatsOpen = false;
    resetZoom();
  }

  async function downloadOriginal() {
    if (!lightbox) return;
    try {
      const res = await fetch(lightbox.url);
      saveBlob(await res.blob(), lightbox.filename);
    } catch {
      // A remote GIF lives on somebody else's host, which owes us no CORS
      // header - and the <img> beside it never needed one, so "failed to
      // fetch" reads as a bug rather than as a policy. Hand the URL to the
      // browser and let it do the ordinary thing.
      const a = document.createElement("a");
      a.href = lightbox.url;
      a.download = lightbox.filename;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.click();
    }
  }

  async function downloadAs(mime: string, ext: string) {
    if (!lightbox) return;
    converting = mime;
    convertError = null;
    try {
      const res = await fetch(lightbox.url);
      const out = await convertImage(await res.blob(), mime);
      saveBlob(out, withExtension(lightbox.filename, ext));
      formatsOpen = false;
    } catch (e) {
      convertError = e instanceof Error ? e.message : String(e);
    } finally {
      converting = null;
    }
  }

  // Highlighting is its own effect so it runs immediately for a source file
  // and only on demand for markdown: the grammar chunk should not be fetched
  // for a document whose source nobody opens.
  $effect(() => {
    const open = lightbox;
    const text = previewText;
    const wantsSource = lightboxKind === "text" || previewMode === "source";
    if (!open || text === null || !wantsSource || previewCode !== null) return;
    const lang = highlightLanguage(open.filename);
    if (!lang) return;
    let cancelled = false;
    void highlightText(text, lang).then((html) => {
      // null means shiki has no grammar or could not load one, and the plain
      // <pre> underneath is already the fallback.
      if (!cancelled && html) previewCode = html;
    });
    return () => {
      cancelled = true;
    };
  });

  // Text and markdown are read when the viewer opens, not when the message
  // renders: a room full of .md attachments should not read them all.
  $effect(() => {
    const open = lightbox;
    const kind = lightboxKind;
    if (!open || (kind !== "text" && kind !== "markdown")) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await (await fetch(open.url)).text();
        if (cancelled) return;
        previewText = text;
        if (kind === "markdown") {
          const html = await renderMarkdown(text);
          if (!cancelled) previewHtml = html;
        }
      } catch (e) {
        if (!cancelled)
          previewError = e instanceof Error ? e.message : String(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });
  let copiedCode = $state(false);
  let videoPlaying = $state(false);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let videoNaturalWidth = $state(0);
  let videoNaturalHeight = $state(0);
  let pluginCardComponent = $state<PluginComponent | null>(null);
  let pluginCardState = $state<unknown>(undefined);
  let pluginCardError = $state<string | null>(null);
  let pluginCardDisabled = $state(false);
  let pluginCardPluginId = $state("");
  /** Whether the card's plugin ships a sidebar widget - gates the header's
   *  pin button. */
  let pluginHasWidget = $state(false);
  const pluginIsPinned = $derived(
    pluginPrefs.pinnedWidgets.some((p) => p.pluginId === pluginCardPluginId)
  );

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
    // The type guard comes FIRST. Every message in the scrollback mounts one
    // of these effects, and subscribing to disabledPluginIds before the guard
    // made every text, file and reaction message re-run this effect whenever
    // any plugin toggle flipped - hundreds of effects for a list that only
    // matters to plugin cards.
    if (msg.type !== MessageType.PluginCard) {
      pluginCardComponent = null;
      pluginCardError = null;
      pluginCardDisabled = false;
      return;
    }
    // Synchronous read so this effect re-runs when the user flips a plugin
    // off or on: the isPluginEnabled() call below sits after an `await` in
    // the IIFE, which is outside the tracking window and registers nothing.
    void pluginPrefs.disabledPluginIds;
    void (async () => {
      try {
        const payload = JSON.parse(content);
        const { pluginId } = payload;
        pluginCardPluginId = pluginId;
        // Checked BEFORE getPlugin: disabling a plugin has to stop its code
        // from running, and getPlugin imports and executes the module. The
        // card mounted and ran regardless of the toggle until this check
        // existed - a music-party card, for example, would start playback in
        // a room the user had explicitly opted out of.
        if (!isPluginEnabled(pluginId)) {
          pluginCardComponent = null;
          pluginCardState = undefined;
          pluginCardError = null;
          pluginCardDisabled = true;
          pluginHasWidget = false;
          return;
        }
        pluginCardDisabled = false;
        // Before loading any code: a plugin requiring host features this
        // build lacks gets a clear "update the app" line, not a crash.
        const missing = unsupportedRequirements(getManifest(pluginId));
        if (missing.length) {
          pluginCardError = `${getManifest(pluginId)?.name ?? pluginId} needs a newer awful.chat (missing: ${missing.join(", ")})`;
          return;
        }
        const plugin = await getPlugin(pluginId);
        if (!plugin) {
          pluginCardError = `Plugin ${pluginId} not found`;
          return;
        }
        pluginHasWidget = !!plugin.widget;
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
    // The whole message must be the URL - a gif link inside a sentence stays
    // a link - but the host is deliberately NOT restricted. A host allowlist
    // here rejected every ordinary place a gif lives (imgur, the Discord CDN,
    // someone's own server); those messages then fell through to the OG card,
    // and for a raw image URL the relay reads the binary body as HTML, finds
    // no meta tags and answers mediaType "none", so the user got the bare link
    // plus an empty bordered card - and every viewer of the message made the
    // relay download the image, uncached.
    //
    // It also bought nothing: the same peer-supplied link still renders the
    // OG card's og:image as an <img src>, so the browser fetch the allowlist
    // was meant to prevent happened anyway, one hop later. Loading a remote
    // image on render does expose the viewer's IP to whoever hosts it; that
    // has to be answered where every remote image goes through (a relay-side
    // image proxy), not by breaking gif links.
    const trimmed = text.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return false;
    }

    try {
      // The extension is read off the pathname so a CDN's cache-busting query
      // ("...cat.gif?width=200") still counts as an image.
      return /\.(gif|webp)$/i.test(new URL(trimmed).pathname);
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
    const match = content.match(/```([\w-]+)?\n([\s\S]*?)```/m);
    if (!match) return null;
    return { lang: match[1] || "text", code: match[2] };
  });
  const codeSegments = $derived.by(() => {
    const match = content.match(/```([\w-]+)?\n([\s\S]*?)```/m);
    if (!match) return null;
    const fullMatch = match[0];
    const startIdx = content.indexOf(fullMatch);
    const endIdx = startIdx + fullMatch.length;

    const before = content.slice(0, startIdx).trim();
    const code = match[2];
    const after = content.slice(endIdx).trim();

    return {
      before,
      lang: match[1] || "text",
      code,
      after,
    };
  });
  const linkedUrl = $derived(firstUrl(content));
  const isGifMessage = $derived(isGifUrl(content));
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
      // No hardcoded origin: an unset apiUrl means this instance never said
      // where its relay is, and defaulting to awful.frav.in would hand every
      // link its users open to a stranger's server. Empty resolves
      // same-origin and 404s, so previews are simply off.
      `${apiUrl()}/og/preview?url=${encodeURIComponent(linkedUrl)}`,
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
    if (!isGifMessage || !content) return;
    isGifSaved(content).then((saved) => {
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
    if (!isGifMessage || !content) return;
    const existing = await isGifSaved(content);
    if (existing) {
      await deleteSavedGif(existing.id);
      gifSaved = false;
      return;
    }
    await putSavedGif({
      // Keyed by the gif URL: double-taps upsert instead of duplicating.
      id: content,
      gifId: content,
      title: `GIF from ${msg.senderName}`,
      url: content,
      previewUrl: content,
      savedAt: Date.now(),
    });
    gifSaved = true;
  }

  let copiedPreview = $state(false);

  /**
   * Copies the SOURCE, not what is on screen. In rendered markdown the
   * screen holds prose that was never in the file, and the thing worth
   * putting on a clipboard is the markdown itself.
   */
  async function copyPreview() {
    if (previewText === null) return;
    try {
      await navigator.clipboard.writeText(previewText);
      copiedPreview = true;
      setTimeout(() => (copiedPreview = false), 1200);
    } catch {
      // Clipboard blocked (insecure context, denied permission): the text is
      // on screen and selectable, so there is nothing to recover from.
    }
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
    {#if content}
      <!-- Through linkifyText like every other body: rendered raw, a caption
           showed mention tokens as @[did:key:...] instead of the name. -->
      <p class="whitespace-pre-wrap mb-2">{@html linkifyText(content)}</p>
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

            <!-- Own messages included: a file above the persistence cap is
                 gone from this device after a reload, and the only way back
                 is pulling it from a peer who still holds it. -->
            {#if !transfer || transfer.status === "pending" || transfer.status === "failed"}
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

          {#if file.mimeType.startsWith("image/")}
            {@const box = mediaBoxStyle(file.width, file.height)}
            {#if !transfer?.blobURL}
              <!-- The picture's own shape, held open before a single byte of
                   it has arrived. This is what stops the chat jumping as
                   images finish: the space they will need is already spent,
                   so nothing below them moves when they land. Only possible
                   because the sender measured and sent the dimensions - an
                   older sender omits them, box is "", and this renders
                   nothing at all rather than a wrongly sized guess that
                   would jump anyway.

                   Gated on bytes being EXPECTED (see expectsBytesSoon), not
                   merely absent: a large attachment nobody asked to download
                   would otherwise sit here pulsing for the life of the
                   session next to its own Download button. -->
              {#if box && expectsBytesSoon(transfer?.status, file.size)}
                <div
                  class="mt-2 animate-pulse rounded-md bg-muted/60"
                  style={box}
                  aria-hidden="true"
                ></div>
              {:else if box && (!transfer || transfer.status === "pending" || transfer.status === "failed")}
                <!-- Auto-download off (or failed): the picture's space is
                     still held open, with the fetch one click away ON the
                     picture instead of only up in the chip. -->
                <div class="relative mt-2 rounded-md bg-muted/40" style={box}>
                  <button
                    type="button"
                    onclick={() => onRequestFileDownload(file, msg.senderId)}
                    aria-label={`Download ${file.filename}`}
                    class="absolute inset-0 flex cursor-pointer items-center justify-center"
                  >
                    <span
                      class="flex size-10 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm transition hover:bg-background"
                    >
                      <Download class="size-4" />
                    </span>
                  </button>
                </div>
              {/if}
            {:else}
            <div class="group/gif relative mt-2 inline-block">
              <!-- The box lives on the button, not on GifImage: the same
                   style the skeleton wore, so the swap costs no reflow. -->
              <button
                type="button"
                class="block"
                style={box}
                onclick={() =>
                  openLightbox({
                    url: transfer.blobURL!,
                    filename: file.filename,
                    mimeType: file.mimeType,
                    size: file.size,
                  })}
              >
                <GifImage
                  src={transfer.blobURL}
                  alt={file.filename}
                  class="{box
                    ? 'h-full w-full'
                    : 'max-w-xs max-h-56'} rounded-md object-contain"
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
            {/if}
          {:else if file.mimeType.startsWith("video/")}
            {@const box = mediaBoxStyle(file.width, file.height)}
            {#if !transfer?.blobURL}
              <!-- Same reservation an image gets, on the same condition. A
                   video shifts too: with no dimensions the browser lays out
                   a default 300x150 box and resizes once metadata arrives. -->
              {#if box && expectsBytesSoon(transfer?.status, file.size)}
                <div
                  class="mt-2 animate-pulse rounded-md bg-muted/60"
                  style={box}
                  aria-hidden="true"
                ></div>
              {:else if box && (!transfer || transfer.status === "pending" || transfer.status === "failed")}
                <!-- Same held-open frame and on-media Download as an image. -->
                <div class="relative mt-2 rounded-md bg-muted/40" style={box}>
                  <button
                    type="button"
                    onclick={() => onRequestFileDownload(file, msg.senderId)}
                    aria-label={`Download ${file.filename}`}
                    class="absolute inset-0 flex cursor-pointer items-center justify-center"
                  >
                    <span
                      class="flex size-10 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm transition hover:bg-background"
                    >
                      <Download class="size-4" />
                    </span>
                  </button>
                </div>
              {/if}
            {:else}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={transfer.blobURL}
              controls
              preload="metadata"
              style={box}
              class="mt-2 {box ? '' : 'max-w-xs max-h-56'} rounded-md"
            ></video>
            {/if}
          {:else if transfer?.blobURL && file.mimeType.startsWith("audio/")}
            <AudioPlayer
              src={transfer.blobURL}
              label={file.filename}
              class="mt-2 max-w-xs"
            />
          {:else if transfer?.blobURL}
            <!-- A readable file gets both: reading it here and keeping a copy
                 are different intentions, and collapsing them into one link
                 meant picking one for the reader. -->
            <div class="mt-2 flex flex-wrap items-center gap-3">
              {#if previewKind(file.filename, file.mimeType, file.size)}
                <button
                  type="button"
                  onclick={() =>
                    openLightbox({
                      url: transfer.blobURL!,
                      filename: file.filename,
                      mimeType: file.mimeType,
                      size: file.size,
                    })}
                  class="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
                >
                  <FileText class="size-3.5" />
                  Open
                </button>
              {/if}
              <a
                href={transfer.blobURL}
                download={file.filename}
                class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Download class="size-3.5" />
                Download
              </a>
            </div>
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
      <button
        type="button"
        onclick={() =>
          openLightbox({
            url: content,
            filename: "gif.gif",
            mimeType: "image/gif",
          })}
      >
        <GifImage
          src={content}
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
    {#if pluginCardDisabled}
      <!-- Not the error box: the user asked for this, so it is muted like the
           loading state rather than shouting in destructive red. -->
      <div class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-muted/50 text-muted-foreground text-sm">
        <Unplug class="size-4 shrink-0" />
        {getManifest(pluginCardPluginId)?.name ?? pluginCardPluginId} is disabled
      </div>
    {:else if pluginCardError}
      <div class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
        <Unplug class="size-4 shrink-0" />
        Plugin error: {pluginCardError}
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
        class="inline-block min-w-[min(42rem,100%)] min-h-24 max-w-full rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5"
      >
        <div class="mb-1.5 flex items-center justify-between gap-1.5">
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
          {#if pluginHasWidget}
            <Tip
              text={pluginIsPinned
                ? "Unpin from the sidebar"
                : "Pin this plugin to the sidebar"}
            >
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  onclick={() =>
                    pluginIsPinned
                      ? unpinWidget(pluginCardPluginId)
                      : pinWidget(pluginCardPluginId)}
                  aria-label={pluginIsPinned
                    ? "Unpin from the sidebar"
                    : "Pin this plugin to the sidebar"}
                  aria-pressed={pluginIsPinned}
                  class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] transition-colors {pluginIsPinned
                    ? 'text-primary hover:text-muted-foreground'
                    : 'text-muted-foreground hover:text-primary'}"
                >
                  {#if pluginIsPinned}<PinOff class="size-3" />{:else}<PinIcon
                      class="size-3"
                    />{/if}
                  {pluginIsPinned ? "pinned" : "pin"}
                </button>
              {/snippet}
            </Tip>
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
    <p class="whitespace-pre-wrap">{@html linkifyText(content)}</p>

    {#if linkedUrl && ogPreview}
      <div
        class="mt-2 max-w-sm overflow-hidden rounded-lg border border-border/70 bg-card"
      >
        {#if ogPreview.mediaType === "video" && ogPreview.video}
          {#if videoPlaying}
            <div class="w-full bg-black" style={videoAspectStyle}>
              <!-- svelte-ignore a11y_media_has_caption -->
              <!-- No referrerpolicy here: <video> does not support the
                   attribute, so this fetch still carries the document
                   referrer. It is at least behind an explicit play click,
                   unlike the poster image below. -->
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
                  referrerpolicy="no-referrer"
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
              referrerpolicy="no-referrer"
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

{#if lightbox}
  <div
    class="fixed inset-0 z-50 grid place-items-center p-4"
    role="dialog"
    aria-modal="true"
    tabindex="0"
    onkeydown={(e) => {
      if (e.key === "Escape") closeLightbox();
    }}
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/80"
      onclick={closeLightbox}
      aria-label="Close preview"
    ></button>

    <!-- Reset, open, download, formats, close - the destructive one last,
         and the pair that belong together sitting together. -->
    <div class="absolute right-4 top-4 z-20 flex items-center gap-1.5">
      {#if lightboxKind === "image" && zoom > MIN_ZOOM}
        <!-- Only once there is something to reset. Clicking the picture does
             it too, but nothing on screen ever said so. -->
        <Tip text="Reset zoom">
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              class="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-black/60 px-3 font-mono text-xs text-white hover:bg-black/80"
              onclick={resetZoom}
              aria-label="Reset zoom"
            >
              <Minimize2 class="size-4" />
              {zoom.toFixed(1)}x
            </button>
          {/snippet}
        </Tip>
      {/if}

      <Tip text="Open in a new tab">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            class="size-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center hover:bg-black/80 cursor-pointer"
            onclick={() =>
              window.open(lightbox!.url, "_blank", "noopener,noreferrer")}
            aria-label="Open in a new tab"
          >
            <ExternalLink class="size-4" />
          </button>
        {/snippet}
      </Tip>
      <Tip text="Download original">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            class="size-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center hover:bg-black/80 cursor-pointer"
            onclick={downloadOriginal}
            aria-label="Download original"
          >
            <Download class="size-4" />
          </button>
        {/snippet}
      </Tip>

      {#if lightboxFormats.length}
        <div class="relative">
          <Tip text="Download as...">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                class="size-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center hover:bg-black/80 cursor-pointer"
                onclick={() => (formatsOpen = !formatsOpen)}
                aria-haspopup="menu"
                aria-expanded={formatsOpen}
                aria-label="Download as another format"
              >
                <ChevronDown class="size-4" />
              </button>
            {/snippet}
          </Tip>
          {#if formatsOpen}
            <div
              role="menu"
              tabindex="-1"
              class="absolute right-0 top-11 min-w-36 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg"
            >
              {#each lightboxFormats as fmt (fmt.mime)}
                <button
                  type="button"
                  role="menuitem"
                  disabled={converting !== null}
                  class="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-mono text-xs text-popover-foreground hover:bg-muted disabled:opacity-60 cursor-pointer"
                  onclick={() => downloadAs(fmt.mime, fmt.ext)}
                >
                  {fmt.label}
                  {#if converting === fmt.mime}
                    <span class="text-muted-foreground">...</span>
                  {/if}
                </button>
              {/each}
              {#if lightbox.mimeType === "image/gif"}
                <!-- Said plainly rather than discovered afterwards: a canvas
                     holds one frame, so every conversion here is a still. -->
                <p
                  class="border-t border-border/60 px-3 pt-1.5 pb-1 font-mono text-[10px] leading-snug text-muted-foreground"
                >
                  Saves a single frame. Use Download original to keep the
                  animation.
                </p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <Tip text="Close">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            class="size-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center hover:bg-black/80 cursor-pointer"
            onclick={closeLightbox}
            aria-label="Close"
          >
            <X class="size-4" />
          </button>
        {/snippet}
      </Tip>
    </div>

    {#if convertError}
      <p
        class="absolute right-4 top-16 z-20 max-w-72 rounded-md bg-destructive/90 px-3 py-2 font-mono text-xs text-white"
      >
        {convertError}
      </p>
    {/if}

    {#if lightboxKind === "image"}
      <!-- A div, not a button: it carries drag handlers, and a draggable
           button is neither. It still has to be operable from a keyboard,
           so it takes focus and answers Enter and Space the way the click
           does. Escape and the backdrop still close it. -->
      <div
        role="button"
        tabindex="0"
        aria-label={zoom > MIN_ZOOM ? "Reset zoom" : "Zoom in"}
        onkeydown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          // Escape must keep closing the viewer, so only these two are taken.
          onImageClick(e as unknown as MouseEvent);
        }}
        class="relative z-10 touch-none select-none"
        style="cursor: {dragFrom
          ? 'grabbing'
          : zoom > MIN_ZOOM
            ? 'zoom-out'
            : 'zoom-in'}"
        onwheel={onWheel}
        onclick={onImageClick}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <img
          bind:this={imgEl}
          src={lightbox.url}
          alt="Preview"
          draggable="false"
          class="max-h-[90vh] max-w-[90vw] rounded-md object-contain"
          style="transform: translate({pan.x}px, {pan.y}px) scale({zoom}); transition: {dragFrom ||
          pinchStart
            ? 'none'
            : 'transform 120ms ease-out'}"
        />
      </div>
    {:else}
      <div
        class="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-border bg-background"
      >
        <div
          class="flex items-center gap-2 border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground"
        >
          <FileText class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{lightbox.filename}</span>
          {#if lightboxKind === "markdown"}
            <!-- Rendered is the default because it is what the file is for,
                 but the source is the file - a link target, a code fence, a
                 stray backtick - and there is no way back to it once the
                 markdown has been turned into prose. -->
            <div
              class="flex shrink-0 overflow-hidden rounded border border-border"
            >
              {#each [{ id: "rendered", label: "Rendered" }, { id: "source", label: "Source" }] as tab (tab.id)}
                <button
                  type="button"
                  aria-pressed={previewMode === tab.id}
                  onclick={() =>
                    (previewMode = tab.id as "rendered" | "source")}
                  class="cursor-pointer px-2 py-0.5 transition-colors {previewMode ===
                  tab.id
                    ? 'bg-primary/15 text-foreground'
                    : 'hover:bg-muted'}"
                >
                  {tab.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-4">
          {#if previewText !== null}
            <!-- A zero-height sticky row, so the button hangs over the top
                 right corner and stays there while the file scrolls under
                 it. Taking it out of flow instead - absolute, with the
                 scroller absolute behind it - left this panel with no
                 in-flow content at all, so flex-1 had nothing to size
                 against and the whole viewer collapsed to its header. -->
            <div class="sticky top-0 z-10 flex h-0 justify-end">
              <button
                type="button"
                onclick={copyPreview}
                aria-label={copiedPreview ? "Copied" : "Copy contents"}
                class="inline-flex size-7 cursor-pointer items-center justify-center rounded border border-border/70 bg-card text-muted-foreground hover:text-foreground"
              >
                {#if copiedPreview}
                  <Check class="size-3.5" />
                {:else}
                  <Copy class="size-3.5" />
                {/if}
              </button>
            </div>
          {/if}
          {#if previewError}
            <p class="font-mono text-xs text-destructive">{previewError}</p>
          {:else if lightboxKind === "markdown" && previewMode === "rendered"}
            {#if previewHtml}
              <!-- Sanitized in renderMarkdown before it ever reaches here;
                   the source is a file another person sent. -->
              <div class="md-preview">{@html previewHtml}</div>
            {:else}
              <p class="font-mono text-xs text-muted-foreground">Loading...</p>
            {/if}
          {:else if previewCode || previewText !== null}
            <!-- One box for both renderings. The plain pre shows first and
                 shiki replaces it a moment later, so the two have to occupy
                 exactly the same space: same padding, same line height, and
                 above all the same wrapping. The fallback used to wrap while
                 shiki's output scrolls, so a file with long lines changed
                 height the instant highlighting arrived. -->
            <div class="code-preview">
              {#if previewCode}
                <!-- shiki's own markup, from our own source string. -->
                {@html previewCode}
              {:else}
                <pre>{previewText}</pre>
              {/if}
            </div>
          {:else}
            <p class="font-mono text-xs text-muted-foreground">Loading...</p>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Rendered markdown. Tailwind's Preflight strips heading and list styling
     app-wide, which is right for chat and wrong inside a document, so this
     puts back only what a .md needs to be readable. Scoped to .md-preview so
     none of it can leak into a message body. */
  /* Against the global heading rule in app.css: this panel exists to be
     read and copied, and there a heading is content. */
  .md-preview,
  .md-preview :global(*) {
    user-select: text;
    -webkit-user-select: text;
  }
  .md-preview :global(h1),
  .md-preview :global(h2),
  .md-preview :global(h3) {
    font-weight: 600;
    line-height: 1.3;
    margin: 1.2em 0 0.5em;
  }
  .md-preview :global(h1) {
    font-size: 1.5rem;
  }
  .md-preview :global(h2) {
    font-size: 1.25rem;
  }
  .md-preview :global(h3) {
    font-size: 1.1rem;
  }
  .md-preview :global(h1:first-child),
  .md-preview :global(h2:first-child),
  .md-preview :global(h3:first-child) {
    margin-top: 0;
  }
  .md-preview :global(p),
  .md-preview :global(ul),
  .md-preview :global(ol),
  .md-preview :global(blockquote),
  .md-preview :global(pre),
  .md-preview :global(table) {
    margin: 0.75em 0;
  }
  .md-preview :global(ul) {
    list-style: disc;
    padding-left: 1.5em;
  }
  .md-preview :global(ol) {
    list-style: decimal;
    padding-left: 1.5em;
  }
  .md-preview :global(li) {
    margin: 0.25em 0;
  }
  .md-preview :global(a) {
    color: var(--primary);
    text-decoration: underline;
  }
  .md-preview :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.875em;
    background: color-mix(in oklab, var(--muted) 60%, transparent);
    border-radius: 0.25rem;
    padding: 0.1em 0.3em;
  }
  .md-preview :global(pre) {
    /* Wide code scrolls inside its own box, so the viewer never scrolls
       sideways as a whole. */
    overflow-x: auto;
    background: color-mix(in oklab, var(--muted) 40%, transparent);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.75rem;
  }
  .md-preview :global(pre code) {
    background: none;
    padding: 0;
  }
  .md-preview :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .md-preview :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .md-preview :global(th),
  .md-preview :global(td) {
    border: 1px solid var(--border);
    padding: 0.35em 0.6em;
    text-align: left;
  }
  .md-preview :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.375rem;
  }
  .md-preview :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1.25em 0;
  }
  /* The container owns the ground and the padding so that the plain pre and
     shiki's pre are interchangeable. shiki paints its own background inline,
     which would otherwise be the one visible difference between them - the
     same reason chat code blocks force it transparent. */
  .code-preview {
    background: color-mix(in oklab, var(--muted) 40%, transparent);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    /* Wide lines scroll inside the block; the panel itself must not. */
    overflow-x: auto;
  }
  .code-preview :global(pre) {
    margin: 0;
    /* Extra room on the right so the copy button never covers the end of
       the first line. */
    padding: 0.75rem 2.75rem 0.75rem 0.75rem;
    background: transparent !important;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    line-height: 1.6;
    /* Not pre-wrap: shiki does not wrap, and a fallback that did changed the
       line count, and so the height, the moment highlighting landed. */
    white-space: pre;
    color: var(--foreground);
  }
  .code-preview :global(.shiki) {
    color: inherit;
  }
</style>
