// The view side of history sync, lifted out of transport.svelte.ts so it can
// be tested: that module builds a libp2p node at import time.
//
// A repair push arrives as a burst of SyncBatch frames, twenty rows each, and
// the open conversation used to take every one of them the moment it landed:
// one array replacement, one re-sort, one derived chain and one autoscroll
// per frame, tens of times a second while a backlog poured in. Storage got
// the rows either way; what the screen needed was to hear about them ONCE.
//
// So rows headed for the view are parked here per room and handed over in one
// flush: after a short quiet gap, at a hard deadline if the frames never pause,
// or as soon as the pusher says it is done. A LIVE batch - the direct copy of
// a single send - never waits; the delay is only for history.
import type { Message } from "$lib/types/message";

/** Quiet gap between frames that counts as "the burst is over". */
export const SYNC_VIEW_SETTLE_MS = 250;
/**
 * Longest a row waits regardless. A push fast enough to never leave a
 * SETTLE gap still has to reach the screen at a readable cadence.
 */
export const SYNC_VIEW_MAX_WAIT_MS = 1_000;

export type SyncViewFlush = (roomCode: string, rows: Message[]) => void;

interface Pending {
  rows: Message[];
  ids: Set<string>;
  settle: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout>;
}

export interface SyncViewBuffer {
  /** Park rows for the room; a row already parked is not parked twice. */
  add(roomCode: string, rows: Message[]): void;
  /** Flush the room now - the pusher sent SyncComplete. */
  settle(roomCode: string): void;
  /** Forget the room's rows without flushing - the user left it. */
  drop(roomCode: string): void;
  /** Rows waiting for the room. */
  pending(roomCode: string): number;
}

export function createSyncViewBuffer(flush: SyncViewFlush): SyncViewBuffer {
  const pending = new Map<string, Pending>();

  function clear(p: Pending): void {
    if (p.settle) clearTimeout(p.settle);
    clearTimeout(p.deadline);
  }

  function fire(roomCode: string): void {
    const p = pending.get(roomCode);
    if (!p) return;
    clear(p);
    pending.delete(roomCode);
    if (p.rows.length) flush(roomCode, p.rows);
  }

  return {
    add(roomCode, rows) {
      if (!rows.length) return;
      let p = pending.get(roomCode);
      if (!p) {
        p = {
          rows: [],
          ids: new Set(),
          settle: null,
          deadline: setTimeout(() => fire(roomCode), SYNC_VIEW_MAX_WAIT_MS),
        };
        pending.set(roomCode, p);
      }
      // Two peers answering the same digest hand over the same rows, and
      // both copies can clear the storage dedupe before either is written.
      for (const m of rows) {
        if (p.ids.has(m.id)) continue;
        p.ids.add(m.id);
        p.rows.push(m);
      }
      if (p.settle) clearTimeout(p.settle);
      p.settle = setTimeout(() => fire(roomCode), SYNC_VIEW_SETTLE_MS);
    },
    settle: fire,
    drop(roomCode) {
      const p = pending.get(roomCode);
      if (!p) return;
      clear(p);
      pending.delete(roomCode);
    },
    pending: (roomCode) => pending.get(roomCode)?.rows.length ?? 0,
  };
}
