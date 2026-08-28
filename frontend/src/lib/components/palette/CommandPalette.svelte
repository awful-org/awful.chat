<script lang="ts">
  /**
   * The Cmd-K command palette.
   *
   * Composition rationale. The dialog shell is bits-ui `Dialog`, which is what
   * every other overlay in this app uses, and which supplies the portal, focus
   * trap, focus restore, and body scroll lock. The combobox and listbox below it
   * are written here rather than taken from bits-ui `Command` for three reasons:
   *
   *   1. bits-ui inherits cmdk's scorer, which returns a bare number. Without
   *      match positions a row cannot show WHY it matched.
   *   2. bits-ui keys its item registry by the item's value string, so two rows
   *      with the same label collide. Room names collide routinely.
   *   3. bits-ui puts `role="application"` on the palette root, which turns off
   *      screen-reader browse mode.
   *
   * Every ranking decision lives in plain, unit-tested modules under
   * `$lib/palette/`. This file is markup, keyboard wiring, and scroll behaviour.
   *
   * ARIA follows the APG combobox pattern: DOM focus never leaves the input, and
   * the active row is named by `aria-activedescendant`. Moving real focus onto a
   * row would stop the user from typing.
   */
  import { Dialog } from "bits-ui";
  import { ArrowLeft, CornerDownLeft, Search, TriangleAlert } from "@lucide/svelte";
  import PaletteRow from "./PaletteRow.svelte";
  import { PaletteState } from "$lib/palette/palette.svelte";
  import { buildCatalog } from "$lib/palette/commands";
  import type { PaletteHost } from "$lib/palette/host";
  import { SIGILS } from "$lib/palette/types";

  interface Props {
    /** Visibility. The single source of truth; the palette only ever clears it. */
    open: boolean;
    host: PaletteHost;
  }

  let { open = $bindable(), host }: Props = $props();

  // The catalog depends on app state, never on the query, so it is NOT rebuilt
  // per keystroke. That keeps the lowercase-field cache in `rank.ts` warm.
  const catalog = $derived(buildCatalog(host));

  const palette = new PaletteState(
    () => catalog,
    () => {
      open = false;
    },
  );

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);
  /**
   * Whether the pointer has genuinely moved since the palette opened. A palette
   * that opens under the cursor otherwise selects whatever row lands beneath it,
   * overriding the keyboard selection before the user has typed anything.
   */
  let pointerMoved = $state(false);

  // Start every session at the root. Resetting on open rather than on close lets
  // the exit animation finish on the page the user was actually looking at.
  $effect(() => {
    if (open) {
      palette.reset();
      pointerMoved = false;
    }
  });

  const listId = "palette-listbox";
  const rowId = (id: string) => `palette-row-${id.replace(/[^\w:-]/g, "_")}`;

  const activeId = $derived(
    palette.selected ? rowId(palette.selected.cmd.id) : undefined,
  );
  const resultCount = $derived(palette.rows.length);
  const onConfirm = $derived(palette.page?.kind === "confirm");

  /**
   * What to say when nothing matched.
   *
   * A list page names its own empty case, since "no audio devices" is more
   * useful than "no matches". Quoting the query only helps when there IS one:
   * with a bare scope prefix the body is empty, and `No matches for “”` reads
   * like a bug.
   */
  const emptyText = $derived.by(() => {
    const page = palette.page;
    if (page?.kind === "list" && page.emptyText) return page.emptyText;
    const body = palette.parsed.body;
    if (body.length > 0) return `No matches for “${body}”`;
    if (palette.scope !== null) return `Nothing in ${SIGILS[palette.scope].toLowerCase()} yet`;
    return "Nothing here";
  });

  /** Keep the active row visible without yanking the list around. */
  $effect(() => {
    const id = activeId;
    if (!id || !listEl) return;
    const el = listEl.querySelector(`#${CSS.escape(id)}`);
    if (el) el.scrollIntoView({ block: "nearest" });
  });


  /** How many rows a PageUp/PageDown moves. Measured, not guessed. */
  function pageSize(): number {
    const first = listEl?.querySelector<HTMLElement>("[data-palette-row]");
    if (!listEl || !first || first.offsetHeight === 0) return 8;
    return Math.max(1, Math.floor(listEl.clientHeight / first.offsetHeight));
  }

  function handleKeydown(e: KeyboardEvent): void {
    // An IME candidate window uses the same keys. Acting on them mid-composition
    // commits the wrong thing. `keyCode === 229` is required on top of
    // `isComposing`, which is unreliable for Japanese IME in Safari.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.defaultPrevented) return;

    switch (e.key) {
      case "Escape":
        // Own the whole decision. Escape is handled by six other listeners in
        // this app, none of which stop propagation, so without this a single
        // press would close the palette AND a context menu behind it.
        e.preventDefault();
        e.stopPropagation();
        palette.escape();
        return;

      case "Backspace":
        // Read the live element value: on a key repeat the state write lags a
        // tick, which pops a page the user was still typing in.
        if (palette.backspace((e.currentTarget as HTMLInputElement).value)) {
          e.preventDefault();
        }
        return;

      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) palette.move(groupJump(1));
        else palette.move(1);
        return;

      case "ArrowUp":
        e.preventDefault();
        if (e.altKey) palette.move(groupJump(-1));
        else palette.move(-1);
        return;

      case "Home":
        e.preventDefault();
        palette.moveToStart();
        return;

      case "End":
        e.preventDefault();
        palette.moveToEnd();
        return;

      case "PageDown":
        e.preventDefault();
        palette.movePage(1, pageSize());
        return;

      case "PageUp":
        e.preventDefault();
        palette.movePage(-1, pageSize());
        return;

      case "Enter":
        e.preventDefault();
        void palette.accept();
        return;
    }
  }

  /**
   * Distance to the first row of the next or previous group, for Alt+Arrow.
   * Returns a plain step of 1 when there is no further group, so the key never
   * feels dead.
   */
  function groupJump(direction: 1 | -1): number {
    const rows = palette.rows;
    const current = rows.findIndex((r) => r.cmd.id === palette.selected?.cmd.id);
    if (current < 0) return direction;
    const group = rows[current].cmd.group;
    for (let i = current + direction; i >= 0 && i < rows.length; i += direction) {
      if (rows[i].cmd.group !== group) return i - current;
    }
    return direction;
  }

  const showBack = $derived(palette.crumbs.length > 0);
</script>

<!-- `bind:open` is the whole state contract. bits-ui owns the portal, the focus
     trap, focus restore, and the body scroll lock. -->
<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="data-[state=open]:animate-in data-[state=closed]:animate-out
             data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
             fixed inset-0 z-50 bg-black/60"
    />
    <Dialog.Content
      escapeKeydownBehavior="ignore"
      onOpenAutoFocus={(e) => {
        // Focus the search field rather than the first focusable node, so the
        // first keystroke always types instead of activating something.
        e.preventDefault();
        inputEl?.focus();
      }}
      class="data-[state=open]:animate-in data-[state=closed]:animate-out
             data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
             data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95
             fixed top-[10vh] left-1/2 z-50 w-[min(38rem,calc(100vw-2rem))]
             -translate-x-1/2 overflow-hidden rounded-lg border border-border
             bg-popover text-popover-foreground font-mono shadow-2xl duration-150"
      onpointermove={() => (pointerMoved = true)}
    >
      <Dialog.Title class="sr-only">Command palette</Dialog.Title>
      <Dialog.Description class="sr-only">
        Search rooms, settings and actions. Use the arrow keys to choose and Enter
        to run.
      </Dialog.Description>

      <!-- Search field -->
      <div class="flex items-center gap-2 border-b border-border px-3">
        {#if showBack}
          <button
            type="button"
            tabindex="-1"
            aria-label="Go back"
            class="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            onclick={() => palette.pop()}
          >
            <ArrowLeft class="size-4" />
          </button>
        {:else}
          <Search class="size-4 shrink-0 text-muted-foreground" />
        {/if}

        {#each palette.crumbs as crumb (crumb)}
          <span
            class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {crumb}
          </span>
        {/each}

        <input
          bind:this={inputEl}
          type="text"
          role="combobox"
          aria-label="Search rooms, settings and actions"
          aria-controls={listId}
          aria-expanded={resultCount > 0}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder={palette.placeholder}
          value={palette.inputValue}
          oninput={(e) => palette.setQuery(e.currentTarget.value)}
          onkeydown={handleKeydown}
          class="h-11 flex-1 min-w-0 bg-transparent text-sm outline-none
                 placeholder:text-muted-foreground"
        />
      </div>

      {#if palette.error}
        <p
          role="alert"
          class="border-b border-border px-3 py-2 text-xs text-destructive"
        >
          {palette.error}
        </p>
      {/if}

      {#if palette.page?.kind === "confirm"}
        <!-- The consequence is stated in full, in normal sentence case, before
             the two choices. Cancel is the preselected row. -->
        <p
          class="flex items-start gap-2 border-b border-border px-3 py-2.5 text-xs
                 text-muted-foreground"
        >
          <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-destructive" />
          {palette.page.message}
        </p>
      {/if}

      <!--
        Announces the result count to screen readers only. Rendering the count as
        text means it is announced exactly when it changes, which avoids the
        repeated announcements a manually toggled attribute causes.
      -->
      <div aria-live="polite" aria-atomic="true" class="sr-only">
        {resultCount === 0 ? "No results" : `${resultCount} results`}
      </div>

      {#if palette.onPrompt}
        <div class="px-3 py-3 text-xs text-muted-foreground">
          Press <kbd class="rounded border border-border px-1">Enter</kbd> to
          confirm, or <kbd class="rounded border border-border px-1">Esc</kbd> to
          go back.
        </div>
      {:else}
        <!--
          `overscroll-contain` stops a flick at the end of the list from
          scrolling the page behind the palette.
        -->
        <div
          bind:this={listEl}
          id={listId}
          role="listbox"
          aria-label="Results"
          tabindex="-1"
          class="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain py-1"
        >
          {#if palette.loading}
            <p class="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading…
            </p>
          {:else if resultCount === 0}
            <p class="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyText}
            </p>
          {:else}
            {#each palette.groups as group (group.name)}
              <div role="group" aria-labelledby="palette-group-{group.name}">
                <!--
                  Hidden from the accessibility tree because `aria-labelledby`
                  above already exposes this text as the group's name.
                -->
                <div
                  id="palette-group-{group.name}"
                  aria-hidden="true"
                  class="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider
                         text-muted-foreground uppercase"
                >
                  {group.name}
                </div>
                {#each group.items as row (row.cmd.id)}
                  <PaletteRow
                    {row}
                    id={rowId(row.cmd.id)}
                    selected={palette.selected?.cmd.id === row.cmd.id}
                    forgettable={group.name === palette.recentGroupName}
                    onSelect={() => void palette.run(row.cmd)}
                    onHover={() => {
                      if (pointerMoved) palette.hover(row.cmd.id);
                    }}
                    onForget={() => palette.forget(row.cmd.id)}
                  />
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      <!-- Footer: keeps the keyboard model discoverable. -->
      <div
        class="flex items-center gap-3 border-t border-border px-3 py-1.5
               text-[10px] text-muted-foreground"
      >
        <span class="flex items-center gap-1">
          <kbd class="rounded border border-border px-1">↑</kbd>
          <kbd class="rounded border border-border px-1">↓</kbd>
          move
        </span>
        <span class="flex items-center gap-1">
          <CornerDownLeft class="size-3" />
          {onConfirm ? "choose" : "run"}
        </span>
        <span class="flex items-center gap-1">
          <kbd class="rounded border border-border px-1">Esc</kbd>
          {showBack ? "back" : "close"}
        </span>
        <span class="ml-auto hidden sm:inline">
          <kbd class="rounded border border-border px-1">?</kbd> for prefixes
        </span>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
