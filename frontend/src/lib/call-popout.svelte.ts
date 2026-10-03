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
  /** The tile as last drawn: what to say once it leaves the call's list. */
  kind: SpotlightTile["kind"];
  peerId: string;
  isLocal: boolean;
  name: string;
  /** Why the tile is gone, if it is; see syncPopouts. */
  missing: "reconnecting" | "ended" | null;
  /** When a window whose tile is gone closes. */
  closeAt: number | null;
  /** Hides the pointer and the name once the mouse rests; see IDLE_MS. */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * How long the mouse may rest before the pointer and the name label go, the
 * way a video player clears the picture. Any movement brings both back.
 */
const IDLE_MS = 2000;

/**
 * A tile that leaves the call's list is either coming back or gone for good,
 * and the window says which instead of one "Waiting for the picture..." for
 * both - which read as a stall when the stream had simply ended.
 *
 * A watched share whose track drops (a media reconnect) leaves the list but
 * keeps its placeholder tile: we are still watching, just without a picture.
 * That window waits, and says it is reconnecting. When the share ends, the
 * watch goes with it (transmissionEnded), and so does the placeholder - the
 * window says who stopped, long enough to read, and closes.
 */
const RECONNECT_GRACE_MS = 20_000;
const ENDED_CLOSE_MS = 2500;

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
  // No title tooltip: the browser shows it exactly when the mouse comes to
  // rest, which is the moment the pointer is meant to disappear.
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
    "position:absolute;left:8px;bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.6);transition:opacity .3s";

  d.body.append(video, empty, label);

  const entry: Popout = {
    win,
    video,
    label,
    empty,
    trackId: null,
    kind: tile.kind,
    peerId: tile.peerId,
    isLocal: tile.isLocal,
    name,
    missing: null,
    closeAt: null,
    idleTimer: undefined,
  };
  const wake = () => {
    d.body.style.cursor = "";
    label.style.opacity = "1";
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      d.body.style.cursor = "none";
      label.style.opacity = "0";
    }, IDLE_MS);
  };
  d.addEventListener("mousemove", wake);
  d.addEventListener("pointerdown", wake);
  wake();
  windows.set(tile.id, entry);
  poppedOut.add(tile.id);
  render(entry, tile, name);

  win.addEventListener("pagehide", () => forget(tile.id));
  hookUnload();
  startClosedPoll();
  return true;
}

function render(entry: Popout, tile: SpotlightTile, name: string): void {
  entry.kind = tile.kind;
  entry.peerId = tile.peerId;
  entry.isLocal = tile.isLocal;
  entry.name = name;
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
 * the call closes its window - at once with a word on why when the stream
 * ended, after a wait when it is only reconnecting (see RECONNECT_GRACE_MS).
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
      entry.missing = null;
      entry.closeAt = null;
      render(entry, tile, nameFor(tile));
      continue;
    }
    const reconnecting =
      entry.kind === "screen" &&
      !entry.isLocal &&
      tiles.some((t) => t.id === `pending-tx-${entry.peerId}`);
    const why = reconnecting ? "reconnecting" : "ended";
    if (entry.missing === why) continue;
    entry.missing = why;
    entry.closeAt = Date.now() + (reconnecting ? RECONNECT_GRACE_MS : ENDED_CLOSE_MS);
    showGone(entry, goneText(entry, reconnecting));
  }
}

/** What the window says once its tile is gone. */
function goneText(entry: Popout, reconnecting: boolean): string {
  if (reconnecting) return `Reconnecting to ${entry.name}'s screen...`;
  if (entry.kind === "camera") return `${entry.name} left the call`;
  return entry.isLocal ? "You stopped sharing" : `${entry.name} stopped sharing`;
}

function showGone(entry: Popout, text: string): void {
  entry.trackId = null;
  entry.video.srcObject = null;
  entry.video.style.display = "none";
  entry.empty.style.display = "flex";
  entry.empty.textContent = text;
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
  if (entry) {
    entry.video.srcObject = null;
    clearTimeout(entry.idleTimer);
  }
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
 * any is open - which is also what closes a window whose tile is gone, since
 * a tile that stays gone never triggers another sync.
 */
function startClosedPoll(): void {
  if (closedPoll) return;
  closedPoll = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of windows) {
      if (entry.win.closed) forget(id);
      else if (entry.closeAt !== null && now >= entry.closeAt) closePopout(id);
    }
  }, 1000);
}

function hookUnload(): void {
  if (unloadHooked) return;
  unloadHooked = true;
  window.addEventListener("pagehide", closeAllPopouts);
}
