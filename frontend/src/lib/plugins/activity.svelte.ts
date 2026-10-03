/**
 * "Playing Jeopardy" under a name in the call's user list: what a plugin's
 * tile says a person is doing there.
 *
 * Other people's come from the plugin's `callTileActivities(cardState)`,
 * read in the call-tile scan, so they derive from shared state like the
 * audience chip. Your own row comes from `host.setActivity`, because your
 * own live updates never fold back to you.
 */
import { callTilesState } from "./call-tiles.svelte";
import { cleanActivity } from "./activity-label";

/** Your own activity, by plugin. Local only: never sent anywhere. */
const self = $state<Record<string, string>>({});

export function setSelfActivity(pluginId: string, label: unknown): void {
  const clean = cleanActivity(label);
  if (clean) self[pluginId] = clean;
  else delete self[pluginId];
}

/**
 * What this person is doing in a call tile of `roomCode`, if a plugin says.
 * The tiles are the CALL room's, which need not be the room being listed.
 */
export function activityFor(did: string, isSelf: boolean, roomCode: string | null): string | null {
  if (isSelf) return Object.values(self)[0] ?? null;
  for (const tile of callTilesState.tiles) {
    if (tile.roomCode !== roomCode) continue;
    const label = tile.activities?.[did];
    if (label) return label;
  }
  return null;
}
