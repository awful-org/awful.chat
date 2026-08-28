<script lang="ts">
  /**
   * Renders text with the characters the query matched picked out.
   *
   * Highlighting is what turns a ranked list into an explainable one: the user
   * can see why a row matched, so a surprising order reads as informative
   * rather than broken. It is only possible because the matcher returns
   * positions; the cmdk-family scorers return a bare number and cannot do this.
   */
  import type { MatchRange } from "$lib/palette/scorer";

  interface Props {
    text: string;
    /** Ascending, non-overlapping. `mergeRanges` guarantees both. */
    ranges?: MatchRange[];
  }

  let { text, ranges = [] }: Props = $props();

  const segments = $derived.by(() => {
    if (ranges.length === 0) return [{ text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (const range of ranges) {
      // Guard against a range that outlived the text it was measured against.
      const start = Math.max(at, Math.min(range.start, text.length));
      const end = Math.max(start, Math.min(range.end, text.length));
      if (start > at) out.push({ text: text.slice(at, start), hit: false });
      if (end > start) out.push({ text: text.slice(start, end), hit: true });
      at = end;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  });
</script>

{#each segments as segment, i (i)}{#if segment.hit}<mark
      class="bg-transparent text-primary font-semibold">{segment.text}</mark
    >{:else}{segment.text}{/if}{/each}
