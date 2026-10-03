/**
 * Discovery for plugin call tiles: which cards of the call's room should
 * currently occupy a tile in the call grid.
 *
 * The answer derives from SHARED state only - stored cards plus each
 * plugin's pure callTileActive(cardState) predicate - so every client in
 * the call shows and hides the same tiles in the same fold, with no
 * side-channel "presence" that could diverge. Newest active card per
 * plugin wins: one tile per plugin.
 *
 * Two halves, at two speeds. WHICH card is the newest of each plugin changes
 * only when a card is stored, so it is read from storage then (and when a
 * room starts being watched) and kept - a card can ask the same question
 * (newestCardOf). Whether that card is active, and who is in it, changes
 * with every fold, and is answered from the card states the host holds,
 * with no storage at all. The call used to re-read the call room's whole
 * history on both: every chat line, every vote, every heartbeat of an open
 * app.
 */
import { SvelteMap } from "svelte/reactivity";
import { onIdentityLock } from "$lib/identity/lock-events";
import { getPluginCardMessages, onMessageStored } from "$lib/storage";
import { MessageType } from "$lib/types/message";
import { getManifest, getPlugin } from "./registry";
import { getCardState, rowRoute } from "./state.svelte";
import { isPluginEnabled } from "./prefs.svelte";
import { cleanActivity } from "./activity-label";

export interface PluginCallTile {
  pluginId: string;
  cardId: string;
  roomCode: string;
  /** Names using the tile right now, for the host's audience chip. */
  viewers: string[];
  /** The plugin's `callTileFocusOnJoin`; absent means true. */
  focusOnJoin?: boolean;
  /** What people are doing in the tile, by DID (`callTileActivities`). */
  activities?: Record<string, string>;
}

export const callTilesState = $state({
  tiles: [] as PluginCallTile[],
});

// ── the newest card of each plugin, per watched room ─────────────────────────

interface Newest {
  cardId: string;
  lamport: number;
}

interface WatchedRoom {
  watchers: number;
  /** pluginId -> its newest card; registered plugins only. */
  newest: Map<string, Newest>;
  /** The stored rows the last scan read (getMessagesOfTypes' snapshot). */
  version?: number;
  scan?: Promise<void>;
  /** A card landed while a scan ran: scan once more after it. */
  again: boolean;
  listeners: Set<() => void>;
}

const _watched = new Map<string, WatchedRoom>();

/** Reactive: `${roomCode}\n${pluginId}` -> the newest card's id. */
const _newestCards = new SvelteMap<string, string>();

const newestKey = (roomCode: string, pluginId: string) => `${roomCode}\n${pluginId}`;

/**
 * The newest card of a plugin in a room someone is watching (watchRoomCards),
 * reactively: read inside a component, it updates as cards are stored.
 */
export function newestCardOf(roomCode: string, pluginId: string): string | undefined {
  return _newestCards.get(newestKey(roomCode, pluginId));
}

let _hooked = false;

/**
 * Keep the newest card of each plugin in this room known, until the
 * returned function is called. Storage is read when the watch starts and
 * whenever a card is stored in the room - nothing else moves the answer.
 */
export function watchRoomCards(roomCode: string, onChange?: () => void): () => void {
  if (!_hooked) {
    _hooked = true;
    onMessageStored((msg) => {
      if (msg.type !== MessageType.PluginCard) return;
      const room = _watched.get(msg.roomCode);
      if (room) void scanRoom(msg.roomCode, room);
    });
  }
  let room = _watched.get(roomCode);
  if (!room) {
    room = { watchers: 0, newest: new Map(), again: false, listeners: new Set() };
    _watched.set(roomCode, room);
  }
  room.watchers += 1;
  if (onChange) room.listeners.add(onChange);
  // Every new watcher checks again: cheap when nothing moved (the stored
  // rows' version says so), and a room deleted while nobody watched must not
  // keep its old answer.
  void scanRoom(roomCode, room);
  const watched = room;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (onChange) watched.listeners.delete(onChange);
    watched.watchers -= 1;
    if (watched.watchers > 0 || _watched.get(roomCode) !== watched) return;
    _watched.delete(roomCode);
    for (const pluginId of watched.newest.keys()) {
      _newestCards.delete(newestKey(roomCode, pluginId));
    }
  };
}

function scanRoom(roomCode: string, room: WatchedRoom): Promise<void> {
  if (room.scan) {
    room.again = true;
    return room.scan;
  }
  room.scan = (async () => {
    do {
      room.again = false;
      const snapshot: { version?: number } = {};
      const cards = await getPluginCardMessages(roomCode, snapshot);
      if (_watched.get(roomCode) !== room) return;
      if (snapshot.version !== undefined && snapshot.version === room.version) continue;
      room.version = snapshot.version;
      // Lamport order, so a later card of a plugin replaces an earlier one.
      // Only plugins this build has: a member naming made-up plugins on
      // their cards must not grow this, or what each recompute walks.
      const newest = new Map<string, Newest>();
      for (const card of cards) {
        const pluginId = rowRoute(card)?.pluginId;
        if (typeof pluginId !== "string" || !getManifest(pluginId)) continue;
        newest.set(pluginId, { cardId: card.id, lamport: card.lamport });
      }
      let changed = newest.size !== room.newest.size;
      for (const [pluginId, held] of newest) {
        const key = newestKey(roomCode, pluginId);
        if (_newestCards.get(key) !== held.cardId) _newestCards.set(key, held.cardId);
        if (room.newest.get(pluginId)?.cardId !== held.cardId) changed = true;
      }
      for (const pluginId of room.newest.keys()) {
        if (!newest.has(pluginId)) _newestCards.delete(newestKey(roomCode, pluginId));
      }
      room.newest = newest;
      if (changed) for (const listener of room.listeners) listener();
    } while (room.again);
  })()
    .catch((err) => console.warn("[plugins] card scan failed:", err))
    .finally(() => {
      room.scan = undefined;
      // A card that landed after the last pass looked, but before this one
      // was done, still gets its pass.
      if (room.again && _watched.get(roomCode) === room) void scanRoom(roomCode, room);
    });
  return room.scan;
}

// ── the call's tiles ─────────────────────────────────────────────────────────

let _seq = 0;
let _debounce: ReturnType<typeof setTimeout> | undefined;
let _callRoom: string | null = null;
let _unwatchCall: (() => void) | null = null;

/** Debounced recompute: card-state ticks arrive in bursts (a fold cascade,
 *  a sync backfill), and one trailing pass covers them all. */
export function refreshCallTiles(roomCode: string | null): void {
  if (roomCode !== _callRoom) {
    _unwatchCall?.();
    _unwatchCall = null;
    _callRoom = roomCode;
    if (roomCode) _unwatchCall = watchRoomCards(roomCode, () => schedule(roomCode));
  }
  clearTimeout(_debounce);
  if (!roomCode) {
    _seq += 1;
    if (callTilesState.tiles.length) callTilesState.tiles = [];
    return;
  }
  schedule(roomCode);
}

function schedule(roomCode: string): void {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => void _recompute(roomCode), 250);
}

/** Seq-guarded so a slower older pass can never overwrite a newer one. */
async function _recompute(roomCode: string): Promise<void> {
  const seq = ++_seq;
  try {
    const room = _watched.get(roomCode);
    // A room whose first scan failed has no answer to work from; the next
    // tick tries again rather than leaving the call tileless until a card
    // happens to be stored.
    if (room && room.version === undefined && !room.scan) void scanRoom(roomCode, room);
    const newest = [...(room?.newest ?? [])].sort(
      ([, a], [, b]) =>
        b.lamport - a.lamport || (a.cardId < b.cardId ? 1 : a.cardId > b.cardId ? -1 : 0)
    );
    // Newest first. The newest card decides for its plugin even when it is
    // inactive - an older still-"active" card must not resurrect the tile.
    const tiles: PluginCallTile[] = [];
    for (const [pluginId, { cardId }] of newest) {
      if (!isPluginEnabled(pluginId)) continue;
      const plugin = await getPlugin(pluginId);
      if (!plugin?.callTile) continue;
      // A held state answers at once; only a card nobody built yet is read.
      const state = await getCardState(cardId, roomCode, plugin);
      const active = plugin.callTileActive ? plugin.callTileActive(state) : true;
      if (!active) continue;
      let viewers: string[] = [];
      try {
        viewers = plugin.callTileViewers?.(state) ?? [];
      } catch {
        // A viewers hook must never take the tile down with it.
      }
      const activities: Record<string, string> = {};
      try {
        for (const [did, label] of Object.entries(plugin.callTileActivities?.(state) ?? {})) {
          const clean = cleanActivity(label);
          if (clean) activities[did] = clean;
        }
      } catch {
        // Same as viewers: a broken hook costs the labels, not the tile.
      }
      tiles.push({
        pluginId,
        cardId,
        roomCode,
        viewers,
        focusOnJoin: plugin.callTileFocusOnJoin !== false,
        activities,
      });
    }
    if (seq !== _seq || roomCode !== _callRoom) return;
    // Unchanged tiles keep their array: a new one re-ran everything that
    // reads it - the stage's tile list, the user list's activities - for
    // nothing, on every heartbeat.
    if (!sameTiles(callTilesState.tiles, tiles)) callTilesState.tiles = tiles;
  } catch (err) {
    console.warn("[plugins] call tile scan failed:", err);
  }
}

// All of it dies with the session: the watched rooms are room codes, and a
// stage unmounted when the lock came never got to say goodbye.
onIdentityLock(() => {
  clearTimeout(_debounce);
  _seq += 1;
  _unwatchCall = null;
  _callRoom = null;
  _watched.clear();
  _newestCards.clear();
  if (callTilesState.tiles.length) callTilesState.tiles = [];
});

function sameTiles(a: PluginCallTile[], b: PluginCallTile[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i];
    return (
      t.pluginId === u.pluginId &&
      t.cardId === u.cardId &&
      t.roomCode === u.roomCode &&
      t.focusOnJoin === u.focusOnJoin &&
      t.viewers.length === u.viewers.length &&
      t.viewers.every((v, j) => v === u.viewers[j]) &&
      JSON.stringify(t.activities ?? {}) === JSON.stringify(u.activities ?? {})
    );
  });
}
