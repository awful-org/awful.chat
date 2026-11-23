import type { Attachment } from "svelte/attachments";
import { HOLD_MS, pressMove } from "$lib/sidebar-rail";

/**
 * Hold a finger still on an element to open its menu: the touch twin of a
 * right-click, for rows that have a menu but no drag.
 *
 * Android raises a contextmenu event for a long press, iOS Safari never does,
 * so relying on that event left an iPhone with no way to the menu at all.
 * This times the hold itself - the same HOLD_MS and slop as the sidebar's
 * rail - and then answers for the gesture: the contextmenu Android may still
 * fire and the click the lift produces are both swallowed, so the menu is
 * opened once and the row's tap action (a profile card, say) does not run
 * underneath it.
 *
 * Mouse and pen are left alone: they have a real right-click.
 */
export function longPress(onHold: (el: HTMLElement) => void): Attachment<HTMLElement> {
  return (el) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { id: number; x: number; y: number } | null = null;
    /** The hold fired: what the platform does next belongs to it. */
    let answered = false;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      start = null;
    };

    const onDown = (e: PointerEvent) => {
      answered = false;
      clear();
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      start = { id: e.pointerId, x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        start = null;
        answered = true;
        onHold(el);
      }, HOLD_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      // A swipe is a scroll, not a hold.
      if (pressMove(Math.hypot(e.clientX - start.x, e.clientY - start.y)) === "swipe") clear();
    };
    const onEnd = () => clear();
    const onContextMenu = (e: MouseEvent) => {
      // Android's own long press, while ours is pending or has fired.
      if (answered || timer) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!answered) return;
      answered = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);
    // Capture, so they run before the element's own handlers.
    el.addEventListener("contextmenu", onContextMenu, true);
    el.addEventListener("click", onClick, true);
    return () => {
      clear();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("click", onClick, true);
    };
  };
}

/**
 * The keyboard's way to a context menu: the menu key, or Shift+F10. Browsers
 * differ on whether these raise a contextmenu event, and where it lands when
 * they do, so a row with a menu listens for the keys itself.
 */
export function isMenuKey(e: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
}
