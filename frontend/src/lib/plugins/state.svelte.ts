/**
 * Plugin card state store with reducer replay.
 * State materializes deterministically from persisted updates in fold order.
 */

import type { Message } from "$lib/transport/transport.svelte";
import type { PluginDefinition, UpdateCtx } from "./api";
import { MessageType, type ChatMessageType } from "$lib/types/message";
import { getMessagesOfTypes } from "$lib/storage";

export interface CardStateEntry {
  state: unknown;
  /** The room this state was built FOR. Updates arriving from any other
   *  room are refused: a cardId in the payload is peer-supplied, and
   *  without this check a member of room X could fold forged data into a
   *  card living in room Y just by naming its id. */
  roomCode: string;
  /** The plugin that OWNS the card, read from the card row's payload. The
   *  reducer for a live update is resolved from the UPDATE's pluginId, which
   *  is peer-supplied: without this, plugin A's payload reached A's reducer
   *  holding a state object plugin B had built, and every reducer in the
   *  registry became a type-confusion gadget for any room member. Only the
   *  owning plugin's updates fold, live and on replay. */
  pluginId: string;
  /** Fold-order key of the newest PERSISTED update included, null when the
   *  state was built before any update existed. Ephemerals never count: they
   *  are unordered by design (lamport 0) and live outside storage. */
  last: { lamport: number; senderId: string; id: string } | null;
}

// Card state cache: cardId -> cached state
// Note: This is a regular Map, not $state, for testability.
// Reactivity is handled through component re-renders when state changes.
export const cardStates = new Map<string, CardStateEntry>();

// Change notification WITHOUT runes: this module is imported by node-run
// tests that have no Svelte compiler, which is why cardStates is a plain
// Map. Components subscribe a callback; MsgRender bridges it into its own
// $state. Without this, a card rendered once and live votes never appeared.
const _subscribers = new Set<() => void>();
export function onCardStateChange(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}
function bumpTick(): void {
  for (const cb of _subscribers) cb();
}

/** Re-render cards after a locally-sent update that had no cached entry. */
export function touchCardStates(): void {
  bumpTick();
}

/** Drop one card's cached state so the next render rebuilds from storage. */
export function evictCardState(cardId: string): void {
  cardStates.delete(cardId);
}

/** Cards whose live fold arrived while their initial build was still reading
 *  storage - getCardState re-reads for these before caching. */
const _missedFold = new Set<string>();

/**
 * Comparator for deterministic update ordering: lamport, then senderId, then id.
 * This is MSG_ORDER extended with id as tiebreaker for DM rooms.
 */
export function foldComparator(
  a: { lamport: number; senderId: string; id: string },
  b: { lamport: number; senderId: string; id: string }
): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  const senderCmp = a.senderId.localeCompare(b.senderId);
  if (senderCmp !== 0) return senderCmp;
  return a.id.localeCompare(b.id);
}

/**
 * Rebuild state for a plugin card from stored updates.
 * Called on first render of a card, queries storage for all PluginUpdate
 * messages referencing the cardId, folds through the reducer.
 */
export async function buildCardState(
  cardId: string,
  roomCode: string,
  definition: PluginDefinition
): Promise<CardStateEntry> {
  // The card's own payload seeds the state (a poll's question and options
  // live there); updates only ever mutate it. Plugin rows ONLY: pulling
  // this via getAllMessages decrypted the room's entire history - every
  // text and file message - to rebuild one card, on every cache miss.
  const allMessages = await getMessagesOfTypes(roomCode, [
    MessageType.PluginCard,
    MessageType.PluginUpdate,
  ]);
  let cardData: unknown = undefined;
  // The card row names the only plugin allowed to write this state. It is
  // also what the render path resolved `definition` from, so falling back to
  // the definition when the row is missing or malformed keeps a card that is
  // rendering (from an in-memory row) foldable rather than inert.
  let ownerPluginId = definition.manifest.id;
  const cardMsg = allMessages.find((m) => m.id === cardId);
  if (cardMsg) {
    try {
      const cardPayload = JSON.parse(cardMsg.content);
      cardData = cardPayload.data;
      if (typeof cardPayload.pluginId === "string")
        ownerPluginId = cardPayload.pluginId;
    } catch {
      // Malformed card: state starts unseeded and the card renders empty.
    }
  }

  if (!definition.reduce || !definition.initialState) {
    return {
      state: definition.initialState
        ? definition.initialState(cardData)
        : undefined,
      roomCode,
      pluginId: ownerPluginId,
      last: null,
    };
  }

  let state = definition.initialState(cardData);

  // Filter for PluginUpdate messages for this cardId. The pluginId has to
  // match the card's too: the live path picks the reducer from the update's
  // own pluginId, so replaying on cardId alone made storage and the live
  // fold disagree about which plugin owns the card - and let a foreign
  // plugin's payload through this card's reducer on every rebuild.
  const updates = allMessages.filter((msg) => {
    if (msg.type !== MessageType.PluginUpdate) return false;
    try {
      const payload = JSON.parse(msg.content);
      return payload.cardId === cardId && payload.pluginId === ownerPluginId;
    } catch {
      return false;
    }
  });

  // Sort by fold order (lamport, senderId, id)
  updates.sort(foldComparator);

  // Fold through reducer
  for (const msg of updates) {
    try {
      const payload = JSON.parse(msg.content);
      const ctx: UpdateCtx = {
        senderDid: msg.senderDid || msg.senderId,
        senderName: msg.senderName,
        updateId: msg.id,
        lamport: msg.lamport,
        ephemeral: false,
      };
      state = definition.reduce(state, { data: payload.data }, ctx);
    } catch (err) {
      console.warn(`[plugins] failed to fold update ${msg.id}:`, err);
    }
  }

  const newest = updates[updates.length - 1];
  return {
    state,
    roomCode,
    pluginId: ownerPluginId,
    last: newest
      ? { lamport: newest.lamport, senderId: newest.senderId, id: newest.id }
      : null,
  };
}

/**
 * Fold a single update into cached state (incremental).
 * Called for live updates that arrive after the initial state build.
 */
export function foldUpdate(
  cardId: string,
  definition: PluginDefinition,
  update: {
    id: string;
    senderId: string;
    senderDid?: string;
    senderName: string;
    lamport: number;
    data: unknown;
    ephemeral?: boolean;
    /** The AUTHENTICATED room the update arrived on (pubsub topic, never
     *  the payload). A mismatch with the entry's room is a forgery or a
     *  misroute and the fold is refused. */
    roomCode: string;
  }
): unknown {
  if (!definition.reduce) {
    const entry = cardStates.get(cardId);
    return entry?.state;
  }

  const entry = cardStates.get(cardId);
  if (entry && entry.roomCode !== update.roomCode) {
    console.warn(
      `[plugins] refused cross-room update for card ${cardId} ` +
        `(arrived on ${update.roomCode}, card lives in ${entry.roomCode})`
    );
    return undefined;
  }
  if (!entry) {
    // A build for this card may be mid-flight, reading storage from BEFORE
    // this update was put - dropping the fold here would freeze the card on
    // a stale state (a spin lost this way never lands). Flag it so
    // getCardState rebuilds once more after the read; persisted updates only,
    // an ephemeral is not in storage and cannot be recovered by a rebuild.
    // Only while a build is actually running: with no build in flight there
    // is nothing to catch up with (the update was put before this call, so
    // the next build reads it anyway), and without the gate a peer naming
    // cardIds nobody is rendering grew this set without bound.
    if (!update.ephemeral && _building.has(cardId)) _missedFold.add(cardId);
    return undefined;
  }

  // The reducer about to run belongs to the update's pluginId, but the state
  // it is handed was built by the card's. Refuse the mismatch: a room member
  // can put any pluginId in an update payload, and folding one plugin's data
  // through another's reducer is a type confusion the reducers cannot see.
  if (definition.manifest.id !== entry.pluginId) {
    console.warn(
      `[plugins] refused update from ${definition.manifest.id} for card ` +
        `${cardId}, which belongs to ${entry.pluginId}`
    );
    return undefined;
  }

  // Fold order is global (lamport, senderId, id), but live updates arrive in
  // NETWORK order. Two concurrent spins meant each client folded its own
  // first and rejected the other's as "already spun" - a different winner on
  // every screen until a refresh replayed storage in the right order. When an
  // update sorts BEFORE one already folded, do that replay now: the message
  // is in storage by the time every caller reaches this, so evicting makes
  // the next render rebuild deterministically. Ephemerals are exempt - they
  // are unordered (lamport 0) and never stored, so there is nothing to replay.
  if (!update.ephemeral && entry.last && foldComparator(update, entry.last) < 0) {
    cardStates.delete(cardId);
    bumpTick();
    return undefined;
  }

  const ctx: UpdateCtx = {
    senderDid: update.senderDid || update.senderId,
    senderName: update.senderName,
    updateId: update.id,
    lamport: update.lamport,
    ephemeral: update.ephemeral ?? false,
  };

  try {
    const next = definition.reduce(entry.state, { data: update.data }, ctx);
    // Reducers deliberately return the SAME reference for no-ops; a tick for
    // one re-rendered every mounted plugin surface in the app for nothing.
    const changed = next !== entry.state;
    entry.state = next;
    if (changed) bumpTick();
    if (!update.ephemeral) {
      entry.last = {
        lamport: update.lamport,
        senderId: update.senderId,
        id: update.id,
      };
    }
  } catch (err) {
    console.warn(`[plugins] failed to fold update ${update.id}:`, err);
  }

  return entry.state;
}

/**
 * Initialize or retrieve cached state for a card.
 * Returns cached state if available, otherwise builds it from storage.
 */
/** In-flight builds, so N mounted views of one card (chat card + pinned
 *  widget + call tile) share a single storage read instead of each paying
 *  a full rebuild after every eviction. */
const _building = new Map<string, Promise<unknown>>();

export async function getCardState(
  cardId: string,
  roomCode: string,
  definition: PluginDefinition
): Promise<unknown> {
  const entry = cardStates.get(cardId);
  if (entry) return entry.state;
  const inflight = _building.get(cardId);
  if (inflight) return inflight;

  const build = (async () => {
    _missedFold.delete(cardId); // a flag from a previous (evicted) life is stale
    let built = await buildCardState(cardId, roomCode, definition);
    // An update folded while we were reading storage found no entry and was
    // dropped - but its putMessage preceded the fold, so a fresh read sees it.
    // Re-read up to MAX_REBUILD_RETRIES times. Bail out if updates keep landing
    // faster than the read completes - that state is stale and must not be installed.
    const MAX_REBUILD_RETRIES = 2;
    for (let retry = 0; retry < MAX_REBUILD_RETRIES && _missedFold.has(cardId); retry++) {
      _missedFold.delete(cardId);
      built = await buildCardState(cardId, roomCode, definition);
    }
    // If still flagged after retries, updates are arriving faster than the read.
    // The built state is known to be stale - installing it would diverge permanently
    // from storage until an eviction replayed it. Instead, skip installation and let
    // the next fold attempt trigger another build once updates stabilize.
    if (_missedFold.has(cardId)) {
      _missedFold.delete(cardId);
      // A concurrent build may have already installed an entry while we were reading;
      // return that if it exists.
      const existing = cardStates.get(cardId);
      return existing?.state;
    }
    // No longer flagged after retries: built state matches storage. A concurrent
    // getCardState may have set the entry first; live folds have been applying to
    // THAT object, so ours must not clobber it.
    const existing = cardStates.get(cardId);
    if (existing) return existing.state;
    cardStates.set(cardId, built);
    bumpTick();
    return built.state;
  })();
  _building.set(cardId, build);
  try {
    return await build;
  } finally {
    _building.delete(cardId);
  }
}

/**
 * Clear cached card states. With a roomCode, only that room's entries go -
 * a room SWITCH must not wipe the state of pinned widgets and call tiles
 * following cards in other rooms (their ephemerals dropped unrecoverably in
 * the gap). Without one (disconnect), everything goes.
 */
export function clearCardStates(roomCode?: string): void {
  if (roomCode === undefined) {
    cardStates.clear();
    return;
  }
  for (const [cardId, entry] of cardStates) {
    if (entry.roomCode === roomCode) cardStates.delete(cardId);
  }
}
