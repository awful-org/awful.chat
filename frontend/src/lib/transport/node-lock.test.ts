import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two "tabs" are two instances of the module (vi.resetModules between the
 * imports), sharing one fake Lock Manager and one fake broadcast bus. The
 * fakes follow the Web Locks rules the module leans on: FIFO grant, a lock
 * held for as long as the callback's promise is pending, ifAvailable that
 * hands the callback null instead of queueing, steal that rejects the
 * holder's request with AbortError, and a signal that drops a queued
 * request the same way.
 */

type Entry = {
  cb: (lock: unknown) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });

class FakeLocks {
  holder: Entry | null = null;
  queue: Entry[] = [];

  request(_name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
      steal?: boolean;
      signal?: AbortSignal;
    };
    const cb = (typeof a === "function" ? a : b) as Entry["cb"];
    return new Promise((resolve, reject) => {
      const entry = { cb, resolve, reject };
      if (opts.steal) {
        const h = this.holder;
        this.holder = null;
        h?.reject(abort());
        this.grant(entry);
        return;
      }
      if (!this.holder) {
        this.grant(entry);
        return;
      }
      if (opts.ifAvailable) {
        Promise.resolve()
          .then(() => cb(null))
          .then(resolve, reject);
        return;
      }
      opts.signal?.addEventListener("abort", () => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(abort());
      });
      this.queue.push(entry);
    });
  }

  private grant(entry: Entry): void {
    this.holder = entry;
    const done = () => {
      if (this.holder !== entry) return;
      this.holder = null;
      const next = this.queue.shift();
      if (next) this.grant(next);
    };
    Promise.resolve()
      .then(() => entry.cb({ name: "awful:node", mode: "exclusive" }))
      .then(
        (v) => {
          done();
          entry.resolve(v);
        },
        (e) => {
          done();
          entry.reject(e);
        }
      );
  }
}

class FakeChannel {
  static all = new Set<FakeChannel>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  /** A frozen tab keeps its channel but never gets to read it. */
  frozen = false;
  constructor(public name: string) {
    FakeChannel.all.add(this);
  }
  postMessage(data: unknown): void {
    for (const c of FakeChannel.all) {
      if (c === this || c.frozen) continue;
      queueMicrotask(() => c.onmessage?.({ data }));
    }
  }
  close(): void {
    FakeChannel.all.delete(this);
  }
}

type Mod = typeof import("./node-lock");

const flush = () => new Promise((r) => setTimeout(r, 0));

let locks: FakeLocks;
let tabA: Mod;
let tabB: Mod;
const mkEvents = () => ({
  onWaiting: vi.fn<(waiting: boolean) => void>(),
  onRelease: vi.fn<() => void | Promise<void>>(),
});
let evA: ReturnType<typeof mkEvents>;
let evB: ReturnType<typeof mkEvents>;

describe("node lock", () => {
  beforeEach(async () => {
    locks = new FakeLocks();
    FakeChannel.all.clear();
    vi.stubGlobal("navigator", { locks });
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.resetModules();
    tabA = await import("./node-lock");
    vi.resetModules();
    tabB = await import("./node-lock");
    evA = mkEvents();
    evB = mkEvents();
  });

  afterEach(() => {
    tabA._resetNodeLockForTests();
    tabB._resetNodeLockForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("the first tab takes the seat at once", async () => {
    await tabA.acquireNodeLock(evA);
    expect(tabA.holdsNodeLock()).toBe(true);
    expect(evA.onWaiting).toHaveBeenCalledWith(false);
    expect(evA.onWaiting).not.toHaveBeenCalledWith(true);
  });

  it("a second tab waits, is told so, and gets the seat when the first goes", async () => {
    await tabA.acquireNodeLock(evA);
    let granted = false;
    const wait = tabB.acquireNodeLock(evB).then(() => {
      granted = true;
    });
    await flush();
    expect(evB.onWaiting).toHaveBeenCalledWith(true);
    expect(tabB.holdsNodeLock()).toBe(false);
    expect(granted).toBe(false);

    // The holder closes: the Lock Manager releases for it.
    tabA.releaseNodeLock();
    await wait;
    expect(tabB.holdsNodeLock()).toBe(true);
    expect(evB.onWaiting).toHaveBeenLastCalledWith(false);
  });

  it("a holder resolves again at once, a waiter joins its own wait", async () => {
    await tabA.acquireNodeLock(evA);
    await tabA.acquireNodeLock(evA);
    const first = tabB.acquireNodeLock(evB);
    const second = tabB.acquireNodeLock(evB);
    expect(second).toBe(first);
  });

  it("Use here asks the holder to step down and takes its place", async () => {
    await tabA.acquireNodeLock(evA);
    const wait = tabB.acquireNodeLock(evB);
    await flush();

    tabB.claimNodeLock();
    await flush();
    expect(evA.onRelease).toHaveBeenCalledTimes(1);
    expect(tabA.holdsNodeLock()).toBe(false);
    await wait;
    expect(tabB.holdsNodeLock()).toBe(true);
  });

  it("the tab that stepped down queues behind the asker", async () => {
    await tabA.acquireNodeLock(evA);
    // The holder's teardown asks for the seat back, the way connect() does.
    evA.onRelease.mockImplementation(() => {
      void tabA.acquireNodeLock(evA);
    });
    const wait = tabB.acquireNodeLock(evB);
    await flush();
    tabB.claimNodeLock();
    await wait;
    await flush();
    expect(tabB.holdsNodeLock()).toBe(true);
    expect(tabA.holdsNodeLock()).toBe(false);
    expect(evA.onWaiting).toHaveBeenLastCalledWith(true);

    // ...and comes back when the asker closes.
    tabB.releaseNodeLock();
    await flush();
    expect(tabA.holdsNodeLock()).toBe(true);
  });

  it("a frozen holder is stolen from after the grace period", async () => {
    vi.useFakeTimers();
    await tabA.acquireNodeLock(evA);
    const frozen = [...FakeChannel.all][0];
    frozen.frozen = true;
    const wait = tabB.acquireNodeLock(evB);
    await vi.advanceTimersByTimeAsync(0);

    tabB.claimNodeLock();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(tabB.holdsNodeLock()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await wait;
    expect(tabB.holdsNodeLock()).toBe(true);
    // The holder learns through its own request rejecting.
    expect(evA.onRelease).toHaveBeenCalledTimes(1);
    expect(tabA.holdsNodeLock()).toBe(false);

    // Its old queued request was dropped: releasing hands the seat to nobody
    // rather than straight back to itself.
    tabB.releaseNodeLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(tabB.holdsNodeLock()).toBe(false);
    expect(locks.holder).toBeNull();
  });

  it("behaves as before without a Lock Manager", async () => {
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const mod: Mod = await import("./node-lock");
    await mod.acquireNodeLock(evA);
    expect(mod.holdsNodeLock()).toBe(true);
    mod._resetNodeLockForTests();
  });
});
