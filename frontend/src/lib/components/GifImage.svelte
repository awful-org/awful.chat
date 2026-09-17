<script lang="ts">
  import { canLoadMedia } from "$lib/media-prefs.svelte";
  /**
   * An image that can hold an animated GIF still. Browsers cannot pause a
   * GIF, so a canvas keeps the first frame and the animated img only exists
   * in the DOM while it is allowed to play - the browser then spends no
   * decode work on it. A still image renders as a plain img with zero
   * overhead.
   *
   * The canvas and img are stacked in the same grid cell and the canvas is
   * only hidden once the img has painted: swapping the elements instead
   * leaves a blank frame under the cursor, which reads as a flicker.
   *
   * animate: true = always play, false = always frozen, "hover" = play
   * while the pointer is over it.
   */
  interface Props {
    src: string;
    alt?: string;
    class?: string;
    animate?: boolean | "hover";
    /** Override URL sniffing when the caller already knows (e.g. mime type). */
    animated?: boolean;
    loading?: "lazy" | "eager";
  }

  let {
    src,
    alt = "",
    class: cls = "",
    animate = true,
    animated = undefined,
    loading,
  }: Props = $props();

  let hovered = $state(false);
  let imgReady = $state(false);
  let canvasEl = $state<HTMLCanvasElement>();

  function urlLooksAnimated(s: string): boolean {
    if (s.startsWith("data:"))
      return (
        s.startsWith("data:image/gif") || s.startsWith("data:image/webp")
      );
    return /\.(gif|webp)([?#]|$)/i.test(s);
  }

  const isAnimated = $derived(animated ?? urlLooksAnimated(src));
  const allowed = $derived(canLoadMedia(src));
  const playing = $derived(
    isAnimated && (animate === true || (animate === "hover" && hovered))
  );

  $effect(() => {
    src;
    if (!playing) imgReady = false;
  });

  $effect(() => {
    if (!allowed || !isAnimated || !canvasEl) return;
    const canvas = canvasEl;
    const img = new Image();
    img.src = src;
    let cancelled = false;
    img
      .decode()
      .then(() => {
        if (cancelled) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")?.drawImage(img, 0, 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
</script>

{#if !allowed}
  <span class={cls} role="img" aria-label={alt ? `${alt}: external image blocked` : "External image blocked"} title="External media is off. Enable it in App Settings.">◻</span>
{:else if !isAnimated}
  <img {src} {alt} class={cls} {loading} />
{:else}
  <span
    class={cls}
    style="display:inline-grid"
    role="img"
    aria-label={alt}
    onmouseenter={animate === "hover" ? () => (hovered = true) : undefined}
    onmouseleave={animate === "hover" ? () => (hovered = false) : undefined}
  >
    <canvas
      bind:this={canvasEl}
      class={cls}
      style="grid-area:1/1;{playing && imgReady ? 'visibility:hidden' : ''}"
      >{alt}</canvas
    >
    {#if playing}
      <img
        {src}
        {alt}
        class={cls}
        style="grid-area:1/1"
        {loading}
        onload={() => (imgReady = true)}
      />
    {/if}
  </span>
{/if}
