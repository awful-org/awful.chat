/**
 * What people are doing in plugins' call tiles: "Playing Jeopardy", "In
 * Waffle Party".
 *
 * Your own comes from the tiles you have open in the call - what a plugin
 * says with `host.setActivity`, else its `callTileActivity(cardState,
 * selfDid)` as the call-tile scan reads it - and the host tells the room,
 * unless you turned that off (call-status.svelte.ts). Only from an open tile:
 * a card's state alone is other people's to write, and goes on naming you
 * after you left. Everyone else's is what they told the room in turn;
 * `foldedActivity` is for peers on a build that tells nothing.
 */
import { SvelteMap } from "svelte/reactivity";
import type { CallActivity } from "$lib/call-status";
import { onIdentityLock } from "$lib/identity/lock-events";
import { callTilesState } from "./call-tiles.svelte";
import { cleanActivity } from "./activity-label";

interface OpenTile {
  pluginId: string;
  roomCode: string;
  /** A tile can be drawn twice for a moment, as it moves. */
  views: number;
  /** What its plugin said we are doing. */
  said: string | null;
}

const open = new SvelteMap<string, OpenTile>();
const tileKey = (pluginId: string, roomCode: string) => `${roomCode}\n${pluginId}`;

/**
 * We have this plugin's tile open in this room, until the returned function
 * is called; what it said we are doing ends with it.
 */
export function openTile(pluginId: string, roomCode: string): () => void {
  const key = tileKey(pluginId, roomCode);
  const held = open.get(key);
  open.set(key, held ? { ...held, views: held.views + 1 } : { pluginId, roomCode, views: 1, said: null });
  let closed = false;
  return () => {
    const tile = open.get(key);
    if (closed || !tile) return;
    closed = true;
    if (tile.views > 1) open.set(key, { ...tile, views: tile.views - 1 });
    else open.delete(key);
  };
}

/** From anything but an open tile - a card, a widget, one just closed - it is nothing. */
export function setSelfActivity(pluginId: string, roomCode: string, label: unknown): void {
  const key = tileKey(pluginId, roomCode);
  const tile = open.get(key);
  const said = cleanActivity(label);
  if (tile && tile.said !== said) open.set(key, { ...tile, said });
}

/** What we are doing in the tiles open in this call's room, one line per plugin. */
export function ownActivities(callRoom: string | null): CallActivity[] {
  const out: CallActivity[] = [];
  for (const { pluginId, roomCode, said } of open.values()) {
    if (roomCode !== callRoom) continue;
    const label =
      said ??
      callTilesState.tiles.find((t) => t.pluginId === pluginId && t.roomCode === roomCode)?.ownActivity;
    if (label) out.push({ plugin: pluginId, label });
  }
  return out;
}

onIdentityLock(() => open.clear());

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
