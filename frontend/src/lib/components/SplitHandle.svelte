<script lang="ts">
  /**
   * The draggable line between the call and the chat.
   *
   * Invisible until it matters: a transparent grab strip whose line fades in
   * on hover, on keyboard focus and while dragging, and turns the accent
   * colour while it is stuck to a default size. It only reports how far the
   * pointer has travelled since the drag began; the owner turns that into a
   * size (call-split.ts), so the same handle serves the stacked layout
   * (drags up and down) and the beside one (drags sideways).
   */
  import { onDestroy } from "svelte";

  interface Props {
    /** "row": a horizontal line, dragged up and down. "column": sideways. */
    orientation: "row" | "column";
    label: string;
    /** 0-100, for assistive technology. */
    valueNow: number;
    /** Stuck to a default size right now. */
    snapped?: boolean;
    onstart: () => void;
    /** Pixels travelled since onstart: positive is down (row) or right. */
    onmove: (delta: number) => void;
    onend: () => void;
    /** Double-click or Home: back to the automatic size. */
    onreset: () => void;
    /** Arrow keys: one step, +1 down (row) or right, -1 up or left. */
    onstep: (direction: -1 | 1) => void;
    class?: string;
  }

  let {
    orientation,
    label,
    valueNow,
    snapped = false,
    onstart,
    onmove,
    onend,
    onreset,
    onstep,
    class: className = "",
  }: Props = $props();

  let dragging = $state(false);
  let origin = 0;
  let delta = 0;
  let frame = 0;

  const along = (e: PointerEvent) => (orientation === "row" ? e.clientY : e.clientX);

  function down(e: PointerEvent): void {
    if (e.button !== 0) return;
    // No text selection starting under the drag.
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin = along(e);
    delta = 0;
    dragging = true;
    onstart();
  }

  function move(e: PointerEvent): void {
    if (!dragging) return;
    delta = along(e) - origin;
    // One size per frame: pointermove can fire several times between paints,
    // and each size change re-lays out the whole call grid.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        onmove(delta);
      });
    }
  }

  function up(): void {
    if (!dragging) return;
    dragging = false;
    cancelAnimationFrame(frame);
    frame = 0;
    onmove(delta);
    onend();
  }

  function keydown(e: KeyboardEvent): void {
    // The line moves the way the arrow points, like the drag does.
    const forward = orientation === "row" ? "ArrowDown" : "ArrowRight";
    const back = orientation === "row" ? "ArrowUp" : "ArrowLeft";
    if (e.key === forward) onstep(1);
    else if (e.key === back) onstep(-1);
    else if (e.key === "Home") onreset();
    else return;
    e.preventDefault();
  }

  onDestroy(() => cancelAnimationFrame(frame));
</script>

<!-- A focusable separator with a value IS the ARIA window-splitter widget,
     interactive by definition; the linter only knows the static kind. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-orientation={orientation === "row" ? "horizontal" : "vertical"}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(valueNow)}
  title="Drag to resize · double-click for the default"
  class="group/split absolute z-30 flex touch-none items-center justify-center outline-none {orientation ===
  'row'
    ? 'inset-x-0 h-3 cursor-row-resize'
    : 'inset-y-0 w-3 cursor-col-resize'} {className}"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onlostpointercapture={up}
  ondblclick={onreset}
  onkeydown={keydown}
>
  <!-- The line. Thin at rest and hidden; the strip around it is the target. -->
  <div
    class="pointer-events-none rounded-full transition-[opacity,background-color,transform] duration-150 motion-reduce:transition-none
      {orientation === 'row' ? 'h-0.5 w-full' : 'h-full w-0.5'}
      {dragging || snapped
      ? 'opacity-100'
      : 'opacity-0 group-hover/split:opacity-100 group-focus-visible/split:opacity-100'}
      {snapped ? 'bg-primary' : dragging ? 'bg-primary/70' : 'bg-muted-foreground/50'}"
  ></div>
  <!-- A grip for touch, where there is no hover to find the line with. -->
  <div
    class="pointer-events-none absolute hidden rounded-full bg-muted-foreground/40 pointer-coarse:block
      {orientation === 'row' ? 'h-1 w-10' : 'h-10 w-1'}"
  ></div>
</div>

{#if dragging}
  <!-- Keeps the resize cursor everywhere, and keeps the drag from vanishing
       into a watch-together iframe the pointer crosses on its way. -->
  <div
    class="fixed inset-0 z-[70] {orientation === 'row' ? 'cursor-row-resize' : 'cursor-col-resize'}"
  ></div>
{/if}
