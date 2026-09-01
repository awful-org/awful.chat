<script lang="ts">
  /**
   * What sits beside a room's name: its picture, its emoji, or the hash that
   * every room had before icons existed.
   *
   * The two icon forms are mutually exclusive by the time they reach here -
   * setRoomIcon() clears one when it writes the other - so the order below is
   * a safety net rather than a real precedence rule.
   *
   * The emoji inherits its font size from the surrounding text instead of
   * taking a size prop, so it tracks whatever scale the call site already
   * renders its room name at.
   */
  import { Hash } from "@lucide/svelte";
  import GifImage from "$lib/components/GifImage.svelte";

  interface Props {
    /** Room picture: a data: URL from the picker, or a linked GIF. */
    url?: string | null;
    /** Room emoji, already validated by normalizeRoomEmoji. */
    emoji?: string | null;
    /** Room name, for the picture's alt text. */
    name?: string;
    /** Box size, e.g. "size-4". Add a text-* class to scale the emoji. */
    class?: string;
    /** Applied to the hash fallback only, which needs its own opacity. */
    fallbackClass?: string;
  }

  let {
    url,
    emoji,
    name,
    class: cls = "size-4",
    fallbackClass = "",
  }: Props = $props();
</script>

{#if url}
  <GifImage
    src={url}
    alt={name ? `${name} icon` : "Room icon"}
    class="{cls} shrink-0 rounded-sm object-cover"
    animate="hover"
  />
{:else if emoji}
  <span
    class="{cls} inline-grid shrink-0 place-items-center leading-none select-none"
    aria-hidden="true">{emoji}</span
  >
{:else}
  <Hash class="{cls} shrink-0 {fallbackClass}" />
{/if}
