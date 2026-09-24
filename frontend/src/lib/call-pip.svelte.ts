/**
 * Picture-in-picture panel state for calls when the user navigates away.
 *
 * The panel floats in the app alongside the DM panel when the call is active
 * but the user is not on the call's room in the chat pane. It follows the
 * same pattern as dm-panel.svelte.ts: a single $state object with position
 * and visibility, viewport clamping on resize, and draggable movement.
 *
 * This module is deliberately a leaf: the main app flow and the call state
 * machines push into here, but it does not import the transport back.
 */

export interface CallPipPanelState {
  /** X coordinate relative to viewport left (pixels). */
  x: number;
  /** Y coordinate relative to viewport top (pixels). */
  y: number;
  /** Collapsed to title bar only. */
  minimized: boolean;
  /** Browser Element PiP window is open (via requestPictureInPicture). */
  browserPip: boolean;
}

// A 16:9 video under ONE row: the room, then the controls. Seven 44px
// buttons in 280px wrapped onto a second row and made the bar 132px tall.
export const WIDTH = 320;
export const HEIGHT = 180;
export const BAR_HEIGHT = 48;
/** Minimized: a pill holding the room, mute and expand. */
export const MINIMIZED_WIDTH = 220;

export const callPipPanel = $state<CallPipPanelState>({
  x: 0,
  y: 0,
  minimized: false,
  browserPip: false,
});

/**
 * Bottom-left position by default, so the panel never covers the DM panel's
 * bottom-right corner. If the viewport is too small, position in the top-left
 * instead to stay visible.
 */
/**
 * The panel's rendered width.
 *
 * ONE source of truth for both the clamp math here and the component's own
 * style, because the two silently disagreeing is how a panel ends up with a
 * strip of the screen it can never be dragged into: the spec narrows the panel
 * on a small screen, and a clamp still reserving the full width would keep
 * pushing it left of where it actually ends.
 */
export function panelWidth(): number {
  const width = callPipPanel.minimized ? MINIMIZED_WIDTH : WIDTH;
  if (typeof window === "undefined") return width;
  return Math.min(width, Math.max(0, window.innerWidth - 16));
}

export function defaultPanelPosition(): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 24, y: 24 };
  // LEFT edge. This previously used the DM panel's own bottom-right formula,
  // which put the two panels on top of each other by default - the call panel
  // sat entirely inside the DM panel's rectangle, which is exactly what
  // defaulting to the other corner is for.
  return {
    x: Math.min(24, Math.max(8, window.innerWidth - panelWidth() - 8)),
    y: Math.max(8, window.innerHeight - panelHeight() - 96),
  };
}

/**
 * The panel's real height. A voice-only call has no video body, so it is the
 * bar whether or not it is minimized.
 */
export function panelHeight(hasVideo = true): number {
  return callPipPanel.minimized || !hasVideo ? BAR_HEIGHT : HEIGHT + BAR_HEIGHT;
}

/**
 * Collapse to the pill or expand back, keeping the BOTTOM edge where it was:
 * the panel lives in a bottom corner, and resizing from the top left it
 * floating mid-screen or hanging off the bottom.
 */
export function setMinimized(minimized: boolean, hasVideo: boolean): void {
  if (callPipPanel.minimized === minimized) return;
  const before = panelHeight(hasVideo);
  callPipPanel.minimized = minimized;
  callPipPanel.y += before - panelHeight(hasVideo);
  clampPanelToViewport(hasVideo);
}

/**
 * Clamp the panel to the visible viewport on window resize.
 *
 * The panel can drift off-screen if the user resizes the window, so this
 * function slides it back into view without changing its size. It follows
 * the same logic as the DM panel.
 */
export function clampPanelToViewport(hasVideo = true): void {
  if (typeof window === "undefined") return;
  const minX = 8;
  const maxX = Math.max(minX, window.innerWidth - panelWidth() - 8);
  const minY = 8;
  // Against the panel's ACTUAL height. Reserving only the bar left the body -
  // another 158px - hanging below the viewport whenever the panel was not
  // minimized, so the clamp failed to do the one thing it exists for in the
  // common case.
  const maxY = Math.max(minY, window.innerHeight - panelHeight(hasVideo) - 8);

  callPipPanel.x = Math.max(minX, Math.min(callPipPanel.x, maxX));
  callPipPanel.y = Math.max(minY, Math.min(callPipPanel.y, maxY));
}
