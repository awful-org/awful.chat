<script lang="ts">
  /**
   * The sidebar's right edge, dragged to make it wider or narrower, as a
   * browser's side panel is.
   *
   * A thin strip over the border, invisible until hovered, focused or
   * dragged. It owns the pointer and the keys; the sidebar owns the width
   * (sidebar-width.ts clamps it). While a drag is under way it only
   * previews - one width per frame, no storage - and the width is saved
   * once, on release.
   */
  import { onDestroy } from "svelte";
  import {
    SIDEBAR_MIN_PX,
    clampSidebarWidth,
    sidebarMaxWidth,
    sidebarWidthForKey,
  } from "$lib/sidebar-width";

  interface Props {
    /** The width drawn right now, in pixels. */
    width: number;
    viewportWidth: number;
    /** The id of what it resizes, for assistive technology. */
    controls?: string;
    /** During a drag: the width to draw. Null when the drag ends. */
    onpreview: (px: number | null) => void;
    /** The width to keep, or null for the default. */
    oncommit: (px: number | null) => void;
  }

  let { width, viewportWidth, controls, onpreview, oncommit }: Props = $props();

  const max = $derived(sidebarMaxWidth(viewportWidth));

  let dragging = $state(false);
  let originX = 0;
  let originWidth = 0;
  /** The latest width the pointer asked for; null until it moves. */
  let pending: number | null = null;
  let frame = 0;

  function down(e: PointerEvent): void {
    if (e.button !== 0) return;
    // No text selection starting under the drag.
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone: there is nothing to drag.
      return;
    }
    originX = e.clientX;
    originWidth = width;
    pending = null;
    dragging = true;
  }

  function move(e: PointerEvent): void {
    if (!dragging) return;
    pending = clampSidebarWidth(originWidth + e.clientX - originX, viewportWidth);
    // One width per frame: pointermove can fire several times between
    // paints, and each width re-lays out the chat beside the sidebar.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (dragging && pending !== null) onpreview(pending);
      });
    }
  }

  /** Release: pointerup, cancel, lost capture, or the window losing focus. */
  function end(): void {
    if (!dragging) return;
    dragging = false;
    cancelAnimationFrame(frame);
    frame = 0;
    // A press that never moved saves nothing: a click (or the first half of
    // a double-click) must not rewrite a width only clamped by this window.
    if (pending !== null) oncommit(pending);
    pending = null;
    onpreview(null);
  }

  function keydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = sidebarWidthForKey(e.key, width, viewportWidth);
    if (next === null) return;
    e.preventDefault();
    oncommit(next === "default" ? null : next);
  }

  onDestroy(() => {
    // Removed mid-drag (collapsed, or the window shrank past the range):
    // the preview must not outlive the handle.
    if (dragging) {
      dragging = false;
      cancelAnimationFrame(frame);
      onpreview(null);
    }
  });
</script>

<svelte:window onblur={end} />

<!-- A focusable separator with a value IS the ARIA window-splitter widget,
     interactive by definition; the linter only knows the static kind. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-label="Resize sidebar"
  aria-orientation="vertical"
  aria-controls={controls}
  aria-valuemin={SIDEBAR_MIN_PX}
  aria-valuemax={max}
  aria-valuenow={width}
  aria-valuetext="{width} pixels wide"
  class="group/resize absolute inset-y-0 -right-[3px] z-20 flex w-1.5 touch-none justify-center outline-none cursor-col-resize max-sm:hidden"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  onlostpointercapture={end}
  ondblclick={() => oncommit(null)}
  onkeydown={keydown}
>
  <!-- The line, over the sidebar's border. The strip around it is the
       target, kept to 6px so the scrollbar beside it and the chat's edge
       stay clickable. -->
  <div
    class="pointer-events-none h-full w-0.5 transition-[opacity,background-color] duration-150 motion-reduce:transition-none
      {dragging
      ? 'bg-primary/70 opacity-100'
      : 'bg-muted-foreground/50 opacity-0 group-hover/resize:opacity-100 group-focus-visible/resize:bg-ring group-focus-visible/resize:opacity-100'}"
  ></div>
</div>

{#if dragging}
  <!-- Keeps the resize cursor everywhere, and keeps the drag from vanishing
       into an iframe (a plugin, a watch-together player) it crosses. -->
  <div class="fixed inset-0 z-[70] cursor-col-resize select-none"></div>
{/if}
