/**
 * Waits that a hidden page does not slow down.
 *
 * A page left in the background gets its timers run once a minute, and
 * hosting a short code is a poll every second or two: the person joining
 * gives up before a poll that slow has answered them twice. A worker's
 * timers keep their pace, so the waiting is done there. With no worker to be
 * had, an ordinary timer.
 */
export interface WakeTimer {
  wait(ms: number): Promise<void>;
  close(): void;
}

export function createWakeTimer(): WakeTimer {
  let worker: Worker | null = null;
  let next = 0;
  const pending = new Map<number, { resolve: () => void; due: number }>();

  /** No worker after all: what it was timing is timed here. */
  const fallBack = () => {
    worker?.terminate();
    worker = null;
    for (const [id, { due }] of pending) setTimeout(done, Math.max(0, due - Date.now()), id);
  };
  const done = (id: number) => {
    const waiting = pending.get(id);
    pending.delete(id);
    waiting?.resolve();
  };
  try {
    worker = new Worker(new URL("./wake-timer-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<number>) => done(e.data);
    worker.onerror = fallBack;
  } catch {
    worker = null;
  }
  return {
    wait: (ms) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, { resolve, due: Date.now() + ms });
        if (worker) worker.postMessage({ id, ms });
        else setTimeout(done, ms, id);
      }),
    close() {
      worker?.terminate();
      worker = null;
      // Nobody is left waiting on a timer that will not fire.
      for (const id of [...pending.keys()]) done(id);
    },
  };
}
