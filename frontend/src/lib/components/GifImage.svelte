<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import { canLoadMedia } from "$lib/media-prefs.svelte";
  import {
    animatedView,
    canDecodeStillFrame,
    stillFrameRedraw,
  } from "$lib/image-size";
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
   * Nothing of an animated image is drawn until a copy of it, loaded out of
   * the page, says how large it is: its size is known once it loads, from
   * the header, before any decode. A peer's 16383x16383 GIF cost a gigabyte
   * decoded, for the still frame and again for the img that plays it, in
   * every place it was shown; past animatedView's bound it is a placeholder.
   * What plays is that copy itself. An img of the same url fetched it again
   * (Chromium does, for an image the server says not to store), and the
   * server could then answer with another image than the one checked.
   *
   * The still frame is drawn at the size it is shown, not the image's own:
   * each canvas is a backing store of its own. It is drawn again when its
   * box needs more pixels than it has, after a breakpoint or a zoom.
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
  /** The copy, and the src it is a copy of. Its img is null if it did not load. */
  let copy = $state.raw<{ src: string; img: HTMLImageElement | null }>();

  function urlLooksAnimated(s: string): boolean {
    if (s.startsWith("data:"))
      return (
        s.startsWith("data:image/gif") || s.startsWith("data:image/webp")
      );
    return /\.(gif|webp)([?#]|$)/i.test(s);
  }

  const isAnimated = $derived(animated ?? urlLooksAnimated(src));
  const allowed = $derived(canLoadMedia(src));
  const loaded = $derived(copy?.src === src ? copy.img : undefined);
  const view = $derived(
    animatedView(
      loaded && { width: loaded.naturalWidth, height: loaded.naturalHeight }
    )
  );
  const playing = $derived(
    isAnimated &&
      view === "shown" &&
      (animate === true || (animate === "hover" && hovered))
  );

  $effect(() => {
    src;
    if (!playing) imgReady = false;
  });

  /** The copy, put in the slot to play, and taken out again when it stops. */
  function play(img: HTMLImageElement): Attachment<HTMLElement> {
    return (slot) => {
      img.alt = alt;
      img.className = cls;
      img.style.gridArea = "1/1";
      slot.append(img);
      let gone = false;
      img.decode().then(
        () => {
          if (!gone) imgReady = true;
        },
        () => {}
      );
      return () => {
        gone = true;
        img.remove();
      };
    };
  }

  $effect(() => {
    if (!allowed || !isAnimated) return;
    const url = src;
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (!cancelled) copy = { src: url, img };
    };
    img.onerror = () => {
      if (!cancelled) copy = { src: url, img: null };
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (view !== "shown" || !loaded || !canvasEl) return;
    const canvas = canvasEl;
    const img = loaded;
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!canDecodeStillFrame(w, h)) return;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    img
      .decode()
      .then(() => {
        if (cancelled) return;
        // At the image's own size the canvas lays out in the box it is
        // shown in, set by the page (an avatar) or by the image (a GIF in
        // a message). Nothing is drawn at that size, so no backing store
        // is ever made for it. The box is read once laid out, along with
        // every other canvas's: read here, it forced a layout per frame.
        canvas.width = w;
        canvas.height = h;
        let drawn: { width: number; height: number } | undefined;
        observer = new ResizeObserver(([entry]) => {
          const size = stillFrameRedraw(
            drawn,
            w,
            h,
            entry.contentRect.width,
            entry.contentRect.height,
            devicePixelRatio
          );
          if (!size) return;
          drawn = size;
          canvas.width = size.width;
          canvas.height = size.height;
          canvas
            .getContext("2d")
            ?.drawImage(img, 0, 0, size.width, size.height);
        });
        try {
          // Its device pixels too, where the browser counts them: a zoom
          // changes those and leaves the box's CSS size as it was.
          observer.observe(canvas, { box: "device-pixel-content-box" });
        } catch {
          observer.observe(canvas);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  });
</script>

{#if !allowed}
  <span class={cls} role="img" aria-label={alt ? `${alt}: external image blocked` : "External image blocked"} title="External media is off. Enable it in App Settings.">◻</span>
{:else if !isAnimated}
  <img {src} {alt} class={cls} {loading} />
{:else if view === "too-large"}
  <span class={cls} role="img" aria-label={alt ? `${alt}: image too large` : "Image too large"} title="This image is too large to show.">◻</span>
{:else if view === "failed"}
  <span class={cls} role="img" aria-label={alt ? `${alt}: image did not load` : "Image did not load"} title="This image did not load.">◻</span>
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
    {#if playing && loaded}
      <!-- No box of its own: the copy it holds is the grid item. -->
      <span style="display:contents" {@attach play(loaded)}></span>
    {/if}
  </span>
{/if}
