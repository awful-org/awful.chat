<script lang="ts">
  /**
   * Your camera's picture controls, floating over the call: opened from the
   * right-click menu of your own tile or of the camera button, so the
   * sliders sit next to the picture they change instead of in Settings,
   * whose dialog covers it.
   *
   * It stays open until closed (the X, Escape, or the camera going off), not
   * on a click elsewhere: a slider dragged and let go outside the panel ends
   * in a click on the page, which would close it under the pointer.
   */
  import { X } from "@lucide/svelte";
  import CameraPicture from "./settings/CameraPicture.svelte";

  let {
    track,
    x,
    y,
    onClose,
  }: { track: MediaStreamTrack; x: number; y: number; onClose: () => void } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  role="dialog"
  aria-label="Camera picture"
  tabindex="-1"
  class="fixed z-50 flex w-72 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] flex-col rounded-md border border-border bg-popover shadow-xl font-mono"
  style="top: {y}px; left: {x}px"
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
