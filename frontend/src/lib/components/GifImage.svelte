<script lang="ts">
  import { canLoadMedia } from "$lib/media-prefs.svelte";
  import { canDecodeStillFrame, stillFrameSize } from "$lib/image-size";
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
   *
   * The still frame is drawn at the size it is shown, not the image's own:
   * each canvas is a backing store of its own, and a peer's 16383x16383
   * avatar cost a gigabyte in every place it appeared. An image past
   * canDecodeStillFrame's bound is never decoded for a frame at all.
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
    let cancelled = false;
    // The size is known once it loads, from the header, before any decode.
    img.onload = () => {
      if (cancelled) return;
      const { naturalWidth: w, naturalHeight: h } = img;
      if (!canDecodeStillFrame(w, h)) return;
      img
        .decode()
        .then(() => {
          if (cancelled) return;
          // At the image's own size the canvas lays out in the box it is
          // shown in, set by the page (an avatar) or by the image (a GIF in
          // a message). Nothing is drawn at that size, so no backing store
          // is ever made for it.
          canvas.width = w;
          canvas.height = h;
          const size = stillFrameSize(
            w,
            h,
            canvas.clientWidth,
            canvas.clientHeight,
            devicePixelRatio
          );
          if (!size) return;
          canvas.width = size.width;
          canvas.height = size.height;
          canvas
            .getContext("2d")
            ?.drawImage(img, 0, 0, size.width, size.height);
        })
        .catch(() => {});
    };
    img.src = src;
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
  <!-- The one track is the span's own size. With auto tracks a size-full
       canvas took its height from the image instead, so a tall GIF in a
       round avatar drew a 24x72 bean. An unsized span (a GIF in a message)
       still sizes to the image: a percentage of an auto size is auto. -->
  <span
    class={cls}
    style="display:inline-grid;grid-template:100% / 100%"
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
