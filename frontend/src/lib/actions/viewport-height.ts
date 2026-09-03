import type { ActionReturn } from "svelte/action";

/**
 * Size a node to the space that actually exists, not the space the layout
 * viewport claims.
 *
 * `100vh` is the large viewport and `100dvh` still knows nothing about the
 * software keyboard, so on a phone both describe a box taller than what the
 * user can see the moment a text field is focused - which is exactly when it
 * matters, because the thing under the keyboard is the input they are typing
 * into. visualViewport is the only thing that reports the real number.
 *
 * `min-height` is set alongside `height` on purpose: several of these nodes
 * carry a `min-h-dvh` class as the fallback for a browser with no
 * visualViewport, and a min-height in that unit would otherwise override the
 * height set here and undo the whole point.
 */
export function viewportHeight(node: HTMLElement): ActionReturn {
  if (typeof window === "undefined" || !window.visualViewport) {
    return { destroy() {} };
  }
  const vv = window.visualViewport;
  const update = () => {
    node.style.height = vv.height + "px";
    node.style.minHeight = vv.height + "px";
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  // Defer so the drawer is fully mounted and visible
  setTimeout(update, 0);
  return {
    destroy() {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    },
  };
}
