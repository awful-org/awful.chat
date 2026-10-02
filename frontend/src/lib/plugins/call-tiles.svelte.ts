/**
 * Discovery for plugin call tiles: which cards of the call's room should
 * currently occupy a tile in the call grid.
 *
 * The answer derives from SHARED state only - stored cards plus each
 * plugin's pure callTileActive(cardState) predicate - so every client in
 * the call shows and hides the same tiles in the same fold, with no
 * side-channel "presence" that could diverge. Newest active card per
 * plugin wins: one tile per plugin.
 */
import { getPluginCardMessages } from "$lib/storage";
import { MessageType } from "$lib/types/message";
import { getPlugin } from "./registry";
import { getCardState } from "./state.svelte";
import { isPluginEnabled } from "./prefs.svelte";

export interface PluginCallTile {
  pluginId: string;
  cardId: string;
  roomCode: string;
  /** Names using the tile right now, for the host's audience chip. */
  viewers: string[];
  /** The plugin's `callTileFocusOnJoin`; absent means true. */
  focusOnJoin?: boolean;
}

export const callTilesState = $state({
  tiles: [] as PluginCallTile[],
});

let _seq = 0;
let _debounce: ReturnType<typeof setTimeout> | undefined;

/** Debounced rescan: card-state ticks arrive in bursts (a fold cascade, a
 *  sync backfill), and one trailing scan covers them all. */
export function refreshCallTiles(roomCode: string | null): void {
  if (!roomCode) {
    clearTimeout(_debounce);
    callTilesState.tiles = [];
    return;
  }
  clearTimeout(_debounce);
  _debounce = setTimeout(() => void _scan(roomCode), 250);
}

/** The scan reads ONLY the room's plugin-card rows (clear-field filtered,
 *  a handful of decrypts) - never the whole history. Seq-guarded so a
 *  slower older scan can never overwrite a newer one. */
async function _scan(roomCode: string): Promise<void> {
  const seq = ++_seq;
  try {
    const messages = await getPluginCardMessages(roomCode);
    // Newest first, one winner per plugin.
    const byPlugin = new Map<string, PluginCallTile>();
    for (const msg of [...messages].reverse()) {
      if (msg.type !== MessageType.PluginCard) continue;
      let pluginId: string | undefined;
      try {
        pluginId = (JSON.parse(msg.content) as { pluginId?: string }).pluginId;
      } catch {
        continue;
      }
      if (!pluginId || byPlugin.has(pluginId) || !isPluginEnabled(pluginId))
        continue;
      const plugin = await getPlugin(pluginId);
      if (!plugin?.callTile) continue;
      const state = await getCardState(msg.id, roomCode, plugin);
      const active = plugin.callTileActive
        ? plugin.callTileActive(state)
        : true;
      if (active) {
        let viewers: string[] = [];
        try {
          viewers = plugin.callTileViewers?.(state) ?? [];
        } catch {
          // A viewers hook must never take the tile down with it.
        }
        byPlugin.set(pluginId, {
          pluginId,
          cardId: msg.id,
          roomCode,
          viewers,
          focusOnJoin: plugin.callTileFocusOnJoin !== false,
        });
      } else {
        // The newest card decides for its plugin even when inactive -
        // an older still-"active" card must not resurrect the tile.
        byPlugin.set(pluginId, null as unknown as PluginCallTile);
      }
    }
    if (seq !== _seq) return;
    callTilesState.tiles = [...byPlugin.values()].filter(Boolean);
  } catch (err) {
    console.warn("[plugins] call tile scan failed:", err);
  }
}
