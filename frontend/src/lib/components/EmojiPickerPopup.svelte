<script lang="ts">
  interface Props {
    open: boolean;
    /**
     * Viewport rect of the element that opened the picker. Anchoring to the
     * trigger rather than to the pointer is what makes keyboard activation
     * land in the same place as a click - a synthetic click reports
     * clientX/clientY of 0, which used to pin the panel to the top-left
     * corner.
     */
    anchor: DOMRect | null;
    /** Side to try first. The panel flips when that side has no room. */
    prefer?: "above" | "below";
    onSelect: (emoji: string) => void;
    onClose: () => void;
  }

  let {
    open,
    anchor,
    prefer = "above",
    onSelect,
    onClose,
  }: Props = $props();

  /** Keep-out distance from the viewport edges. */
  const MARGIN = 8;
  /** Breathing room between the trigger and the panel. */
  const GAP = 6;

  // Seeded with the panel's own CSS size (w-85, 420px of picker, 1px borders)
  // so the very first frame is already in the right place; the bindings below
  // then take over with the measured truth. These are border-box sizes, which
  // is what the edge clamp below is written against.
  let panelWidth = $state(340);
  let panelHeight = $state(422);

  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  let picker = $state<HTMLElement | null>(null);

  // The picker is a custom element, so it upgrades in place once the
  // definition loads - no need to carry the library before the first open.
  //
  // Opening it means looking for an emoji, so the search box takes the focus.
  // It lives in the picker's shadow root and only exists once the element has
  // upgraded AND rendered (it loads its emoji data first), so it is waited
  // for a few frames rather than assumed. Not on a touch screen: there the
  // focus pulls up the keyboard, which covers the grid the tap opened.
  $effect(() => {
    if (!open) return;
    const el = picker;
    let cancelled = false;
    void import("emoji-picker-element").then(async () => {
      if (!el || window.matchMedia("(pointer: coarse)").matches) return;
      await customElements.whenDefined("emoji-picker");
      for (let frame = 0; frame < 60 && !cancelled; frame++) {
        const search = el.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]");
        if (search) {
          search.focus({ preventScroll: true });
          return;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    return () => {
      cancelled = true;
    };
  });

  const position = $derived.by(() => {
    if (!anchor || viewportWidth === 0) return { left: MARGIN, top: MARGIN };

    const roomAbove = anchor.top - MARGIN - GAP;
    const roomBelow = viewportHeight - anchor.bottom - MARGIN - GAP;
    const preferAbove = prefer === "above";

    // Take the preferred side when it fits, the other side when only that
    // fits, and otherwise the roomier side - clamping then does the rest.
    const preferredRoom = preferAbove ? roomAbove : roomBelow;
    const otherRoom = preferAbove ? roomBelow : roomAbove;
    let above: boolean;
    if (preferredRoom >= panelHeight) above = preferAbove;
    else if (otherRoom >= panelHeight) above = !preferAbove;
    else above = roomAbove >= roomBelow;

    const rawTop = above
      ? anchor.top - GAP - panelHeight
      : anchor.bottom + GAP;
    // Centre on the trigger horizontally; the clamp pulls it back in when the
    // trigger sits near an edge, which is the normal case for composer icons.
    const rawLeft = anchor.left + anchor.width / 2 - panelWidth / 2;

    const maxLeft = Math.max(MARGIN, viewportWidth - panelWidth - MARGIN);
    const maxTop = Math.max(MARGIN, viewportHeight - panelHeight - MARGIN);

    return {
      left: Math.min(Math.max(rawLeft, MARGIN), maxLeft),
      top: Math.min(Math.max(rawTop, MARGIN), maxTop),
    };
  });
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  bind:innerHeight={viewportHeight}
  onkeydown={(e) => {
    if (!open || e.key !== "Escape") return;
    e.preventDefault();
    onClose();
  }}
/>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-40 cursor-default"
    aria-label="Close emoji picker"
    onclick={onClose}
  ></button>

  <div
    class="fixed z-50 w-85 overflow-hidden rounded-md border border-border bg-card shadow-xl"
    style={`left:${position.left}px; top:${position.top}px;`}
    bind:offsetWidth={panelWidth}
    bind:offsetHeight={panelHeight}
  >
    <!-- display:block matters: an un-upgraded custom element is inline, and an
         inline box ignores height, so without it the panel measures 0 tall on
         the first open and the flip decision is made on a bogus size. -->
    <emoji-picker
      bind:this={picker}
      style="display:block;height:420px;"
      onemoji-click={(e: any) => {
        onSelect(e.detail.unicode);
        onClose();
      }}
    ></emoji-picker>
  </div>
{/if}
