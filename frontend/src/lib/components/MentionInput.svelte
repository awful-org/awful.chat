<script lang="ts">
  import type { DraftSegment } from "$lib/mentions";
  import { tick } from "svelte";
  import { commonEmoji, emojiToken, insertEmoji, searchEmoji, type EmojiSuggestion } from "$lib/emoji-autocomplete";

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
    /** Widens the left padding for an icon button the caller overlays
     *  there, the same way pr-28 clears the right-side buttons. */
    padLeft?: boolean;
    oninput?: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
  }

  let {
    value = $bindable(),
    segments,
    el = $bindable(null),
    placeholder,
    padLeft = false,
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
   * The right padding keeps the text clear of the icon buttons the caller
   * overlays there; widen it if a button is added. It is responsive because
   * those buttons are: below `sm` they grow to a 44px touch target (three of
   * them plus the gaps is 9rem), and back to 32px above it. Same story for
   * padLeft and the slash-command button on the left.
   *
   * The font comes from the chat font properties so what you type matches what
   * you just read. `leading-normal` replaces the old fixed `leading-5`: a
   * 1.25rem line box clips once the chosen size passes it, and it clips the
   * mirror and the textarea by different amounts, which drifts the mention
   * chips off their glyphs.
   */
  /**
   * A FIXED text size, deliberately not the chat font size.
   *
   * The composer used to scale with the message font, which grew the box until
   * it scrolled - the complaint that moved --chat-font-size onto the message
   * list in the first place. It then kept referencing that variable from a
   * place the variable no longer reaches, so `var()` resolved to nothing, the
   * font-size declaration was dropped, and the box inherited a size it was not
   * laid out for and scrolled again for a different reason.
   *
   * The chosen font FAMILY still applies: that variable stays on the chat root
   * on purpose, so the composer matches what you are reading.
   */
  const BOX = $derived(
    `border py-2 ${padLeft ? "pl-13 sm:pl-11" : "pl-3"} pr-36 sm:pr-28 font-(family-name:--chat-font-family) text-sm leading-normal`
  );

  let scrollTop = $state(0);
  const inputId = $props.id();
  let caret = $state(0);
  let selectionEnd = $state(0);
  let focused = $state(false);
  let composing = $state(false);
  let dismissedAt = $state<number | null>(null);
  let suggestions = $state<EmojiSuggestion[]>([]);
  let selected = $state(0);
  let searching = $state(false);
  const token = $derived(focused && !composing ? emojiToken(value, caret, selectionEnd) : null);
  const emojiOpen = $derived(!!token && dismissedAt !== token.start && !token.closed);

  function syncCaret() {
    caret = el?.selectionStart ?? 0;
    selectionEnd = el?.selectionEnd ?? caret;
  }

  $effect(() => {
    const current = token;
    if (!current) { dismissedAt = null; return; }
    if (dismissedAt === current.start) return;
    const draft = value;
    suggestions = commonEmoji(current.query);
    selected = 0;
    searching = true;
    let cancelled = false;
    void searchEmoji(current.query).then((results) => {
      if (cancelled || value !== draft) return;
      searching = false;
      suggestions = results;
      // A fully typed :shortcode: resolves too, but unknown names stay literal.
      const exact = results.find((emoji) => emoji.shortcode === current.query);
      if (current.closed && exact) void chooseEmoji(exact);
    });
    return () => { cancelled = true; };
  });

  async function chooseEmoji(emoji: EmojiSuggestion) {
    if (!token) return;
    const next = insertEmoji(value, token, emoji.unicode);
    value = next.value;
    suggestions = [];
    await tick();
    if (!el) return;
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
    syncCaret();
    oninput?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    // IME Enter commits composition, not an emoji or a message.
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (emojiOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissedAt = token!.start;
        return;
      }
      if (["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key) && !event.shiftKey) {
        if (suggestions.length) {
          event.preventDefault();
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
            void tick().then(() => document.getElementById(`${inputId}-emoji-${selected}`)?.scrollIntoView({ block: "nearest" }));
          } else void chooseEmoji(suggestions[selected]);
          return;
        }
        // Do not send the draft while an emoji query is still loading.
        if (searching && event.key === "Enter") { event.preventDefault(); return; }
      }
    }
    onkeydown?.(event);
  }
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
  {#if emojiOpen}
    <div class="absolute bottom-full left-0 z-50 mb-1 w-full max-w-sm overflow-hidden rounded-md border border-border bg-popover shadow-lg">
      <div class="px-3 py-2 text-[10px] font-mono text-muted-foreground">Emojis · ↑↓ navigate · Enter select · Esc cancel</div>
      <div id={`${inputId}-emojis`} role="listbox" aria-label="Emoji suggestions" class="max-h-48 overflow-y-auto">
        {#each suggestions as emoji, index (emoji.unicode)}
          <button type="button" role="option" aria-selected={selected === index}
            id={`${inputId}-emoji-${index}`}
            class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted {selected === index ? 'bg-muted' : ''}"
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => void chooseEmoji(emoji)}>
            <span class="text-xl">{emoji.unicode}</span><span class="truncate font-mono">:{emoji.shortcode}:</span>
          </button>
        {:else}
          <div role="status" class="px-3 py-2 text-xs text-muted-foreground">{searching ? "Searching emojis..." : "No matching emojis"}</div>
        {/each}
      </div>
    </div>
  {/if}
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
    onkeydown={handleKeydown}
    onkeyup={syncCaret}
    onclick={syncCaret}
    onselect={syncCaret}
    onfocus={() => { focused = true; syncCaret(); }}
    onblur={() => (focused = false)}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => { composing = false; syncCaret(); }}
    aria-label={placeholder ?? "Message"}
    aria-autocomplete="list"
    aria-controls={emojiOpen ? `${inputId}-emojis` : undefined}
    aria-activedescendant={emojiOpen && suggestions.length ? `${inputId}-emoji-${selected}` : undefined}
    rows={1}
    oninput={(event) => { value = event.currentTarget.value; syncCaret(); oninput?.(); }}
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    class="relative block max-h-30 min-h-10 w-full resize-none overflow-y-auto rounded-md border-input bg-transparent text-transparent caret-foreground placeholder:text-muted-foreground selection:bg-primary/30 focus:outline-none focus:ring-1 focus:ring-ring {BOX}"
  ></textarea>
</div>
