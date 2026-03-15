<script lang="ts">
  import { Bookmark, Search, X, Loader2 } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { searchGifs, getTrendingGifs, type KlipyGif } from "$lib/klipy";
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
  }

  let { open, onOpenChange, onSelect }: Props = $props();

  type Tab = "saved" | "popular";

  interface DisplayGif {
    id: string;
    gifId?: string;
    title: string;
    url?: string;
    previewUrl?: string;
    urls?: KlipyGif["urls"];
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

  async function loadSavedGifs() {
    const gifs = await getAllSavedGifs();
    savedGifs = gifs
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((g) => ({
        id: g.id,
        gifId: g.gifId,
        title: g.title,
        url: g.url,
        previewUrl: g.previewUrl,
      }));
    savedIds = new Set(gifs.map((g) => g.gifId));
  }

  async function loadTrending(pageNum: number, append = false) {
    loading = true;
    try {
      const result = await getTrendingGifs(18, pageNum);
      const gifs = result.gifs as DisplayGif[];
      popularGifs = append ? [...popularGifs, ...gifs] : gifs;
      hasMore = result.hasMore;
    } finally {
      loading = false;
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

  $effect(() => {
    if (open) {
      tab = "saved";
      query = "";
      debouncedQuery = "";
      page = 1;
      hasMore = true;
      popularGifs = [];
      searchResults = [];
      loadSavedGifs();
    }
  });

  $effect(() => {
    if (
      open &&
      tab === "popular" &&
      debouncedQuery === "" &&
      popularGifs.length === 0
    ) {
      loadTrending(1);
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
      return;
    }
    debounceTimer = setTimeout(() => {
      debouncedQuery = val;
      page = 1;
      hasMore = true;
      loadSearch(val, 1);
    }, 320);
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
          page = next;
          if (debouncedQuery.trim()) {
            loadSearch(debouncedQuery, next, true);
          } else {
            loadTrending(next, true);
          }
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

  function handleSelect(url: string) {
    onSelect(url);
    onOpenChange(false);
    query = "";
    page = 1;
    popularGifs = [];
    searchResults = [];
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
          id: crypto.randomUUID(),
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
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content
    class="sm:max-w-lg h-1/2 flex flex-col p-0 overflow-hidden font-mono"
  >
    <Dialog.Header class="p-4 pb-0 shrink-0">
      <Dialog.Title class="text-sm font-semibold">Choose a GIF</Dialog.Title>
    </Dialog.Header>

    <div class="px-4 pb-2 space-y-2 shrink-0">
      <div class="relative">
        <Search
          class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none"
        />
        <Input
          value={query}
          oninput={(e) => (query = (e.target as HTMLInputElement).value)}
          placeholder="Search KLIPY..."
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
            <Bookmark class="size-3.5" />
            Saved
          </Button>
          <Button
            variant={tab === "popular" ? "secondary" : "ghost"}
            size="sm"
            onclick={() => {
              tab = "popular";
              if (popularGifs.length === 0) loadTrending(1);
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
            <Loader2 class="size-6 animate-spin text-muted-foreground" />
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
                gif.urls?.mediumgif ||
                gif.urls?.tinygif ||
                gif.previewUrl ||
                ""}
              {@const resolvedId = gif.gifId || gif.id}
              {@const isSaved = savedIds.has(resolvedId)}
              {@const isLarge = (idx + 1) % 7 === 0}
              <div
                role="button"
                tabindex="0"
                onclick={() => gifUrl && handleSelect(gifUrl)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (gifUrl) handleSelect(gifUrl);
                  }
                }}
                class="relative group rounded-md overflow-hidden bg-muted cursor-pointer aspect-square
                  {isLarge ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1'}
                  {!gifUrl ? 'opacity-50 cursor-not-allowed' : ''}"
              >
                <img
                  src={previewUrl}
                  alt={gif.title}
                  loading="lazy"
                  class="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onclick={(e) => toggleSave(e, gif)}
                  class="absolute top-1 right-1 size-6 rounded-full flex items-center justify-center transition-opacity cursor-pointer
                    {isSaved
                    ? 'bg-primary text-primary-foreground opacity-100'
                    : 'bg-black/50 text-white opacity-0 group-hover:opacity-100'}"
                  aria-label={isSaved ? "Unsave GIF" : "Save GIF"}
                >
                  <Bookmark class="size-3.5 {isSaved ? 'fill-current' : ''}" />
                </button>
              </div>
              {#if idx === validGifs.length - 1}
                <div bind:this={sentinelEl} class="col-span-3 h-1"></div>
              {/if}
            {/each}
          </div>
          {#if loading}
            <div class="flex items-center justify-center py-4">
              <Loader2 class="size-5 animate-spin text-muted-foreground" />
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
  </Dialog.Content>
</Dialog.Root>
