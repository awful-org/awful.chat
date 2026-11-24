/**
 * What people are doing in plugins' call tiles: "Playing Jeopardy", "In
 * Waffle Party".
 *
 * Your own comes from your own plugins - what one says with
 * `host.setActivity`, else its `callTileActivity(cardState, selfDid)` as the
 * call-tile scan reads it - and the host tells the room, unless you turned
 * that off (call-status.svelte.ts). Everyone else's is what they told the
 * room in turn; `foldedActivity` is for peers on a build that tells nothing.
 */
import type { CallActivity } from "$lib/call-status";
import { callTilesState } from "./call-tiles.svelte";
import { cleanActivity } from "./activity-label";

/** What a plugin of ours said we are doing, by plugin. */
const said = $state<Record<string, string>>({});

export function setSelfActivity(pluginId: string, label: unknown): void {
  const clean = cleanActivity(label);
  if (clean) said[pluginId] = clean;
  else delete said[pluginId];
}

/** What we are doing in the call's tiles, one line per plugin. */
export function ownActivities(): CallActivity[] {
  const labels = new Map<string, string>();
  for (const tile of callTilesState.tiles) {
    if (tile.ownActivity) labels.set(tile.pluginId, tile.ownActivity);
  }
  for (const [plugin, label] of Object.entries(said)) labels.set(plugin, label);
  return [...labels].map(([plugin, label]) => ({ plugin, label }));
}

/**
 * What a plugin's shared state says this person is doing in a call tile of
 * `roomCode`. The tiles are the CALL room's, which need not be the room
 * being listed.
 */
export function foldedActivity(did: string, roomCode: string | null): CallActivity | null {
  for (const tile of callTilesState.tiles) {
    if (tile.roomCode !== roomCode) continue;
    const label = tile.activities?.[did];
    if (label) return { plugin: tile.pluginId, label };
  }
  return null;
}
