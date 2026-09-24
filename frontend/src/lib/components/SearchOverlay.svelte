<script lang="ts">
  import { Loader2, Search, X } from "@lucide/svelte";
  import { closeSearch, searchUi } from "$lib/search/ui.svelte";
  import { isEmptyQuery, parseSearchQuery } from "$lib/search/query";
  import {
    ensureRoomCorpus,
    scopeProgress,
    searchRooms,
  } from "$lib/search/corpus.svelte";
  import { snippetFor, type SearchHit } from "$lib/search/engine";
  import { match } from "$lib/palette/scorer";
  import { roomsStore } from "$lib/rooms.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { revealMessage } from "$lib/reveal-message";

  let {
    openRoom,
  }: { openRoom: (roomCode: string) => void | Promise<void> } = $props();

  let query = $state("");
  // Selection is tracked by entry id, not index - the palette's own rule:
  // results reorder as sweeps stream in, and an index silently comes to
  // point at a different message than the one highlighted.
  let selectedId = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let jumping = $state(false);

  const parsed = $derived(parseSearchQuery(query));

  /** Room name lookup for row badges and the in: filter. */
  const roomName = $derived.by(() => {
    const names = new Map<string, string>();
    for (const room of [...roomsStore.rooms, ...roomsStore.dmRooms])
      names.set(room.roomCode, room.name || room.roomCode);
    const active = transportState.roomCode;
    if (active && !names.has(active)) names.set(active, active);
    return names;
  });

  /** The rooms this search covers: the scope room, or active-first all. */
  const scopedRooms = $derived.by(() => {
    if (searchUi.scope) return [searchUi.scope];
    const codes: string[] = [];
    const seen = new Set<string>();
    const push = (code: string | null) => {
      if (code && !seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    };
    push(transportState.roomCode);
    for (const room of roomsStore.rooms) push(room.roomCode);
    for (const room of roomsStore.dmRooms) push(room.roomCode);
    if (parsed.inRoom === null) return codes;
    return codes.filter((code) =>
      match((roomName.get(code) ?? code).toLowerCase(), parsed.inRoom!)
    );
  });

  // Opening (or widening) the search starts the sweeps, active room first.
  // Sequential on purpose: one room's IDB read at a time keeps the app
  // responsive, and results stream in as each corpus grows.
  let sweepToken = 0;
  $effect(() => {
    if (!searchUi.open) return;
    const rooms = scopedRooms;
    const token = ++sweepToken;
    void (async () => {
      for (const roomCode of rooms) {
        if (token !== sweepToken || !searchUi.open) return;
        await ensureRoomCorpus(roomCode);
      }
    })();
  });

  const results = $derived.by(() => {
    if (!searchUi.open || isEmptyQuery(parsed)) return [];
    return searchRooms(parsed, scopedRooms);
  });

  const progress = $derived(
    searchUi.open ? scopeProgress(scopedRooms) : null
  );

  /** The active row: the selected id if it still ranks, else the first. */
  const selectedIndex = $derived.by(() => {
    if (selectedId === null) return 0;
    const at = results.findIndex((h) => h.entry.id === selectedId);
    return at >= 0 ? at : 0;
  });

  $effect(() => {
    if (searchUi.open) {
      query = "";
      selectedId = null;
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  function fmtDate(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime())
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  interface Segment {
    text: string;
    mark: boolean;
  }
  /** Snippet split into plain and highlighted runs - no {@html} anywhere. */
  function segmentsFor(hit: SearchHit): Segment[] {
    const s = snippetFor(hit.entry, hit.ranges);
    const out: Segment[] = [];
    if (s.leading) out.push({ text: "…", mark: false });
    let at = 0;
    for (const r of s.ranges) {
      if (r.start > at) out.push({ text: s.text.slice(at, r.start), mark: false });
      out.push({ text: s.text.slice(r.start, r.end), mark: true });
      at = r.end;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), mark: false });
    if (s.trailing) out.push({ text: "…", mark: false });
    return out;
  }

  async function jumpTo(hit: SearchHit): Promise<void> {
    if (jumping) return;
    jumping = true;
    try {
      const { roomCode, id, lamport } = hit.entry;
      closeSearch();
      if (transportState.roomCode !== roomCode) await openRoom(roomCode);
      await revealMessage(roomCode, id, lamport);
    } finally {
      jumping = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(
        Math.max(selectedIndex + delta, 0),
        results.length - 1
      );
      selectedId = results[next].entry.id;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selectedIndex];
      if (hit) void jumpTo(hit);
    }
  }
</script>

{#if searchUi.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
    onclick={closeSearch}
  >
    <div
      class="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Search messages"
      tabindex="-1"
    >
      <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={() => (selectedId = null)}
          onkeydown={onKeydown}
          placeholder={searchUi.scope
            ? "Search this room…  from: has: before: after: \"exact\""
            : "Search all rooms…  from: in: has: before: after: \"exact\""}
          class="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
        />
        {#if searchUi.scope}
          <span
            class="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary"
          >
            {roomName.get(searchUi.scope) ?? searchUi.scope}
          </span>
        {/if}
        <button
          type="button"
          onclick={closeSearch}
          aria-label="Close search"
          class="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        {#if isEmptyQuery(parsed)}
          <p class="px-3 py-6 text-center font-mono text-xs text-muted-foreground">
            Type to search{searchUi.scope ? " this room" : " every room"}.
          </p>
        {:else if results.length === 0}
          <p class="px-3 py-6 text-center font-mono text-xs text-muted-foreground">
            {progress && !progress.done ? "Searching…" : "No matches."}
          </p>
        {:else}
          {#each results as hit, index (hit.entry.id)}
            <button
              type="button"
              onclick={() => void jumpTo(hit)}
              onpointerenter={() => (selectedId = hit.entry.id)}
              class="flex w-full flex-col gap-0.5 px-3 py-2 text-left {index ===
              selectedIndex
                ? 'bg-muted'
                : 'hover:bg-muted/60'}"
            >
              <span class="flex items-baseline gap-2">
                <span class="truncate text-xs font-medium text-foreground">
                  {hit.entry.senderName}
                </span>
                {#if !searchUi.scope}
                  <span class="truncate font-mono text-[10px] text-primary/80">
                    {roomName.get(hit.entry.roomCode) ?? hit.entry.roomCode}
                  </span>
                {/if}
                <span
                  class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                >
                  {fmtDate(hit.entry.timestamp)}
                </span>
              </span>
              <span class="truncate text-xs text-muted-foreground">
                {#each segmentsFor(hit) as seg, i (i)}{#if seg.mark}<mark
                      class="rounded-sm bg-primary/25 px-px text-foreground"
                      >{seg.text}</mark
                    >{:else}{seg.text}{/if}{/each}
              </span>
            </button>
          {/each}
        {/if}
      </div>

      {#if progress && !progress.done}
        <div
          class="flex items-center gap-2 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground"
        >
          <Loader2 class="size-3 animate-spin" />
          {#if progress.sweptTo !== null}
            searched back to {new Date(progress.sweptTo).toLocaleDateString()}
          {:else}
            reading history…
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
