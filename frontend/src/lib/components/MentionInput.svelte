<script lang="ts">
  import type { DraftSegment } from "$lib/mentions";

  interface Props {
    /** The raw draft text. */
    value: string;
    /**
     * The draft split into plain and mention runs. Concatenating the segment
     * text must reproduce `value` exactly, or the highlight drifts out of
     * alignment with the real characters.
     */
    segments: DraftSegment[];
    /** The underlying textarea, for caret math and focus by the parent. */
    el?: HTMLTextAreaElement | null;
    placeholder?: string;
    oninput?: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
  }

  let {
    value = $bindable(),
    segments,
    el = $bindable(null),
    placeholder,
    oninput,
    onkeydown,
  }: Props = $props();

  /**
   * A textarea cannot style its own content, so the highlight is a mirror
   * behind transparent text. The mirror is only trustworthy while it shares
   * every box and type metric with the textarea, so both read this one
   * string. Change a value here and the two move together.
   *
   * Nothing in the mirror may alter glyph advance widths - the mention chips
   * carry colour and background only, never a different weight or spacing.
   *
   * pr-28 keeps the text clear of the icon buttons the caller overlays on the
   * right; widen it if a button is added there.
   *
   * The font comes from the chat font properties so what you type matches what
   * you just read. `leading-normal` replaces the old fixed `leading-5`: a
   * 1.25rem line box clips once the chosen size passes it, and it clips the
   * mirror and the textarea by different amounts, which drifts the mention
   * chips off their glyphs.
   */
  const BOX =
    "border py-2 pl-3 pr-28 font-(family-name:--chat-font-family) text-(length:--chat-font-size) leading-normal";

  let scrollTop = $state(0);
  /**
   * Content-box width of the textarea. A classic (space-taking) scrollbar
   * narrows the real text once the draft overflows; copying the measured
   * width stops the mirror wrapping a character later than the textarea.
   */
  let contentWidth = $state<number | null>(null);

  $effect(() => {
    const node = el;
    if (!node || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      contentWidth = node.clientWidth;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  });

  // The caret moving can scroll the textarea without a scroll event firing in
  // every browser, so resync whenever the draft changes.
  $effect(() => {
    void value;
    if (el) scrollTop = el.scrollTop;
  });
</script>

<!-- The wrapper carries the background: the textarea itself has to be
     transparent for the mirror underneath it to show through. -->
<div class="relative w-full rounded-md bg-background">
  <div
    aria-hidden="true"
    class="pointer-events-none absolute left-px top-px overflow-hidden whitespace-pre-wrap break-words border-transparent text-foreground {BOX}"
    style={`height:calc(100% - 2px);${contentWidth === null ? "" : `width:${contentWidth}px;`}`}
  >
    <div style={`transform:translateY(${-scrollTop}px);`}>
      {#each segments as segment, index (index)}{#if segment.did === null}{segment.text}{:else}<span
            class="rounded-sm bg-primary/15 text-primary">{segment.text}</span
          >{/if}{/each}<!--
        A draft ending in a newline leaves an empty final line that collapses
        in a block container, so the mirror would come up one line short of
        the textarea. The zero-width space keeps that line box alive.
      -->{#if value.endsWith("\n")}{"\u200b"}{/if}
    </div>
  </div>

  <!-- block, not the default inline-block: an inline-level textarea sits on a
       text baseline and leaves descender space below it, which made the
       wrapper taller than the textarea and let the mirror show a line the
       textarea had already clipped. -->
  <textarea
    bind:this={el}
    bind:value
    {placeholder}
    {onkeydown}
    rows={1}
    oninput={() => oninput?.()}
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    class="relative block max-h-30 min-h-10 w-full resize-none overflow-y-auto rounded-md border-input bg-transparent text-transparent caret-foreground placeholder:text-muted-foreground selection:bg-primary/30 focus:outline-none focus:ring-1 focus:ring-ring {BOX}"
  ></textarea>
</div>
