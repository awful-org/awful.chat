<script lang="ts">
  /**
   * The sidebar's right edge, dragged to make it wider or narrower, as a
   * browser's side panel is - and, like an editor's side panel, dragged on
   * past the narrowest it goes, folded to the rail (sidebar-width.ts draws
   * the line). On the collapsed rail's edge the same handle drags it open.
   *
   * A thin strip over the border, invisible until hovered, focused or
   * dragged. It owns the pointer and the keys; the sidebar owns the width
   * and the collapse. While a drag is under way it only previews - one state
   * per frame, no storage - and what it ends on is saved once, on release.
   * Escape puts everything back as it was before the press.
   *
   * The owner must keep this one element mounted in both states (rail and
   * open): it holds the pointer capture, and a drag that flips the sidebar
   * would die with it.
   */
  import { onDestroy } from "svelte";
  import {
    SIDEBAR_MIN_PX,
    collapsedSidebarKey,
    sidebarDragCommit,
    sidebarDragState,
    sidebarMaxWidth,
    sidebarWidthForKey,
    type SidebarDrag,
  } from "$lib/sidebar-width";

  interface Props {
    /** The open width drawn right now (or, collapsed, the one it opens to). */
    width: number;
    /** Drawn as the rail alone right now. */
    collapsed: boolean;
    viewportWidth: number;
    /** The id of what it resizes, for assistive technology. */
    controls?: string;
    /** During a drag: what to draw. Null when the drag ends or is cancelled. */
    onpreview: (state: SidebarDrag | null) => void;
    /** The open width to keep, or null for the default. */
    onwidth: (px: number | null) => void;
    /** Collapse (true) or expand (false), saved like the collapse button. */
    oncollapse: (on: boolean) => void;
  }

  let { width, collapsed, viewportWidth, controls, onpreview, onwidth, oncollapse }: Props =
    $props();

  const max = $derived(sidebarMaxWidth(viewportWidth));

  let dragging = $state(false);
  let originX = 0;
  let originWidth = 0;
  let originCollapsed = false;
  /** Where the pointer has taken the sidebar; null until it moves. */
  let pending: SidebarDrag | null = null;
  let frame = 0;
  let captured: { el: HTMLElement; id: number } | null = null;

  function down(e: PointerEvent): void {
    if (e.button !== 0) return;
    // No text selection starting under the drag.
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone: there is nothing to drag.
      return;
    }
    captured = { el, id: e.pointerId };
    originX = e.clientX;
    originWidth = width;
    originCollapsed = collapsed;
    pending = null;
    dragging = true;
  }

  function move(e: PointerEvent): void {
    if (!dragging) return;
    pending = sidebarDragState(originCollapsed, originWidth, e.clientX - originX, viewportWidth);
    // One state per frame: pointermove can fire several times between
    // paints, and each width re-lays out the chat beside the sidebar.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (dragging && pending !== null) onpreview(pending);
      });
    }
  }

  /** Stops listening to the drag without deciding anything. */
  function stop(): void {
    dragging = false;
    cancelAnimationFrame(frame);
    frame = 0;
    captured = null;
  }

  /** Release: pointerup, cancel, lost capture, or the window losing focus. */
  function end(): void {
    if (!dragging) return;
    const commit = sidebarDragCommit(originCollapsed, pending);
    pending = null;
    stop();
    // Saved before the preview is dropped, so no frame shows the old state.
    // A press that never moved saves nothing: a click (or the first half of
    // a double-click) must not rewrite a width only clamped by this window.
    if (commit.width !== undefined) onwidth(commit.width);
    if (commit.collapsed !== undefined) oncollapse(commit.collapsed);
    onpreview(null);
  }

  /** Escape mid-drag: back to how it was before the press, nothing saved. */
  function cancel(): void {
    const held = captured;
    pending = null;
    stop();
    onpreview(null);
    try {
      held?.el.releasePointerCapture(held.id);
    } catch {
      // Already released.
    }
  }

  function windowKeydown(e: KeyboardEvent): void {
    if (!dragging || e.key !== "Escape") return;
    // Captured at the window, so the Escape is the drag's alone and does
    // not also close a menu or leave a call.
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }

  function keydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || dragging) return;
    if (collapsed) {
      if (collapsedSidebarKey(e.key) === null) return;
      e.preventDefault();
      oncollapse(false);
      return;
    }
    const next = sidebarWidthForKey(e.key, width, viewportWidth);
    if (next === null) return;
    e.preventDefault();
    onwidth(next === "default" ? null : next);
  }

  function dblclick(): void {
    // Collapsed, a click (or two) on the edge does nothing; open, a
    // double-click goes back to the default width.
    if (!collapsed) onwidth(null);
  }

  /** Moves the cursor overlay to <body>. The sidebar carries a `translate`
   *  (the phone slide-over's, zero on a desktop but still set), and any
   *  translate makes `fixed` inside it mean "over the sidebar", not "over
   *  the window" - which, collapsed mid-drag, is a 56px strip. */
  function toBody(node: HTMLElement): () => void {
    document.body.append(node);
    return () => node.remove();
  }

  onDestroy(() => {
    // Removed mid-drag (the window shrank past the range): the preview must
    // not outlive the handle.
    if (dragging) {
      stop();
      onpreview(null);
    }
  });
</script>

<svelte:window onblur={end} onkeydowncapture={windowKeydown} />

<!-- A focusable separator with a value IS the ARIA window-splitter widget,
     interactive by definition; the linter only knows the static kind.
     Collapsed, it reports the bottom of the range, named as collapsed. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-label="Resize sidebar"
  aria-orientation="vertical"
  aria-controls={controls}
  aria-valuemin={SIDEBAR_MIN_PX}
  aria-valuemax={max}
  aria-valuenow={collapsed ? SIDEBAR_MIN_PX : width}
  aria-valuetext={collapsed ? "Collapsed" : `${width} pixels wide`}
  class="group/resize absolute inset-y-0 -right-[3px] z-20 flex w-1.5 touch-none justify-center outline-none cursor-col-resize max-sm:hidden"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  onlostpointercapture={end}
  ondblclick={dblclick}
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
  <div {@attach toBody} class="fixed inset-0 z-[70] cursor-col-resize select-none"></div>
{/if}
