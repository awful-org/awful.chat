/**
 * When a lazy tip (lazy-tip.svelte) shows and hides. Kept apart from the
 * component so the rules can be tested without a DOM.
 *
 * The rules are bits-ui's trigger's, which Tip uses: a pointer that rests on
 * the control for the delay shows it, keyboard focus shows it at once, and
 * leaving, blurring, pressing or using it hides it. A finger has no hover,
 * and focus that comes from a press is not keyboard focus, so neither shows
 * anything.
 */
export interface TipTrigger {
  pointerEnter(e: PointerEvent): void;
  pointerMove(e: PointerEvent): void;
  pointerLeave(): void;
  press(e: PointerEvent): void;
  focus(e: FocusEvent): void;
  blur(): void;
  /** The control was used: a click, from a pointer or from Enter or Space. */
  activate(): void;
  /** The component went away: nothing may fire after this. */
  dispose(): void;
}

export function createTipTrigger(opts: {
  /** How long a pointer has to rest on the control, in ms. */
  delay: () => number;
  show: (anchor: HTMLElement) => void;
  hide: () => void;
}): TipTrigger {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovering = false;
  let pressed = false;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function hoverStart(e: PointerEvent): void {
    if (e.pointerType === "touch") return;
    hovering = true;
    const anchor = e.currentTarget as HTMLElement;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      opts.show(anchor);
    }, opts.delay());
  }

  return {
    pointerEnter: hoverStart,
    // A pointer already resting on the control when it appeared never
    // entered it; its first move counts instead.
    pointerMove(e) {
      if (!hovering) hoverStart(e);
    },
    pointerLeave() {
      hovering = false;
      cancel();
      opts.hide();
    },
    press(e) {
      pressed = true;
      cancel();
      opts.hide();
      const doc = (e.currentTarget as Element | null)?.ownerDocument;
      doc?.addEventListener("pointerup", () => (pressed = false), { once: true });
    },
    focus(e) {
      if (pressed) return;
      cancel();
      opts.show(e.currentTarget as HTMLElement);
    },
    blur() {
      cancel();
      opts.hide();
    },
    activate() {
      cancel();
      opts.hide();
    },
    dispose: cancel,
  };
}
