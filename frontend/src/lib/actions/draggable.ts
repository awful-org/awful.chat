/**
 * Drag a floating panel by a handle inside it.
 *
 * Applied to the handle, not the panel: a panel dragged by its whole surface
 * cannot hold a scrollable list or a text input. Pointer capture, so a fast
 * drag that outruns the cursor does not drop the panel where the pointer left
 * the element.
 */
export function draggable(
  node: HTMLElement,
  params: {
    /** Current position, so the drag starts where the panel actually is. */
    get: () => { x: number; y: number };
    /** Clamped position, every move. */
    set: (pos: { x: number; y: number }) => void;
    /** Panel size, to keep it on screen. */
    size: () => { width: number; height: number };
  }
): { destroy(): void } {
  if (typeof window === "undefined") return { destroy() {} };

  const EDGE = 8;
  let from: { x: number; y: number; pointerX: number; pointerY: number } | null =
    null;

  const onDown = (e: PointerEvent) => {
    // A drag handle usually carries buttons (close, expand). Let them win.
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;
    const at = params.get();
    from = { x: at.x, y: at.y, pointerX: e.clientX, pointerY: e.clientY };
    node.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent) => {
    if (!from) return;
    const { width, height } = params.size();
    // Clamped against the viewport, not the movement: a panel dragged off the
    // edge cannot be dragged back, because its handle went with it.
    params.set({
      x: Math.max(
        EDGE,
        Math.min(
          from.x + (e.clientX - from.pointerX),
          window.innerWidth - width - EDGE
        )
      ),
      y: Math.max(
        EDGE,
        Math.min(
          from.y + (e.clientY - from.pointerY),
          window.innerHeight - height - EDGE
        )
      ),
    });
  };

  const onUp = (e: PointerEvent) => {
    from = null;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
  };

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);

  return {
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    },
  };
}
