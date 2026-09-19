// What the UI knows about a history push in flight, lifted out of
// transport.svelte.ts so it can be tested: that module builds a libp2p node
// at import time.
//
// A late joiner's backlog arrives as a run of SyncBatch frames and ends with
// SyncComplete, and until now nothing on screen said so: the room sat half
// empty, then filled, with no hint that it was still catching up. This is
// the one place that run is counted, per room, so the chat can draw a pill
// while it lasts.
import { SvelteMap } from "svelte/reactivity";

/**
 * A push whose frames stop without a SyncComplete - the peer dropped mid-way,
 * or the frame was lost - would otherwise hold the pill up for the session.
 * Comfortably above the gap between two honest frames on a slow relay.
 */
export const SYNC_STALL_MS = 20_000;

export interface RoomSyncProgress {
  /** Frames landed so far, across every peer pushing to this room. */
  batches: number;
  /** Frames announced, across the same peers. */
  total: number;
  /** Rows carried by those frames - before verification, so an upper bound. */
  messages: number;
}

/** Rooms with a push in flight, keyed by room code. Reactive: read from templates. */
export const syncProgress = new SvelteMap<string, RoomSyncProgress>();

interface PeerPush {
  batches: number;
  total: number;
  messages: number;
}

const _pushes = new Map<string, Map<string, PeerPush>>();
const _stall = new Map<string, ReturnType<typeof setTimeout>>();

function _publish(roomCode: string): void {
  const peers = _pushes.get(roomCode);
  if (!peers?.size) {
    _pushes.delete(roomCode);
    syncProgress.delete(roomCode);
    const t = _stall.get(roomCode);
    if (t) clearTimeout(t);
    _stall.delete(roomCode);
    return;
  }
  const sum: RoomSyncProgress = { batches: 0, total: 0, messages: 0 };
  for (const p of peers.values()) {
    sum.batches += Math.min(p.batches, p.total);
    sum.total += p.total;
    sum.messages += p.messages;
  }
  syncProgress.set(roomCode, sum);
}

function _armStall(roomCode: string): void {
  const prev = _stall.get(roomCode);
  if (prev) clearTimeout(prev);
  _stall.set(
    roomCode,
    setTimeout(() => {
      _pushes.delete(roomCode);
      _publish(roomCode);
    }, SYNC_STALL_MS)
  );
}

/**
 * A repair frame landed. batchIndex and totalBatches are peer-chosen; a
 * frame whose numbers do not describe a push is counted as nothing.
 */
export function noteSyncBatch(
  roomCode: string,
  peerId: string,
  batchIndex: number,
  totalBatches: number,
  messages: number
): void {
  if (
    !Number.isSafeInteger(batchIndex) ||
    !Number.isSafeInteger(totalBatches) ||
    batchIndex < 0 ||
    totalBatches < 1 ||
    batchIndex >= totalBatches
  ) {
    return;
  }
  let peers = _pushes.get(roomCode);
  if (!peers) {
    peers = new Map();
    _pushes.set(roomCode, peers);
  }
  const push = peers.get(peerId) ?? { batches: 0, total: 0, messages: 0 };
  // A pusher restarts at index 0 for its next push; the count only ever
  // reads as far along as the furthest frame seen, and the latest total wins.
  push.batches = Math.max(push.batches, batchIndex + 1);
  push.total = totalBatches;
  push.messages += Math.max(0, messages | 0);
  peers.set(peerId, push);
  _armStall(roomCode);
  _publish(roomCode);
}

/** The pusher is done with this room. */
export function noteSyncComplete(roomCode: string, peerId: string): void {
  const peers = _pushes.get(roomCode);
  if (!peers?.delete(peerId)) return;
  if (peers.size) _armStall(roomCode);
  _publish(roomCode);
}

/** Test seam. */
export function _resetSyncProgress(): void {
  for (const t of _stall.values()) clearTimeout(t);
  _stall.clear();
  _pushes.clear();
  syncProgress.clear();
}
