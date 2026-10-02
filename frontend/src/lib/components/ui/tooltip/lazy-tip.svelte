<script lang="ts">
  /**
   * Tip, for controls that come in hundreds: the hover toolbar, reaction
   * chips and status ticks on every message.
   *
   * Tip builds a whole tooltip per instance - provider, root, trigger,
   * content and a portal of its own into <body> - whether it ever opens or
   * not. A message row had three or more of them, and they were most of what
   * a row cost to mount: about half the time and two thirds of the memory of
   * a long scrollback. This one hands its child plain handlers, builds the
   * tooltip (the same TooltipContent) only when the control is pointed at or
   * focused, and takes it down again once it has closed.
   *
   *   <LazyTip text="Reply">
   *     {#snippet children(props)}
   *       <button {...props} aria-label="Reply">...</button>
   *     {/snippet}
   *   </LazyTip>
   */
  import { onDestroy, tick, type Snippet } from "svelte";
  import { Tooltip as TooltipPrimitive } from "bits-ui";
  import TooltipContent from "./tooltip-content.svelte";
  import { createTipTrigger } from "./lazy-tip";

  let {
    text,
    side = "top",
    delayDuration = 250,
    children,
  }: {
    text: string;
    side?: "top" | "right" | "bottom" | "left";
    delayDuration?: number;
    children: Snippet<[Record<string, unknown>]>;
  } = $props();

  const uid = $props.id();
  const contentId = `${uid}-tip`;
  let anchor = $state<HTMLElement | null>(null);
  /** The tooltip exists - from the first show until it has closed. */
  let built = $state(false);
  let open = $state(false);
  /** Still asked for: a hide can land while the tooltip is being built. */
  let wanted = false;

  const trigger = createTipTrigger({
    delay: () => delayDuration,
    show: async (el) => {
      wanted = true;
      anchor = el;
      if (!built) {
        built = true;
        // Opened once mounted, so bits-ui sees it open and animates it in.
        await tick();
      }
      if (wanted) open = true;
    },
    hide: () => {
      wanted = false;
      // Never opened: there is no closing to wait for.
      if (open) open = false;
      else built = false;
    },
  });
  onDestroy(trigger.dispose);

  const triggerProps = $derived({
    tabindex: 0,
    "aria-describedby": open ? contentId : undefined,
    onpointerenter: trigger.pointerEnter,
    onpointermove: trigger.pointerMove,
    onpointerleave: trigger.pointerLeave,
    onpointerdown: trigger.press,
    onfocus: trigger.focus,
    onblur: trigger.blur,
    // Using the control - Enter or Space on a focused one too - hides the
    // tip, as bits-ui's trigger does on click. In the capture phase: every
    // child sets its own onclick after these props, which replaces an
    // onclick given here (it replaced Tip's as well).
    onclickcapture: trigger.activate,
  });
</script>

{#if !text}
  {@render children({})}
{:else}
  {@render children(triggerProps)}
  {#if built && anchor}
    <TooltipPrimitive.Provider delayDuration={0} disableHoverableContent>
      <TooltipPrimitive.Root
        bind:open
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen) built = false;
        }}
      >
        <!-- Opened by hand, so bits-ui calls it instant-open; it fades in
             like Tip's delayed-open all the same. -->
        <TooltipContent
          {side}
          id={contentId}
          customAnchor={anchor}
          class="data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0"
          >{text}</TooltipContent
        >
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  {/if}
{/if}
