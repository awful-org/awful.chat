/**
 * How wide the expanded sidebar is, once its edge has been dragged.
 *
 * Pure: RoomSidebar and its handle own the pointer and the pixels, this only
 * answers "the edge is here - how wide is the sidebar". The width is the
 * whole sidebar (rail plus column), since that is what the bottom block
 * spans; the rail is fixed, so every pixel gained goes to the column.
 *
 * - Clamped. Never narrower than the sidebar always was (272px: the 64px
 *   rail and a 208px column), never wider than 480px or 40% of the window,
 *   whichever is smaller, so the chat keeps the room it needs.
 * - Re-clamped, not rewritten. A width saved on a big screen is kept as
 *   asked for and only drawn narrower while the window is small, so the
 *   sidebar grows back when the window does.
 */

/** Today's expanded width, and the narrowest the column still fits in. */
export const SIDEBAR_MIN_PX = 272;
export const SIDEBAR_DEFAULT_PX = SIDEBAR_MIN_PX;
export const SIDEBAR_MAX_PX = 480;
/** Of the window: past this the chat is the thing that feels squeezed. */
export const SIDEBAR_MAX_SHARE = 0.4;
/** One arrow-key press. */
export const SIDEBAR_STEP_PX = 16;

/** The widest the sidebar may be in a window this wide; never below the minimum. */
export function sidebarMaxWidth(viewportWidth: number): number {
  const share = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth * SIDEBAR_MAX_SHARE)
    : 0;
  return Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, share));
}

/** A width the sidebar can actually be drawn at in this window, in whole pixels. */
export function clampSidebarWidth(px: number, viewportWidth: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_PX;
  const max = sidebarMaxWidth(viewportWidth);
  return Math.min(max, Math.max(SIDEBAR_MIN_PX, Math.round(px)));
}

/**
 * What a key does on the resize handle: the new width, "default" to go back
 * to the default (Enter, like the double-click), or null for a key it does
 * not use. Arrows move the edge the way they point; Home and End go to the
 * ends of the range this window allows.
 */
export function sidebarWidthForKey(
  key: string,
  current: number,
  viewportWidth: number
): number | "default" | null {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(current - SIDEBAR_STEP_PX, viewportWidth);
    case "ArrowRight":
      return clampSidebarWidth(current + SIDEBAR_STEP_PX, viewportWidth);
    case "Home":
      return SIDEBAR_MIN_PX;
    case "End":
      return sidebarMaxWidth(viewportWidth);
    case "Enter":
      return "default";
    default:
      return null;
  }
}

/**
 * A stored width, or null (the default) for anything this app could not
 * have saved: missing, not a number, or outside the absolute range. It is
 * not clamped to the window here; that happens each time it is drawn.
 */
export function parseSidebarWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SIDEBAR_MIN_PX || n > SIDEBAR_MAX_PX) return null;
  return Math.round(n);
}

/** What to store for a width: null (remove the key) when it is the default. */
export function storedSidebarWidth(px: number | null): string | null {
  if (px === null) return null;
  const n = parseSidebarWidth(String(px));
  return n === null || n === SIDEBAR_DEFAULT_PX ? null : String(n);
}
