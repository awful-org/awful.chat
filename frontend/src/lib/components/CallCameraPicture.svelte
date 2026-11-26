<script lang="ts">
  /**
   * Your camera's picture controls, floating over the call: opened from the
   * right-click menu of your own tile or of the camera button, so the
   * sliders sit next to the picture they change instead of in Settings,
   * whose dialog covers it.
   *
   * It closes with the X, Escape, the camera going off, or a press anywhere
   * outside it. A press, not a click: a slider dragged and let go outside
   * the panel ends in a click on the page, which would close it under the
   * pointer.
   */
  import { X } from "@lucide/svelte";
  import CameraPicture from "./settings/CameraPicture.svelte";

  let {
    track,
    x,
    y,
    above = false,
    onClose,
  }: {
    track: MediaStreamTrack;
    /** The point it was opened from. */
    x: number;
    y: number;
    /** Open above that point rather than below it. */
    above?: boolean;
    onClose: () => void;
  } = $props();

  let panel = $state<HTMLElement | null>(null);
  // Measured, not estimated: how tall it is depends on which controls the
  // camera offers and how the note under them wraps.
  let width = $state(288);
  let height = $state(0);
  let viewW = $state(typeof window === "undefined" ? 0 : window.innerWidth);
  let viewH = $state(typeof window === "undefined" ? 0 : window.innerHeight);

  const PAD = 8;
  const left = $derived(Math.max(PAD, Math.min(x, viewW - width - PAD)));
  const top = $derived(
    Math.max(PAD, Math.min(above ? y - height - PAD : y, viewH - height - PAD))
  );

  function pressedOutside(e: PointerEvent) {
    if (panel && e.target instanceof Node && !panel.contains(e.target)) onClose();
  }
</script>

<svelte:window
  onpointerdown={pressedOutside}
  bind:innerWidth={viewW}
  bind:innerHeight={viewH}
/>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={panel}
  bind:offsetWidth={width}
  bind:offsetHeight={height}
  role="dialog"
  aria-label="Camera picture"
  tabindex="-1"
  class="fixed z-50 flex w-72 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] flex-col rounded-md border border-border bg-popover shadow-xl font-mono"
  style="top: {top}px; left: {left}px; visibility: {height ? 'visible' : 'hidden'}"
  onclick={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.preventDefault()}
>
  <div class="flex items-center justify-between border-b border-border py-1.5 pl-3 pr-1.5">
    <span class="text-xs text-muted-foreground">Camera picture</span>
    <button
      type="button"
      aria-label="Close camera picture"
      class="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
      onclick={onClose}
    >
      <X class="size-4" />
    </button>
  </div>
  <div class="overflow-y-auto p-3">
    {#key track}
      <CameraPicture {track} />
    {/key}
  </div>
</div>
