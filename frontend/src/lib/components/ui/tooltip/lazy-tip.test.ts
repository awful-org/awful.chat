import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTipTrigger } from "./lazy-tip";

/**
 * A lazy tip builds its tooltip only when show() is called, so these rules
 * are what keeps a list of hundreds of rows from building hundreds of
 * tooltips nobody is pointing at.
 */
function control() {
  const doc = new EventTarget();
  return { ownerDocument: doc } as unknown as HTMLElement & { ownerDocument: EventTarget };
}

function pointer(el: HTMLElement, pointerType = "mouse"): PointerEvent {
  return { pointerType, currentTarget: el } as unknown as PointerEvent;
}

function focusOn(el: HTMLElement): FocusEvent {
  return { currentTarget: el } as unknown as FocusEvent;
}

describe("lazy tip trigger", () => {
  let show: ReturnType<typeof vi.fn<(anchor: HTMLElement) => void>>;
  let hide: ReturnType<typeof vi.fn<() => void>>;
  let trigger: ReturnType<typeof createTipTrigger>;

  beforeEach(() => {
    vi.useFakeTimers();
    show = vi.fn<(anchor: HTMLElement) => void>();
    hide = vi.fn<() => void>();
    trigger = createTipTrigger({ delay: () => 250, show, hide });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds nothing until a pointer has rested on the control", () => {
    const el = control();
    trigger.pointerEnter(pointer(el));
    vi.advanceTimersByTime(249);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledWith(el);
  });

  it("shows nothing for a pointer that only passes over", () => {
    const el = control();
    trigger.pointerEnter(pointer(el));
    vi.advanceTimersByTime(100);
    trigger.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
  });

  it("shows nothing for a finger", () => {
    const el = control();
    trigger.pointerEnter(pointer(el, "touch"));
    trigger.pointerMove(pointer(el, "touch"));
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
  });

  it("counts the first move of a pointer that was already resting there", () => {
    const el = control();
    trigger.pointerMove(pointer(el));
    trigger.pointerMove(pointer(el));
    vi.advanceTimersByTime(250);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("shows at once on keyboard focus, and hides on blur", () => {
    const el = control();
    trigger.focus(focusOn(el));
    expect(show).toHaveBeenCalledWith(el);
    trigger.blur();
    expect(hide).toHaveBeenCalled();
  });

  it("takes focus from a press for what it is, until the press ends", () => {
    const el = control();
    trigger.press(pointer(el));
    trigger.focus(focusOn(el));
    expect(show).not.toHaveBeenCalled();
    el.ownerDocument.dispatchEvent(new Event("pointerup"));
    trigger.blur();
    trigger.focus(focusOn(el));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("hides on a press, and drops a show still waiting", () => {
    const el = control();
    trigger.pointerEnter(pointer(el));
    trigger.press(pointer(el));
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
  });

  it("fires nothing once disposed", () => {
    const el = control();
    trigger.pointerEnter(pointer(el));
    trigger.dispose();
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
  });
});
