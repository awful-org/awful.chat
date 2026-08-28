<script lang="ts">
  /**
   * Interactive crop editor. The image sits behind a fixed crop frame; the user
   * pans it by dragging, zooms with the slider or the wheel, and rotates it with
   * the rotation slider. Apply emits a {@link CropView} - the heavy pixel work
   * happens in the caller through `cropImageToDataUrl`.
   *
   * An animated GIF keeps playing while it is framed, so the user sees exactly
   * what they crop.
   */
  import { RotateCcw, RotateCw } from "@lucide/svelte";
  import Button from "$lib/components/ui/button/button.svelte";
  import type { CropView } from "$lib/crop";
  import { coverScale, clampPan } from "$lib/crop-geometry";

  interface Props {
    src: string;
    /** Output aspect ratio, width / height. */
    aspect: number;
    /** Show the frame as a circle (avatar) instead of a rectangle (banner). */
    circle?: boolean;
    onCancel: () => void;
    onApply: (view: CropView) => void;
    /** True while the caller re-encodes the crop. */
    busy?: boolean;
  }

  let { src, aspect, circle = false, onCancel, onApply, busy = false }: Props =
    $props();

  // Frame footprint on screen, fitted into the dialog content area.
  const MAX_W = 288;
  const MAX_H = 232;
  const frameW = $derived(Math.round(Math.min(MAX_W, MAX_H * aspect)));
  const frameH = $derived(Math.round(frameW / aspect));

  const MAX_ZOOM = 4;
  let natW = $state(0);
  let natH = $state(0);
  let zoom = $state(1);
  let angleDeg = $state(0);
  let panX = $state(0);
  let panY = $state(0);
  let loadError = $state(false);

  const baseScale = $derived(coverScale(natW, natH, frameW, frameH, angleDeg));
  const scale = $derived(baseScale * zoom);
  const ready = $derived(natW > 0 && natH > 0);

  function currentView(): CropView {
    return { natW, natH, frameW, frameH, scale, panX, panY, angleDeg };
  }

  // Whenever the scale or the angle changes, the pan can fall outside the
  // covered range - pull it back in. clampPan is idempotent, so this settles.
  $effect(() => {
    if (!ready) return;
    const c = clampPan(currentView());
    if (Math.abs(c.panX - panX) > 1e-6 || Math.abs(c.panY - panY) > 1e-6) {
      panX = c.panX;
      panY = c.panY;
    }
  });

  function reset() {
    zoom = 1;
    angleDeg = 0;
    panX = 0;
    panY = 0;
  }

  function onImgLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    loadError = natW === 0 || natH === 0;
    if (!loadError) reset();
  }

  function applyZoom(next: number) {
    zoom = Math.min(MAX_ZOOM, Math.max(1, next));
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }

  function rotateBy(delta: number) {
    let a = (angleDeg + delta) % 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    angleDeg = a;
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent) {
    if (!ready) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const c = clampPan({
      ...currentView(),
      panX: panX + (e.clientX - lastX),
      panY: panY + (e.clientY - lastY),
    });
    panX = c.panX;
    panY = c.panY;
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function apply() {
    if (!ready) return;
    onApply(currentView());
  }
</script>

<div class="flex h-full flex-col items-center gap-3 p-4">
  {#if loadError}
    <div
      class="flex flex-1 items-center justify-center text-sm text-destructive font-mono"
    >
      This image could not be loaded for cropping.
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center">
      <div
        role="application"
        aria-label="Drag to reposition"
        class="relative touch-none overflow-hidden bg-muted select-none {circle
          ? 'rounded-full'
          : 'rounded-lg'} ring-2 ring-primary/60 {ready
          ? 'cursor-grab active:cursor-grabbing'
          : ''}"
        style="width:{frameW}px;height:{frameH}px;"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onwheel={onWheel}
      >
        <img
          {src}
          alt="Crop preview"
          draggable="false"
          onload={onImgLoad}
          onerror={() => (loadError = true)}
          class="pointer-events-none absolute max-w-none"
          style="width:{natW}px;height:{natH}px;left:{(frameW - natW) /
            2}px;top:{(frameH - natH) /
            2}px;transform-origin:center;transform:translate({panX}px,{panY}px) rotate({angleDeg}deg) scale({scale});"
        />
      </div>
    </div>

    <div class="flex w-full items-center gap-3 px-1">
      <span class="w-12 text-xs font-mono text-muted-foreground select-none"
        >Zoom</span
      >
      <input
        type="range"
        min="1"
        max={MAX_ZOOM}
        step="0.01"
        value={zoom}
        oninput={(e) => applyZoom(Number((e.target as HTMLInputElement).value))}
        disabled={!ready}
        aria-label="Zoom"
        class="h-1.5 flex-1 cursor-pointer accent-primary"
      />
      <button
        type="button"
        onclick={reset}
        disabled={!ready}
        aria-label="Reset crop"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
      >
        <RotateCcw class="size-4" />
      </button>
    </div>

    <div class="flex w-full items-center gap-3 px-1">
      <span class="w-12 text-xs font-mono text-muted-foreground select-none"
        >Rotate</span
      >
      <input
        type="range"
        min="-180"
        max="180"
        step="1"
        value={angleDeg}
        oninput={(e) => (angleDeg = Number((e.target as HTMLInputElement).value))}
        disabled={!ready}
        aria-label="Rotate"
        class="h-1.5 flex-1 cursor-pointer accent-primary"
      />
      <button
        type="button"
        onclick={() => rotateBy(90)}
        disabled={!ready}
        aria-label="Rotate 90 degrees"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
      >
        <RotateCw class="size-4" />
      </button>
    </div>
  {/if}

  <div class="flex w-full items-center justify-end gap-2">
    <Button variant="ghost" size="sm" onclick={onCancel} disabled={busy}>
      Cancel
    </Button>
    <Button size="sm" onclick={apply} disabled={!ready || busy}>
      {busy ? "Cropping..." : "Apply crop"}
    </Button>
  </div>
</div>
