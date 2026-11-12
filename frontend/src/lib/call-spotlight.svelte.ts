/**
 * Shared PiP tile state and browser window utilities.
 *
 * AppView manages the speaker hold and tile roster. PiP surfaces use the same
 * layout preferences as the call stage, not just the held speaker's video.
 */

import { buildCallTiles, type CallState } from "./call-tiles";
import type { SpotlightTile } from "./spotlight";
import { callPipPanel } from "./call-pip.svelte";
import { requestElementPip } from "./plugins/media-session";
import { pipLayoutVideo } from "./call-pip-layout";

export interface SpotlightState {
  /** Current spotlight tile ID */
  spotlightTileId: string | null;
  /** The full tile object for the current spotlight */
  spotlightTile: SpotlightTile | null;
  /** All tiles in the call */
  tiles: SpotlightTile[];
  /** Browser PiP video element, bound/passed by AppView */
  pipVideoElement: HTMLVideoElement | null;
  /** Remote cameras actually visible in any active PiP layout. */
  pipCameraPeers: string[];
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
 * Public store for the full spotlight state.
 *
 * AppView owns the speaker/tiles and hidden browser video; active PiP surfaces
 * report their visible cameras so SFU subscriptions outlive the main stage.
 */
export const spotlightStore = $state<SpotlightState>({
  spotlightTileId: null,
  spotlightTile: null,
  tiles: [],
  pipVideoElement: null,
  pipCameraPeers: [],
});

// ── Browser picture-in-picture ────────────────────────────────────────────
//
// Document PiP first (Chromium): it is what Meet uses, so a window manager
// rule that already floats Meet floats this too - on a tiling WM the element
// PiP window was getting tiled like any other window. Element PiP on the hidden
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
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;cursor:pointer";
  const surface = pipLayoutVideo(video, { width: w.innerWidth, height: w.innerHeight, active: true });
  const resize = () => surface.update({ width: w.innerWidth, height: w.innerHeight, active: true });
  w.addEventListener("resize", resize);
  video.title = "Back to the call";
  video.addEventListener("click", () => {
    window.focus();
    onReturn();
  });
  d.body.append(video);
  callPipPanel.browserPip = true;
  w.addEventListener("pagehide", () => {
    docPipWindow = null;
    w.removeEventListener("resize", resize);
    surface.destroy();
    callPipPanel.browserPip = false;
  });
}

/**
 * Open the browser's PiP surface for the call layout. `onReturn` runs when the
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
    // The same element-PiP dance the plugin API offers, kept in one place.
    if (await requestElementPip(el)) callPipPanel.browserPip = true;
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
