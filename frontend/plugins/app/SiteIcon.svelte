<script lang="ts">
  /**
   * A site's icon, or its first letter. Loaded straight from the site, so
   * only while "External previews and media" is on - like a link preview's
   * image, it tells the site the IP of everyone who sees the card - and with
   * no referrer, so it does not learn where it was shown. Most sites answer
   * one of these; the letter covers the rest.
   */
  import { canLoadMedia } from "$lib/media-prefs.svelte";

  let { url, class: className = "" }: { url: string; class?: string } = $props();

  const CANDIDATES = ["/favicon.ico", "/favicon.svg", "/icon.svg", "/favicon.png", "/apple-touch-icon.png"];

  const origin = $derived.by(() => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  });
  const letter = $derived(origin ? new URL(origin).host.charAt(0).toUpperCase() : "?");
  let attempt = $state(0);
  // A new site starts over.
  $effect(() => {
    void origin;
    attempt = 0;
  });
  const src = $derived(origin && attempt < CANDIDATES.length ? origin + CANDIDATES[attempt] : null);
  const show = $derived(!!src && canLoadMedia(src));
</script>

<!-- Gray behind a real icon, whose own colors should not fight the theme's
     green; the letter keeps the green badge the rest of the app uses. -->
<span
  class="grid shrink-0 place-items-center overflow-hidden rounded-md font-semibold {show
    ? 'bg-muted'
    : 'bg-primary/15 text-primary'} {className}"
>
  {#if show}
    <img
      {src}
      alt=""
      referrerpolicy="no-referrer"
      class="size-full object-contain p-1"
      onerror={() => (attempt += 1)}
    />
  {:else}
    {letter}
  {/if}
</span>
