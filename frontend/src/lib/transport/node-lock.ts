/**
 * One libp2p node per browser profile.
 *
 * The peerId comes from a per-profile seed (device-key.ts), so two tabs of
 * the same profile are two nodes with one peerId. The relay and every peer
 * keep one stream per peerId, so the two starve each other of pongs and
 * reconnect every ~125 s, taking every voice and file link down with them
 * (the 2026-09-04 and 2026-09-06 diag packs). The Web Locks API is scoped
 * to origin + profile, exactly the scope of the seed, so one named lock is
 * the seat: the holder runs the node, every other tab waits and is told so.
 *
 * A tab that closes or crashes releases on its own and the next in line
 * comes up without anyone doing anything. A waiting tab can also ask for
 * the seat ("Use here"): the holder tears its node down and releases. If
 * the holder cannot answer (frozen by the browser) the waiter takes the
 * seat outright after a grace period; the holder's request promise then
 * rejects, which is how it learns it lost the seat.
 *
 * Best effort, like the DM queue lock: a browser without the Lock Manager
 * behaves exactly as before.
 */

const LOCK_NAME = "awful:node";
const CHANNEL_NAME = "awful:node";
/** How long a takeover waits for the holder to step down before stealing. */
const STEAL_AFTER_MS = 5_000;

export interface NodeLockEvents {
  /** true while another tab has the seat and this one is queued for it. */
  onWaiting: (waiting: boolean) => void;
  /**
   * This tab must give the seat up: tear the node down. Called when a
   * waiter asked for it, or when one stole it. The lock is released once
   * the returned promise settles.
   */
  onRelease: () => void | Promise<void>;
}

let held = false;
let acquiring: Promise<void> | null = null;
let resolveAcquired: (() => void) | null = null;
/** Resolves the lock callback's promise, which is what releases the lock. */
let releaseHold: (() => void) | null = null;
/** Aborts our queued request, for when a steal made it redundant. */
let queuedAbort: AbortController | null = null;
let dropQueued = false;
let channel: BroadcastChannel | null = null;
let events: NodeLockEvents | null = null;

function supported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.locks;
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/** The lock callback: hold the seat until releaseNodeLock(). */
function grant(): Promise<void> {
  held = true;
  acquiring = null;
  resolveAcquired?.();
  resolveAcquired = null;
  events?.onWaiting(false);
  return new Promise<void>((r) => {
    releaseHold = r;
  });
}

/** Whether this tab currently holds the seat. */
export function holdsNodeLock(): boolean {
  return held;
}

/**
 * Wait for the seat. Resolves once this tab holds it - immediately when it is
 * free, and after the holder is gone when it is not. Safe to call again: a
 * holder resolves at once, a waiter joins its own wait.
 */
export function acquireNodeLock(ev: NodeLockEvents): Promise<void> {
  events = ev;
  if (held) return Promise.resolve();
  if (acquiring) return acquiring;
  if (!supported()) {
    held = true;
    return Promise.resolve();
  }
  listen();

  acquiring = new Promise<void>((resolve) => {
    resolveAcquired = resolve;
  });
  let queued = false;
  navigator.locks
    .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock) return grant();
      // Someone else has it. Say so, then wait our turn behind them.
      queued = true;
      ev.onWaiting(true);
      return undefined;
    })
    .then(() => {
      if (!queued) return;
      queued = false;
      queuedAbort = new AbortController();
      return navigator.locks.request(
        LOCK_NAME,
        { signal: queuedAbort.signal },
        () => grant()
      );
    })
    .catch((err: unknown) => {
      if (isAbort(err)) {
        // Our own queued request, dropped after a steal got us the seat.
        if (dropQueued) {
          dropQueued = false;
          return;
        }
        // Stolen from under us: the seat is already gone, tear down.
        if (held) {
          held = false;
          releaseHold = null;
          void ev.onRelease();
        }
        return;
      }
      // Lock Manager refused (opaque origin, storage blocked): behave as if
      // there were none, which is what every tab did before.
      held = true;
      acquiring = null;
      resolveAcquired?.();
      resolveAcquired = null;
      ev.onWaiting(false);
    });
  return acquiring;
}

/** Give the seat up. No-op when this tab does not hold it. */
export function releaseNodeLock(): void {
  held = false;
  releaseHold?.();
  releaseHold = null;
}

/**
 * Ask for the seat from a waiting tab. The holder steps down through
 * onRelease and the Lock Manager hands the seat to the next waiter.
 */
export function claimNodeLock(): void {
  if (held || !supported()) return;
  channel?.postMessage({ type: "release" });
  // A frozen holder never reads the channel. Its lock is real, though, so
  // after a grace period take it by force; the holder's own request rejects
  // with AbortError, and it tears down when it thaws.
  setTimeout(() => {
    if (held) return;
    void navigator.locks
      .request(LOCK_NAME, { steal: true }, (lock) => {
        if (!lock) return undefined;
        // The request we queued is behind this one now and would hand the
        // seat straight back to us on the next release. Drop it.
        if (queuedAbort) {
          dropQueued = true;
          queuedAbort.abort();
          queuedAbort = null;
        }
        return grant();
      })
      .catch((err: unknown) => {
        if (isAbort(err) && held) {
          held = false;
          releaseHold = null;
          void events?.onRelease();
        }
      });
  }, STEAL_AFTER_MS);
}

// ponytail: FIFO hands the seat to the oldest waiter, not necessarily the
// tab that clicked; with two waiters the click may light up the other one.
function listen(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent) => {
    if (e.data?.type !== "release" || !held || !events) return;
    // Not held from this instant: a connect() the teardown kicks off queues
    // behind the asker instead of short-circuiting on `held`.
    held = false;
    void Promise.resolve(events.onRelease()).finally(() => {
      releaseHold?.();
      releaseHold = null;
    });
  };
}

/** Test hook: forget every module-level piece of state. */
export function _resetNodeLockForTests(): void {
  releaseNodeLock();
  acquiring = null;
  resolveAcquired = null;
  queuedAbort = null;
  dropQueued = false;
  events = null;
  channel?.close();
  channel = null;
}
