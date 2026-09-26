/**
 * Call tiles popped out into windows of their own.
 *
 * A stream you want on another monitor, or beside the chat at its own size,
 * without the always-on-top single slot that picture-in-picture is. Each
 * popped tile gets a plain same-origin popup (`window.open("")`), and this
 * module draws into it from here: the popup is about:blank and runs no app
 * of its own, so the live track is simply handed to a <video> in its
 * document - no second connection, no re-negotiation, nothing to sync but
 * the track and the name.
 *
 * The flip side: the popup lives on the app tab. Reload or close the tab
 * and the stream behind it is gone, so the popups close with it (pagehide)
 * rather than freeze on a last frame.
 *
 * AppView owns the sync: it has the call's tile list whichever room the
 * view is on, so a popped share keeps following its track while the stage
 * itself is not mounted. The stage only asks and shows a placeholder.
 */

import { SvelteSet } from "svelte/reactivity";
import type { SpotlightTile } from "./spotlight";

/** The tiles currently in a window of their own. Reactive, for the stage. */
export const poppedOut = new SvelteSet<string>();

interface Popout {
  win: Window;
  video: HTMLVideoElement;
  label: HTMLElement;
  empty: HTMLElement;
  /** What the <video> carries, so an unchanged track is never reassigned. */
  trackId: string | null;
  /** When the tile left the call's list, if it has; see MISSING_GRACE_MS. */
  missingSince: number | null;
}

/**
 * How long a tile may be missing before its window closes. A watched share's
 * tile drops out of the list whenever its track does - a media reconnect
 * included - and comes back under the same id; closing at once would throw
 * the window away over a hiccup.
 */
const MISSING_GRACE_MS = 5000;

const windows = new Map<string, Popout>();
let closedPoll: ReturnType<typeof setInterval> | null = null;
let unloadHooked = false;

/**
 * Desktop only. A phone opens a popup as another tab, and a background tab
 * does not play - the button would move the stream somewhere it cannot be
 * seen.
 */
export function popoutSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.open === "function" &&
    !window.matchMedia("(pointer: coarse)").matches
  );
}

/** The window's title bar and taskbar entry: whose stream this is. */
function titleFor(tile: SpotlightTile, name: string): string {
  const what = tile.kind === "camera" ? name : `${name}'s screen`;
  return `${what} - awful.chat`;
}

/**
 * Open (or bring forward) a window for this tile. Call it from a click:
 * browsers block popups without a gesture. False when the browser did.
 */
export function openPopout(tile: SpotlightTile, name: string): boolean {
  const existing = windows.get(tile.id);
  if (existing && !existing.win.closed) {
    existing.win.focus();
    return true;
  }
  const width = 960;
  const height = 540;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  // No noopener: the opener's handle to this document is the whole design.
  const win = window.open(
    "",
    `awful-popout-${tile.id}`,
    `popup,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`
  );
  if (!win) return false;

  const d = win.document;
  d.title = titleFor(tile, name);
  d.body.replaceChildren();
  d.body.style.cssText =
    "margin:0;height:100vh;background:#000;overflow:hidden;font:13px system-ui,sans-serif;color:#fff";

  const video = d.createElement("video");
  video.autoplay = true;
  // Sound stays in the app tab, where the call's own volume controls are.
  video.muted = true;
  video.playsInline = true;
  video.title = "Double-click for fullscreen";
  video.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain" +
    (tile.isLocal && tile.kind === "camera" ? ";transform:scaleX(-1)" : "");
  video.addEventListener("dblclick", () => {
    if (d.fullscreenElement) void d.exitFullscreen().catch(() => {});
    else void d.body.requestFullscreen().catch(() => {});
  });

  // Shown while there is no picture: a camera turned off, a share between
  // tracks. The window stays; the picture comes back when the track does.
  const empty = d.createElement("div");
  empty.style.cssText =
    "position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#a1a1aa";

  const label = d.createElement("div");
  label.style.cssText =
    "position:absolute;left:8px;bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.6)";

  d.body.append(video, empty, label);

  const entry: Popout = { win, video, label, empty, trackId: null, missingSince: null };
  windows.set(tile.id, entry);
  poppedOut.add(tile.id);
  render(entry, tile, name);

  win.addEventListener("pagehide", () => forget(tile.id));
  hookUnload();
  startClosedPoll();
  return true;
}

function render(entry: Popout, tile: SpotlightTile, name: string): void {
  const track = tile.videoTrack;
  const trackId = track?.id ?? null;
  if (trackId !== entry.trackId) {
    entry.trackId = trackId;
    // A MediaStream from this realm plays in the popup's <video>: same
    // origin, same agent - exactly what the Document PiP window does.
    entry.video.srcObject = track ? new MediaStream([track]) : null;
  }
  entry.video.style.display = track ? "" : "none";
  entry.empty.style.display = track ? "none" : "flex";
  entry.empty.textContent =
    tile.kind === "camera" ? `${name} - camera off` : "Waiting for the picture...";
  entry.label.textContent = tile.kind === "camera" ? name : `${name}'s screen`;
  entry.win.document.title = titleFor(tile, name);
}

/**
 * Follow the call: new tracks go to their window, and a tile that has left
 * the call (share ended, person hung up) closes its window - after
 * MISSING_GRACE_MS, waiting on "no picture" meanwhile.
 */
export function syncPopouts(
  tiles: readonly SpotlightTile[],
  nameFor: (tile: SpotlightTile) => string
): void {
  for (const [id, entry] of windows) {
    if (entry.win.closed) {
      forget(id);
      continue;
    }
    const tile = tiles.find((t) => t.id === id);
    if (tile) {
      entry.missingSince = null;
      render(entry, tile, nameFor(tile));
    } else if (entry.missingSince === null) {
      entry.missingSince = Date.now();
      showWaiting(entry);
    }
  }
}

function showWaiting(entry: Popout): void {
  entry.trackId = null;
  entry.video.srcObject = null;
  entry.video.style.display = "none";
  entry.empty.style.display = "flex";
  entry.empty.textContent = "Waiting for the picture...";
}

export function focusPopout(id: string): void {
  windows.get(id)?.win.focus();
}

/** Close one window, bringing the tile back into the call. */
export function closePopout(id: string): void {
  const entry = windows.get(id);
  forget(id);
  if (entry && !entry.win.closed) entry.win.close();
}

export function closeAllPopouts(): void {
  for (const id of [...windows.keys()]) closePopout(id);
}

function forget(id: string): void {
  const entry = windows.get(id);
  if (entry) entry.video.srcObject = null;
  windows.delete(id);
  poppedOut.delete(id);
  if (windows.size === 0 && closedPoll) {
    clearInterval(closedPoll);
    closedPoll = null;
  }
}

/**
 * pagehide from the popup is not guaranteed (a window closed while its
 * opener is busy, some window managers), and a tile left marked "popped
 * out" with no window would show a placeholder forever. A cheap check while
 * any is open - which is also what ends a missing tile's grace, since a tile
 * that stays gone never triggers another sync.
 */
function startClosedPoll(): void {
  if (closedPoll) return;
  closedPoll = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of windows) {
      if (entry.win.closed) forget(id);
      else if (entry.missingSince !== null && now - entry.missingSince > MISSING_GRACE_MS) {
        closePopout(id);
      }
    }
  }, 1000);
}

function hookUnload(): void {
  if (unloadHooked) return;
  unloadHooked = true;
  window.addEventListener("pagehide", closeAllPopouts);
}
