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
 * - Folds to the rail, as an editor's side panel does. Dragged on past the
 *   minimum by a clear distance (a distance, not "for a while": nothing
 *   here waits on a clock), the sidebar collapses; dragged back the other
 *   way across the same line, it opens again. The collapse is the same
 *   saved setting the collapse button and Ctrl+B use, and it leaves the
 *   saved width alone, so expanding comes back to the width from before.
 */

/** Today's expanded width, and the narrowest the column still fits in. */
export const SIDEBAR_MIN_PX = 272;
export const SIDEBAR_DEFAULT_PX = SIDEBAR_MIN_PX;
export const SIDEBAR_MAX_PX = 480;
/** Of the window: past this the chat is the thing that feels squeezed. */
export const SIDEBAR_MAX_SHARE = 0.4;
/** One arrow-key press. */
export const SIDEBAR_STEP_PX = 16;
/** The collapsed sidebar: the rail alone (RoomSidebar's `sm:w-14`). */
export const SIDEBAR_COLLAPSED_PX = 56;
/**
 * Where a drag folds the sidebar to its rail: an edge left of the midpoint
 * between the rail and the minimum width (164px, so 108px past the
 * minimum - more than anyone overshoots by). The same line opens the rail
 * again when a drag crosses it rightwards.
 */
export const SIDEBAR_COLLAPSE_AT_PX = (SIDEBAR_COLLAPSED_PX + SIDEBAR_MIN_PX) / 2;

/** What a drag on the edge shows: the rail alone, or the sidebar this wide. */
export type SidebarDrag = { collapsed: true } | { collapsed: false; width: number };

/**
 * Where a drag on the edge has got to. `dx` is how far the pointer has
 * moved since the press; the edge started at the rail when collapsed, or at
 * `startWidth` (the width drawn) when not. Left of SIDEBAR_COLLAPSE_AT_PX it
 * is the rail; right of it, the width the edge is at, clamped as always, so
 * the sidebar stops at the minimum on its way to collapsing.
 */
export function sidebarDragState(
  startCollapsed: boolean,
  startWidth: number,
  dx: number,
  viewportWidth: number
): SidebarDrag {
  const edge = (startCollapsed ? SIDEBAR_COLLAPSED_PX : startWidth) + dx;
  if (!Number.isFinite(edge)) {
    return startCollapsed
      ? { collapsed: true }
      : { collapsed: false, width: clampSidebarWidth(startWidth, viewportWidth) };
  }
  if (edge < SIDEBAR_COLLAPSE_AT_PX) return { collapsed: true };
  return { collapsed: false, width: clampSidebarWidth(edge, viewportWidth) };
}

/** What a finished drag saves; a field left out is left as it is. */
export interface SidebarDragCommit {
  collapsed?: boolean;
  width?: number;
}

/**
 * What to save when a drag ends at `end` (null: the pointer never moved,
 * so a click saves nothing). Ending on the rail saves only the collapse -
 * never the minimum width the drag passed through - so the width from
 * before comes back when the sidebar is expanded. Ending open saves the
 * width the edge was left at, and the expand when it started on the rail.
 */
export function sidebarDragCommit(
  startCollapsed: boolean,
  end: SidebarDrag | null
): SidebarDragCommit {
  if (end === null) return {};
  if (end.collapsed) return startCollapsed ? {} : { collapsed: true };
  return startCollapsed ? { collapsed: false, width: end.width } : { width: end.width };
}

/**
 * What a key does on the handle of a collapsed sidebar: Right arrow (the
 * way the edge would move) and Enter open it, at its saved width; nothing
 * else does anything. The open sidebar's keys only ever change the width
 * (sidebarWidthForKey): Left arrow stops at the minimum rather than
 * collapsing, so holding a key down cannot fold the sidebar away.
 */
export function collapsedSidebarKey(key: string): "expand" | null {
  return key === "ArrowRight" || key === "Enter" ? "expand" : null;
}

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
