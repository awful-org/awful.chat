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
 * The push to the SFU client lives here rather than in the stage because it
 * has to outlast the stage: the stage unmounts the moment the user opens
 * another room, which is exactly when most cameras stop being shown.
 */

import { SvelteMap } from "svelte/reactivity";
import { _video, transportState } from "$lib/transport/transport.svelte";
import { spotlightStore } from "$lib/call-spotlight.svelte";
import { poppedOut } from "$lib/call-popout.svelte";
import { wantedCameras } from "$lib/call-tiles";

/**
 * Remote camera tiles the stage has on screen, element to peerId. By
 * element, so a tile that moves between layouts (grid to focus) and is on
 * screen twice for a moment still leaves cleanly.
 */
const stageTiles = new SvelteMap<Element, string>();

/** The stage has this peer's camera tile on screen. */
export function stageCameraShown(tile: Element, peerId: string): void {
  if (stageTiles.get(tile) !== peerId) stageTiles.set(tile, peerId);
}

/** The stage no longer has this tile on screen, or no longer has it. */
export function stageCameraHidden(tile: Element): void {
  if (stageTiles.has(tile)) stageTiles.delete(tile);
}

// One root for the life of the page, made when this module loads: outside any
// component, so no surface unmounting can take it down with it. Nothing is
// sent outside a call; leaving one resets the SFU client to no opinion, and
// the next call's inCall re-runs this for its own screen.
if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      if (!transportState.inCall) return;
      _video.setWantedCameras(
        wantedCameras(stageTiles.values(), spotlightStore.spotlightTile, poppedOut)
      );
    });
  });
}
