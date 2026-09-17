<script lang="ts">
  import GifImage from "./GifImage.svelte";
  import { onDestroy } from "svelte";
  import { Bookmark, Search, X, Loader } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { searchGifs, getTrendingGifs, type KlipyGif } from "$lib/klipy";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import {
    getAllSavedGifs,
    putSavedGif,
    deleteSavedGif,
    isGifSaved,
    type SavedGif,
  } from "$lib/storage";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (url: string) => void;
    /** Selection of a saved UPLOADED gif - bytes, not a url. */
    onSelectFile?: (file: File) => void;
  }

  let { open, onOpenChange, onSelect, onSelectFile }: Props = $props();

  type Tab = "saved" | "popular";

  interface DisplayGif {
    id: string;
    gifId?: string;
    title: string;
    url?: string;
    previewUrl?: string;
    urls?: KlipyGif["urls"];
    /** Present on saved uploaded gifs: the bytes to re-send as a file. */
    file?: File;
  }

  let tab = $state<Tab>("saved");
  let query = $state("");
  let debouncedQuery = $state("");
  let debounceTimer: ReturnType<typeof setTimeout>;
  let popularGifs = $state<DisplayGif[]>([]);
  let searchResults = $state<DisplayGif[]>([]);
  let savedGifs = $state<DisplayGif[]>([]);
  let savedIds = $state(new Set<string>());
  let loading = $state(false);
  let page = $state(1);
  let hasMore = $state(true);
  let sentinelEl = $state<HTMLDivElement | undefined>(undefined);
  let observer: IntersectionObserver | undefined;
  let nextPageBackoffAttempt = $state(0);
  let nextPageRetryAfter = $state(0);
  let trendingAttempted = $state(false);

  const MAX_BACKOFF_MS = 30_000;

  function nextBackoffMs(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  }

  function resetBackoff() {
    nextPageBackoffAttempt = 0;
    nextPageRetryAfter = 0;
  }

  /** Object URLs created for saved uploaded gifs; revoked on reload/close. */
  let savedBlobUrls: string[] = [];

  async function loadSavedGifs() {
    const gifs = await getAllSavedGifs();
    savedBlobUrls.forEach((u) => URL.revokeObjectURL(u));
    savedBlobUrls = [];
    savedGifs = gifs
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((g) => {
        if (!g.data) {
          return {
            id: g.id,
            gifId: g.gifId,
            title: g.title,
            url: g.url,
            previewUrl: g.previewUrl,
          };
        }
        // Uploaded gif: no CDN url anywhere, preview and re-send both come
        // from the stored bytes.
        const file = new File([g.data], g.title || "saved.gif", {
          type: g.mimeType || "image/gif",
        });
        const blobUrl = URL.createObjectURL(file);
        savedBlobUrls.push(blobUrl);
        return {
          id: g.id,
          gifId: g.gifId,
          title: g.title,
          previewUrl: blobUrl,
          file,
        };
      });
    savedIds = new Set(gifs.map((g) => g.gifId));
  }

  onDestroy(() => {
    savedBlobUrls.forEach((u) => URL.revokeObjectURL(u));
  });

  async function loadTrending(pageNum: number, append = false) {
    loading = true;
    try {
      const result = await getTrendingGifs(18, pageNum);
      const gifs = result.gifs as DisplayGif[];
      popularGifs = append ? [...popularGifs, ...gifs] : gifs;
      hasMore = result.hasMore;
    } finally {
      loading = false;
      if (pageNum === 1) trendingAttempted = true;
    }
  }

  async function loadSearch(
    searchQuery: string,
    pageNum: number,
    append = false
  ) {
    loading = true;
    try {
      const result = await searchGifs(searchQuery, 18, pageNum);
      const gifs = result.gifs as DisplayGif[];
      searchResults = append ? [...searchResults, ...gifs] : gifs;
      hasMore = result.hasMore;
    } finally {
      loading = false;
    }
  }

  async function fetchGifPage(
    pageNum: number,
    append = false
  ): Promise<boolean> {
    if (Date.now() < nextPageRetryAfter) return false;

    try {
      if (debouncedQuery.trim()) {
        await loadSearch(debouncedQuery, pageNum, append);
      } else {
        await loadTrending(pageNum, append);
      }
      resetBackoff();
      return true;
    } catch {
      const delay = nextBackoffMs(nextPageBackoffAttempt);
      nextPageBackoffAttempt += 1;
      nextPageRetryAfter = Date.now() + delay;
      return false;
    }
  }

  $effect(() => {
    if (open) {
      tab = "saved";
      query = "";
      debouncedQuery = "";
      page = 1;
      hasMore = true;
      popularGifs = [];
      searchResults = [];
      trendingAttempted = false;
      resetBackoff();
      loadSavedGifs();
    }
  });

  $effect(() => {
    if (
      open &&
      tab === "popular" &&
      debouncedQuery === "" &&
      !trendingAttempted
    ) {
      void fetchGifPage(1);
    }
  });

  $effect(() => {
    clearTimeout(debounceTimer);
    const val = query;
    if (!val.trim()) {
      debouncedQuery = "";
      searchResults = [];
      page = 1;
      hasMore = true;
      resetBackoff();
      return;
    }
    debounceTimer = setTimeout(() => {
      debouncedQuery = val;
      page = 1;
      hasMore = true;
      resetBackoff();
      void fetchGifPage(1);
    }, 320);
  });

  $effect(() => {
    // Reset the trending attempted flag when conditions change
    if (!(open && tab === "popular" && debouncedQuery === "")) {
      trendingAttempted = false;
    }
  });

  $effect(() => {
    if (!sentinelEl) return;
    observer?.disconnect();

    const isSearching = debouncedQuery.trim() !== "";
    const isPopular = tab === "popular" && !isSearching;

    if (!isSearching && !isPopular) return;

    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore) {
          const next = page + 1;
          void fetchGifPage(next, true).then((ok) => {
            if (ok) page = next;
          });
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinelEl);
    return () => observer?.disconnect();
  });

  const displayGifs = $derived<DisplayGif[]>(
    debouncedQuery.trim()
      ? searchResults
      : tab === "saved"
        ? savedGifs
        : popularGifs
  );

  const validGifs = $derived(
    displayGifs.filter(
      (g) => g.urls?.tinygif || g.urls?.mediumgif || g.previewUrl
    )
  );

  function handleSelect(gif: DisplayGif) {
    const url = gif.urls?.gif || gif.url || "";
    if (gif.file && onSelectFile) onSelectFile(gif.file);
    else if (url) onSelect(url);
    else return;
    onOpenChange(false);
    query = "";
    page = 1;
    popularGifs = [];
    searchResults = [];
    resetBackoff();
  }

  async function toggleSave(e: MouseEvent, gif: DisplayGif) {
    e.stopPropagation();

    if (gif.urls) {
      const klipyGif = gif as unknown as KlipyGif;
      const existing = await isGifSaved(klipyGif.id);
      if (existing) {
        await deleteSavedGif(existing.id);
        savedIds = new Set([...savedIds].filter((id) => id !== klipyGif.id));
        savedGifs = savedGifs.filter((g) => g.gifId !== klipyGif.id);
      } else {
        const saved: SavedGif = {
          // Keyed by the gif itself: a double-tap upserts instead of
          // stranding a duplicate row that un-saving misses.
          id: klipyGif.id,
          gifId: klipyGif.id,
          title: klipyGif.title,
          url: klipyGif.urls.gif,
          previewUrl: klipyGif.urls.mediumgif || klipyGif.urls.tinygif,
          savedAt: Date.now(),
        };
        await putSavedGif(saved);
        savedIds = new Set([...savedIds, klipyGif.id]);
        savedGifs = [
          {
            id: saved.id,
            gifId: saved.gifId,
            title: saved.title,
            url: saved.url,
            previewUrl: saved.previewUrl,
          },
          ...savedGifs,
        ];
      }
    } else if (gif.gifId) {
      const existing = await isGifSaved(gif.gifId);
      if (existing) {
        await deleteSavedGif(existing.id);
        savedIds = new Set([...savedIds].filter((id) => id !== gif.gifId));
        savedGifs = savedGifs.filter((g) => g.gifId !== gif.gifId);
      }
    }
  }

  let isMobile = $state(false);

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
</script>

{#snippet GifPickerContent()}
  <div class="px-4 pb-2 mt-4 space-y-2">
    <div class="relative">
      <Search
        class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none"
      />
      <Input
        value={query}
        oninput={(e) => (query = (e.target as HTMLInputElement).value)}
        placeholder="Search GIFs..."
        class="pl-8 font-mono text-sm"
      />
      {#if query}
        <button
          type="button"
          onclick={() => (query = "")}
          class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X class="size-4" />
        </button>
      {/if}
    </div>

    {#if !query.trim()}
      <div class="flex gap-1">
        <Button
          variant={tab === "saved" ? "secondary" : "ghost"}
          size="sm"
          onclick={() => (tab = "saved")}
          class="gap-1.5 font-mono text-xs cursor-pointer"
        >
          <Bookmark class="size-4" />
          Saved
        </Button>
        <Button
          variant={tab === "popular" ? "secondary" : "ghost"}
          size="sm"
          onclick={() => {
            tab = "popular";
            if (popularGifs.length === 0) void fetchGifPage(1);
          }}
          class="font-mono text-xs cursor-pointer"
        >
          Popular
        </Button>
      </div>
    {/if}
  </div>

  <ScrollArea class="flex-1 min-h-0">
    <div class="p-4 pt-0">
      {#if loading && validGifs.length === 0}
        <div class="flex items-center justify-center py-8">
          <Loader class="size-6 animate-spin text-muted-foreground" />
        </div>
      {:else if validGifs.length === 0}
        <div class="text-center py-8 text-muted-foreground text-sm font-mono">
          {#if query.trim()}
            No GIFs found
          {:else if tab === "saved"}
            No saved GIFs yet
          {:else}
            No GIFs available
          {/if}
        </div>
      {:else}
        <div class="grid grid-cols-3 gap-1 pb-4">
          {#each validGifs as gif, idx (idx === validGifs.length - 1 ? `load-more-${gif.gifId ?? gif.id}` : (gif.gifId ?? gif.id))}
            {@const gifUrl = gif.urls?.gif || gif.url || ""}
            {@const previewUrl =
              gif.urls?.mediumgif || gif.urls?.tinygif || gif.previewUrl || ""}
            {@const resolvedId = gif.gifId || gif.id}
            {@const isSaved = savedIds.has(resolvedId)}
            {@const isLarge = (idx + 1) % 7 === 0}
            <div
              role="button"
              tabindex="0"
              onclick={() => handleSelect(gif)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelect(gif);
                }
              }}
              class="relative group rounded-md overflow-hidden bg-muted cursor-pointer aspect-square
                {isLarge ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1'}
                {!gifUrl && !gif.file ? 'opacity-50 cursor-not-allowed' : ''}"
            >
              <GifImage
                src={previewUrl}
                alt={gif.title}
                loading="lazy"
                class="w-full h-full object-cover"
              />
              <button
                type="button"
                onclick={(e) => toggleSave(e, gif)}
                class="absolute top-1 right-1 size-7 rounded-full flex items-center justify-center transition-opacity cursor-pointer
                  {isSaved
                  ? 'bg-primary text-primary-foreground opacity-100'
                  : 'bg-black/70 text-white opacity-0 group-hover:opacity-100'}"
                aria-label={isSaved ? "Unsave GIF" : "Save GIF"}
              >
                <Bookmark class="size-4 {isSaved ? 'fill-current' : ''}" />
              </button>
            </div>
            {#if idx === validGifs.length - 1}
              <div bind:this={sentinelEl} class="col-span-3 h-1"></div>
            {/if}
          {/each}
        </div>
        {#if loading}
          <div class="flex items-center justify-center py-4">
            <Loader class="size-5 animate-spin text-muted-foreground" />
          </div>
        {/if}
      {/if}
    </div>
  </ScrollArea>

  <div class="px-4 pb-3 text-center shrink-0">
    <a
      href="https://klipy.com"
      target="_blank"
      rel="noopener noreferrer"
      class="text-xs text-muted-foreground hover:text-foreground font-mono transition-colors"
    >
      Powered by KLIPY
    </a>
  </div>
{/snippet}

{#if isMobile}
  <Drawer {open} {onOpenChange} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground overflow-hidden">
      <div use:viewportHeight class="flex flex-col w-full overflow-hidden">
        <DrawerHeader class="px-4 py-3 border-b border-border shrink-0">
          <DrawerTitle class="font-mono text-base font-semibold mx-auto"
            >Choose a GIF
          </DrawerTitle>
        </DrawerHeader>
        {@render GifPickerContent()}
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog.Root {open} {onOpenChange}>
    <Dialog.Content
      class="sm:max-w-lg h-1/2 flex flex-col p-0 overflow-hidden font-mono"
    >
      <Dialog.Header class="p-4 pb-0 shrink-0">
        <Dialog.Title class="font-mono text-base font-semibold">Choose a GIF</Dialog.Title>
      </Dialog.Header>
      {@render GifPickerContent()}
    </Dialog.Content>
  </Dialog.Root>
{/if}
