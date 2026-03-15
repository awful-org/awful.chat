<script lang="ts">
  import { createInfiniteQuery } from "@tanstack/svelte-query";
  import { X, Upload, Search, Link } from "@lucide/svelte";
  import { Dialog as DialogPrimitive } from "bits-ui";
  import Button from "$lib/components/ui/button/button.svelte";
  import Input from "$lib/components/ui/input/input.svelte";
  import { saveAvatar, profileStore } from "$lib/profile.svelte";
  import {
    searchGifs,
    getTrendingGifs,
    type KlipyGif,
    type KlipyResult,
  } from "$lib/klipy";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  type Tab = "upload" | "klipy" | "url";
  let activeTab = $state<Tab>("klipy");
  let preview = $state<string | undefined>(profileStore.avatarUrl);

  $effect(() => {
    preview = profileStore.avatarUrl;
  });

  let urlInput = $state("");
  let searchQuery = $state("");
  let debouncedQuery = $state("");
  let debounceTimer: ReturnType<typeof setTimeout>;
  let fileInput: HTMLInputElement | undefined = $state();
  let dragOver = $state(false);
  let sentinelEl: HTMLDivElement | undefined = $state();
  let observer: IntersectionObserver | undefined;

  function handleSearchInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    searchQuery = val;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = val;
    }, 300);
  }

  const gifQuery = createInfiniteQuery<KlipyResult, Error>(() => ({
    queryKey: ["klipy", debouncedQuery] as const,
    queryFn: ({ pageParam }) => {
      const page = (pageParam as number) ?? 1;
      return debouncedQuery
        ? searchGifs(debouncedQuery, 12, page)
        : getTrendingGifs(12, page);
    },
    initialPageParam: 1,
    getNextPageParam: (
      lastPage: KlipyResult,
      _allPages: KlipyResult[],
      lastPageParam: unknown
    ) => (lastPage.hasMore ? (lastPageParam as number) + 1 : undefined),
  }));

  $effect(() => {
    if (!sentinelEl) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          gifQuery.hasNextPage &&
          !gifQuery.isFetchingNextPage
        ) {
          gifQuery.fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinelEl);
    return () => observer?.disconnect();
  });

  const allGifs = $derived<KlipyGif[]>(
    gifQuery.data?.pages.flatMap((p) => p.gifs) ?? []
  );

  function handleFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      preview = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      preview = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  function selectGif(gif: KlipyGif) {
    preview = gif.urls.mediumgif || gif.urls.tinygif;
  }

  function applyUrl() {
    if (urlInput.trim()) preview = urlInput.trim();
  }

  async function handleSave() {
    await saveAvatar(preview);
    onClose();
  }

  function handleCancel() {
    preview = undefined;
    urlInput = "";
    searchQuery = "";
    debouncedQuery = "";
    activeTab = "upload";
    onClose();
  }
</script>

<DialogPrimitive.Root
  {open}
  onOpenChange={(v) => {
    if (!v) handleCancel();
  }}
>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      class="fixed inset-0 z-60 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <DialogPrimitive.Content
      class="fixed top-[50%] left-[50%] z-60 translate-x-[-50%] translate-y-[-50%] w-full max-w-md mx-4 bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
    >
      <div
        class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0"
      >
        <span class="text-sm font-semibold text-foreground font-mono"
          >Set Profile Picture</span
        >
        <button
          type="button"
          onclick={handleCancel}
          class="flex items-center justify-center rounded-md size-7 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close"
        >
          <X class="size-4" />
        </button>
      </div>

      <div class="flex justify-center pt-4 pb-2 shrink-0">
        <div class="relative group">
          <div
            class="size-28 rounded-full overflow-hidden bg-primary/20 flex items-center justify-center ring-2 ring-border"
          >
            {#if preview}
              <img
                src={preview}
                alt="Avatar preview"
                class="size-full object-cover"
              />
            {:else}
              <span
                class="text-3xl font-semibold text-primary font-mono select-none"
                >?</span
              >
            {/if}
          </div>
          {#if preview}
            <button
              type="button"
              onclick={() => {
                preview = undefined;
              }}
              aria-label="Remove avatar"
              class="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X class="size-5 text-white" />
            </button>
          {/if}
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex px-4 gap-1 shrink-0 border-b border-border">
        {#each [["upload", "Upload"] as const, ["klipy", "GIF"] as const, ["url", "URL"] as const] as [id, label]}
          <button
            type="button"
            onclick={() => {
              activeTab = id;
            }}
            class="px-3 py-2 text-xs font-mono font-medium transition-colors border-b-2 -mb-px
              {activeTab === id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'}"
          >
            {label}
          </button>
        {/each}
      </div>

      <!-- Tab content -->
      <div class="h-86">
        {#if activeTab === "upload"}
          <div class="p-4">
            <button
              type="button"
              onclick={() => fileInput?.click()}
              ondragover={(e) => {
                e.preventDefault();
                dragOver = true;
              }}
              ondragleave={() => {
                dragOver = false;
              }}
              ondrop={handleDrop}
              class="w-full rounded-lg border-2 border-dashed transition-colors p-8 flex flex-col items-center gap-3 cursor-pointer
                {dragOver
                ? 'border-primary bg-primary/10'
                : 'border-border hover:border-primary/50 hover:bg-muted/40'}"
              aria-label="Upload image"
            >
              <Upload class="size-8 text-muted-foreground" />
              <div class="text-center">
                <p class="text-sm text-foreground font-mono">
                  Drop an image or click to browse
                </p>
                <p class="text-xs text-muted-foreground font-mono mt-1">
                  PNG, JPEG, GIF, WebP
                </p>
              </div>
            </button>
            <input
              bind:this={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              class="hidden"
              onchange={handleFileChange}
            />
          </div>
        {:else if activeTab === "klipy"}
          <div class="flex flex-col">
            <div class="px-2 pt-3 pb-2">
              <div class="relative">
                <Search
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
                />
                <Input
                  placeholder="Search GIFs..."
                  class="pl-8 h-8 text-xs font-mono"
                  value={searchQuery}
                  oninput={handleSearchInput}
                />
              </div>
            </div>

            <div class="px-2 pb-4 h-72 overflow-y-scroll">
              {#if gifQuery.isLoading}
                <div class="flex justify-center py-8">
                  <div
                    class="size-5 rounded-full border-2 border-primary border-t-transparent animate-spin"
                  ></div>
                </div>
              {:else if allGifs.length === 0}
                <div
                  class="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground"
                >
                  <p class="text-xs font-mono">
                    {debouncedQuery ? "No GIFs found" : "Loading trending..."}
                  </p>
                </div>
              {:else}
                <div class="grid grid-cols-3 gap-1.5">
                  {#each allGifs as gif (gif.id)}
                    <button
                      type="button"
                      onclick={() => selectGif(gif)}
                      class="aspect-square rounded-md overflow-hidden bg-muted hover:ring-2 hover:ring-primary transition-all focus:outline-none focus:ring-2 focus:ring-primary
                        {preview === (gif.urls.mediumgif || gif.urls.tinygif)
                        ? 'ring-2 ring-primary'
                        : ''}"
                      aria-label={gif.title}
                    >
                      <img
                        src={gif.urls.tinygif || gif.urls.mediumgif}
                        alt={gif.title}
                        class="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  {/each}
                </div>
                <div bind:this={sentinelEl} class="h-4"></div>
                {#if gifQuery.isFetchingNextPage}
                  <div class="flex justify-center py-2">
                    <div
                      class="size-4 rounded-full border-2 border-primary border-t-transparent animate-spin"
                    ></div>
                  </div>
                {/if}
                <div class="flex justify-center pt-2">
                  <a
                    href="https://klipy.co"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-xs text-muted-foreground hover:text-foreground font-mono transition-colors"
                  >
                    Powered by KLIPY
                  </a>
                </div>
              {/if}
            </div>
          </div>
        {:else if activeTab === "url"}
          <div class="p-4 flex flex-col gap-3">
            <div class="flex gap-2 items-center">
              <div class="relative flex-1">
                <Link
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
                />
                <Input
                  placeholder="https://example.com/avatar.png"
                  class="pl-8 text-xs font-mono"
                  bind:value={urlInput}
                  onkeydown={(e: KeyboardEvent) =>
                    e.key === "Enter" && applyUrl()}
                />
              </div>
              <Button variant="secondary" size="sm" onclick={applyUrl}
                >Apply</Button
              >
            </div>
          </div>
        {/if}
      </div>

      <div
        class="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0"
      >
        <Button variant="ghost" size="sm" onclick={handleCancel}>Cancel</Button>
        <Button size="sm" onclick={handleSave}>Save</Button>
      </div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
