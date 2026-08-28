<script lang="ts">
  /**
   * One palette row.
   *
   * Rendered as a `role="option"` inside the list's `role="listbox"`. It never
   * takes DOM focus: focus stays in the input and the active row is named by
   * `aria-activedescendant`, which is the only arrangement that lets a user keep
   * typing while moving the selection.
   */
  import { ChevronRight, CornerDownLeft, X } from "@lucide/svelte";
  import HighlightedText from "./HighlightedText.svelte";
  import type { RankedCmd } from "$lib/palette/types";

  interface Props {
    row: RankedCmd;
    /** DOM id, referenced by the input's `aria-activedescendant`. */
    id: string;
    selected: boolean;
    /** Show the "forget" control. Only for rows in the recents group. */
    forgettable?: boolean;
    onSelect: () => void;
    onHover: () => void;
    onForget?: () => void;
  }

  let {
    row,
    id,
    selected,
    forgettable = false,
    onSelect,
    onHover,
    onForget,
  }: Props = $props();

  const opensPage = $derived(row.cmd.action.kind === "page");
</script>

<!--
  A div, not a button. A button inside a listbox is invalid ARIA, and a real
  button would also be reachable by Tab, which the combobox pattern forbids for
  popup descendants. `tabindex="-1"` keeps it out of that sequence while still
  allowing programmatic focus.

  The keyboard-handler warning is suppressed deliberately. In the APG combobox
  pattern every key is handled once, on the input, and the active row is named by
  `aria-activedescendant`. A keydown handler per option would need DOM focus to
  fire, and moving focus onto a row is exactly what stops the user typing.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  {id}
  role="option"
  tabindex="-1"
  aria-selected={selected}
  data-selected={selected ? "" : undefined}
  data-palette-row
  class="group/row flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-md cursor-pointer
         text-sm scroll-my-2 data-selected:bg-muted
         {row.cmd.danger ? 'text-destructive' : 'text-foreground'}"
  onclick={onSelect}
  onpointermove={onHover}
>
  {#if row.cmd.icon}
    <row.cmd.icon
      class="size-4 shrink-0 {row.cmd.danger
        ? 'text-destructive'
        : 'text-muted-foreground'}"
    />
  {:else}
    <!-- Keep the text column aligned whether or not a row has an icon. -->
    <span class="size-4 shrink-0" aria-hidden="true"></span>
  {/if}

  <span class="flex-1 min-w-0 flex items-baseline gap-2">
    <span class="truncate">
      <HighlightedText text={row.cmd.title} ranges={row.titleRanges} />
    </span>
    {#if row.cmd.subtitle}
      <span class="truncate text-xs text-muted-foreground shrink-[2]">
        <HighlightedText text={row.cmd.subtitle} ranges={row.subtitleRanges} />
      </span>
    {/if}
  </span>

  {#if row.cmd.badge}
    <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
      {row.cmd.badge}
    </span>
  {/if}

  {#if row.cmd.shortcut}
    <span class="shrink-0 flex items-center gap-0.5">
      {#each row.cmd.shortcut as key (key)}
        <kbd
          class="rounded border border-border bg-background px-1 text-[10px] leading-4
                 text-muted-foreground"
        >
          {key}
        </kbd>
      {/each}
    </span>
  {/if}

  {#if forgettable && onForget}
    <!--
      Stop the click from reaching the row, or forgetting a command would also
      run it. `tabindex="-1"` keeps it out of the Tab sequence, which the
      combobox pattern requires for popup descendants.
    -->
    <button
      type="button"
      tabindex="-1"
      aria-label="Forget {row.cmd.title}"
      class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity
             hover:text-foreground group-hover/row:opacity-100
             group-data-[selected]/row:opacity-100"
      onclick={(e) => {
        e.stopPropagation();
        onForget();
      }}
    >
      <X class="size-3.5" />
    </button>
  {/if}

  {#if opensPage}
    <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if selected}
    <CornerDownLeft class="size-3.5 shrink-0 text-muted-foreground" />
  {/if}
</div>
