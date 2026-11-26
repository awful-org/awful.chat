/**
 * Tells the SFU client which remote cameras something on screen shows.
 *
 * Every remote camera used to be received and decoded for the whole call,
 * whether anything showed it or not (MediasoupVideo.setWantedCameras says
 * what that cost). Three surfaces show cameras, and this unions them
 * (call-tiles.ts, wantedCameras):
 *
 *   - the call stage, which reports each remote camera tile it has on
 *     screen here (VoiceVideoCallView's cameraOnScreen action);
 *   - the spotlight, which AppView computes for the floating panel and
 *     picture in picture;
 *   - the tiles popped out into windows of their own.
 *
 * Plus whoever is talking, whom the spotlight may move to next, where there
 * is a spotlight: a quick call (/qc) has no AppView to compute one.
 *
 * It also says how large each one is (setCameraDisplaySizes), and the SFU
 * is asked for the smallest of the camera's levels that fills the largest:
 *
 *   - a stage tile is measured here;
 *   - the floating panel is never wider than panelWidth(), and the spotlight
 *     and whoever is talking (who may move into it) are counted at that;
 *   - picture in picture and windows of their own can be any size, and get
 *     the top level.
 *
 * The push to the SFU client lives here rather than in the stage because it
 * has to outlast the stage: the stage unmounts the moment the user opens
 * another room, which is exactly when most cameras stop being shown.
 */

import { SvelteMap } from "svelte/reactivity";
import { _video, selfId, transportState } from "$lib/transport/transport.svelte";
import { spotlightStore } from "$lib/call-spotlight.svelte";
import { callFocus } from "$lib/call-focus.svelte";
import { poppedOut } from "$lib/call-popout.svelte";
import { speakers } from "$lib/speakers.svelte";
import { wantedCameras } from "$lib/call-tiles";
import { cameraDisplaySizes } from "$lib/transport/camera-quality";
import { callPipPanel, panelWidth } from "$lib/call-pip.svelte";

/**
 * Remote camera tiles the stage has on screen, element to peerId. By
 * element, so a tile that moves between layouts (grid to focus) and is on
 * screen twice for a moment still leaves cleanly.
 */
const stageTiles = new SvelteMap<Element, string>();

/** Each on-screen stage tile's long side, in CSS pixels. */
const stageTileSizes = new SvelteMap<Element, number>();
let tileSizeObserver: ResizeObserver | null = null;

/**
 * The long side a 16:9 camera is drawn at in a tile of this size. Camera
 * tiles crop to fill (object-cover), so in a tile taller than 16:9 the
 * picture is drawn wider than the tile: a 300x600 tile shows it 1067 wide.
 */
function longSide(width: number, height: number): number {
  return Math.round(Math.max(width, (height * 16) / 9));
}

/** The stage has this peer's camera tile on screen. */
export function stageCameraShown(tile: Element, peerId: string): void {
  if (stageTiles.get(tile) !== peerId) stageTiles.set(tile, peerId);
  if (typeof ResizeObserver === "undefined" || stageTileSizes.has(tile)) return;
  // Measured now as well as observed: the observer reports on its next
  // frame, and until a size is known the camera is asked for at the top.
  const box = tile.getBoundingClientRect();
  stageTileSizes.set(tile, longSide(box.width, box.height));
  tileSizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!stageTileSizes.has(entry.target)) continue;
      const size = longSide(entry.contentRect.width, entry.contentRect.height);
      if (stageTileSizes.get(entry.target) !== size) stageTileSizes.set(entry.target, size);
    }
  });
  tileSizeObserver.observe(tile);
}

/** The stage no longer has this tile on screen, or no longer has it. */
export function stageCameraHidden(tile: Element): void {
  if (stageTiles.has(tile)) stageTiles.delete(tile);
  if (stageTileSizes.has(tile)) {
    stageTileSizes.delete(tile);
    tileSizeObserver?.unobserve(tile);
  }
}

/**
 * Hand the SFU client what is shown now. Nothing is sent outside a call:
 * leaving one resets the client to no opinion, and the next call's inCall
 * runs this again for its own screen.
 *
 * Run from the effect below, so every read here is a dependency. Most runs
 * change nothing for the cameras (AppView hands the spotlight a new tile
 * object on every roster change), and the client ignores an equal set.
 */
export function pushWantedCameras(): void {
  if (!transportState.inCall) return;
  const surfaces = {
    spotlight: spotlightStore.spotlightTile,
    pinnedTileId: callFocus.pinnedTileId,
    poppedOut,
    speaking: speakers.speaking,
    selfId: selfId(),
  };
  const wanted = wantedCameras({
    ...surfaces,
    stage: [...stageTiles.values(), ...spotlightStore.pipCameraPeers],
  });
  _video.setWantedCameras(wanted);

  const measured: [string, number][] = [];
  for (const [tile, peerId] of stageTiles) {
    const size = stageTileSizes.get(tile);
    if (size !== undefined) measured.push([peerId, size]);
  }
  // The spotlight and the talkers, at the floating panel's size. The hidden
  // video that keeps picture in picture ready shows the spotlight too, and
  // nobody sees it until picture in picture opens, counted below.
  const panel = panelWidth();
  for (const peerId of wantedCameras({ ...surfaces, stage: [], poppedOut: [] })) {
    measured.push([peerId, panel]);
  }
  // Sizes nobody here can see: picture in picture, and windows of their own.
  const unmeasured = wantedCameras({
    spotlight: null,
    pinnedTileId: null,
    speaking: [],
    selfId: surfaces.selfId,
    poppedOut,
    stage: spotlightStore.pipCameraPeers,
  });
  const spot = surfaces.spotlight;
  if (callPipPanel.browserPip && spot?.kind === "camera" && !spot.isLocal) {
    unmeasured.add(spot.peerId);
  }
  _video.setCameraDisplaySizes(cameraDisplaySizes(wanted, unmeasured, measured));
}

// One root for the life of the page, made when this module loads: outside any
// component, so no surface unmounting can take it down with it.
if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      pushWantedCameras();
    });
  });
}
