/**
 * Shared spotlight calculation and utilities.
 *
 * AppView manages the state (clock, previous, PiP element) and exposes it
 * here so both CallPipPanel and the PiP video can access the same spotlight.
 */

import { buildCallTiles, type CallState } from "./call-tiles";
import type { SpotlightTile } from "./spotlight";
import type { SpeakerState } from "./spotlight";
import { callPipPanel } from "./call-pip.svelte";

export interface SpotlightState {
  /** Current spotlight tile ID */
  spotlightTileId: string | null;
  /** The full tile object for the current spotlight */
  spotlightTile: SpotlightTile | null;
  /** All tiles in the call */
  tiles: SpotlightTile[];
  /** Browser PiP video element, bound/passed by AppView */
  pipVideoElement: HTMLVideoElement | null;
  /** In-app panel video element, bound/passed by CallPipPanel */
  panelVideoElement: HTMLVideoElement | null;
}

// Module-level track start time tracking across rebuilds
export const trackStartTimes = new Map<string, number>();

/**
 * Build tiles with track start time tracking.
 *
 * Automatically records the first time each track appears so startedAt
 * is stable across spotlight changes.
 */
export function buildTilesWithTracking(callState: CallState): SpotlightTile[] {
  // No clock parameter on purpose: taking the ticking clock made the tile
  // list a dependency of it, so every tile object was rebuilt four times a
  // second and everything downstream (the srcObject swap included) re-ran.
  // First sight is the only time that matters, and startedAt is already read
  // off the map by the builder.
  const tiles = buildCallTiles({ ...callState, trackStartTimes });
  for (const tile of tiles) {
    if (tile.startedAt !== undefined && !trackStartTimes.has(tile.id)) {
      trackStartTimes.set(tile.id, tile.startedAt);
    }
  }
  for (const id of [...trackStartTimes.keys()]) {
    if (!tiles.some((t) => t.id === id)) trackStartTimes.delete(id);
  }
  return tiles;
}

/**
 * Create a canvas placeholder for avatar tiles.
 *
 * Each call creates a new canvas, drawn once. The stream's frame (frame 0)
 * stays on screen without redrawing: captureStream(0) returns a live stream
 * without further frame updates.
 *
 * @param label Peer's name or initials for the avatar
 * @param initial One-character initial for the avatar circle
 * @returns MediaStream for use as srcObject on a video element
 */
export function createCanvasPlaceholder(
  label: string,
  initial: string
): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Dark background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Avatar circle in center
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2.2;
    const radius = 60;

    // Gradient: slate to slate (neutral, matches dark theme)
    const gradient = ctx.createLinearGradient(
      centerX - radius,
      centerY - radius,
      centerX + radius,
      centerY + radius
    );
    gradient.addColorStop(0, "#475569");
    gradient.addColorStop(1, "#334155");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.fill();

    // Initial letter in white
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial.toUpperCase(), centerX, centerY);

    // Peer name below the circle
    ctx.fillStyle = "#d1d5db";
    ctx.font = "16px sans-serif";
    ctx.fillText(label, centerX, centerY + radius + 40);
  }

  // frameRate 0 means "only when asked": without requestFrame() the track
  // never emits a frame, the <video> never reaches HAVE_METADATA, and both
  // the panel body and requestPictureInPicture() stay blank.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as
    | (MediaStreamTrack & { requestFrame?: () => void })
    | undefined;
  track?.requestFrame?.();
  return stream;
}

/**
 * Derive a speaking label for a tile.
 *
 * Returns "sharing" for screens, "speaking" for others when the peer is
 * active in the speakers state, empty string otherwise.
 */
export function getSpeakingLabel(
  tile: SpotlightTile,
  speakers: SpeakerState
): string {
  if (tile.kind === "screen" || tile.kind === "transmission") {
    return "sharing";
  }
  if (speakers.speaking.has(tile.peerId)) {
    return "speaking";
  }
  return "";
}

/**
 * Public store for the full spotlight state.
 *
 * Managed by AppView (which owns the clock, previous memory, and updates tiles)
 * and CallPipPanel (which provides its video element).
 * Contains references to both video elements so AppView can update both
 * on spotlight changes.
 */
export const spotlightStore = $state<SpotlightState>({
  spotlightTileId: null,
  spotlightTile: null,
  tiles: [],
  pipVideoElement: null,
  panelVideoElement: null,
});

// ── Browser picture-in-picture ────────────────────────────────────────────
//
// Document PiP first (Chromium): it is what Meet uses, so a window manager
// rule that already floats Meet floats this too - on a tiling WM the element
// PiP window was getting tiled like any other window - and it renders our own
// markup (video + name) rather than a bare <video>. Element PiP on the hidden
// app-level <video> is the fallback for Firefox and Safari.

interface DocPipWindow extends Window {}
declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(opts?: { width?: number; height?: number }): Promise<DocPipWindow>;
      window: DocPipWindow | null;
    };
  }
}

let docPipWindow: DocPipWindow | null = null;
let docPipVideo: HTMLVideoElement | null = null;
let docPipLabel: HTMLElement | null = null;
/** What the PiP surfaces are currently showing, set by AppView's effect. */
let currentStream: MediaStream | null = null;
let currentLabel = "";
let currentFit: "cover" | "contain" = "cover";

/** AppView calls this whenever the spotlight stream, label or fit changes. */
export function setPipSource(
  stream: MediaStream | null,
  label: string,
  fit: "cover" | "contain"
): void {
  currentStream = stream;
  currentLabel = label;
  currentFit = fit;
  if (docPipVideo && docPipVideo.srcObject !== stream) docPipVideo.srcObject = stream;
  if (docPipVideo) docPipVideo.style.objectFit = fit;
  if (docPipLabel) docPipLabel.textContent = label;
}

export function browserPipSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    !!window.documentPictureInPicture ||
    !!spotlightStore.pipVideoElement?.requestPictureInPicture ||
    (!!spotlightStore.pipVideoElement &&
      "webkitSetPresentationMode" in spotlightStore.pipVideoElement)
  );
}

async function openDocumentPip(onReturn: () => void): Promise<void> {
  const api = window.documentPictureInPicture!;
  if (api.window) return;
  const w = await api.requestWindow({ width: 320, height: 180 });
  docPipWindow = w;
  const d = w.document;
  d.body.style.cssText =
    "margin:0;background:#000;overflow:hidden;font:12px system-ui,sans-serif;color:#fff";
  const video = d.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" + currentFit;
  video.srcObject = currentStream;
  video.title = "Back to the call";
  video.addEventListener("click", () => {
    window.focus();
    onReturn();
  });
  const label = d.createElement("div");
  label.style.cssText =
    "position:absolute;left:8px;bottom:6px;padding:2px 6px;border-radius:3px;background:rgba(0,0,0,.5)";
  label.textContent = currentLabel;
  d.body.append(video, label);
  docPipVideo = video;
  docPipLabel = label;
  callPipPanel.browserPip = true;
  w.addEventListener("pagehide", () => {
    docPipWindow = null;
    docPipVideo = null;
    docPipLabel = null;
    callPipPanel.browserPip = false;
  });
}

/**
 * Open the browser's PiP surface for the spotlight. `onReturn` runs when the
 * person clicks the picture (Document PiP only; an element PiP window has no
 * click we can see).
 */
export async function enterBrowserPip(onReturn: () => void): Promise<void> {
  try {
    if (window.documentPictureInPicture) {
      await openDocumentPip(onReturn);
      return;
    }
    const el = spotlightStore.pipVideoElement;
    if (!el) return;
    if (document.pictureInPictureElement === el) return;
    if (el.requestPictureInPicture) {
      await el.requestPictureInPicture();
    } else if ("webkitSetPresentationMode" in el) {
      (el as unknown as { webkitSetPresentationMode(m: string): void })
        .webkitSetPresentationMode("picture-in-picture");
    }
    callPipPanel.browserPip = true;
  } catch (err) {
    console.warn("[pip] could not open:", err);
  }
}

export async function exitBrowserPip(): Promise<void> {
  try {
    if (docPipWindow) {
      docPipWindow.close();
      docPipWindow = null;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      const el = spotlightStore.pipVideoElement;
      if (el && "webkitSetPresentationMode" in el) {
        (el as unknown as { webkitSetPresentationMode(m: string): void })
          .webkitSetPresentationMode("inline");
      }
    }
  } catch {
    // Already closed.
  }
  callPipPanel.browserPip = false;
}
