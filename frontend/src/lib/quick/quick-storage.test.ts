import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep is the part worth pinning: it deletes databases by name pattern.
 * Getting "is anyone using this one" wrong means either a quick page losing
 * its call mid-sentence, or a leftover database surviving the promise that
 * nothing does.
 */

/** A Lock Manager with the two behaviours this module leans on. */
class FakeLocks {
  held = new Set<string>();
  release = new Map<string, () => void>();

  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
    };
    const cb = (typeof a === "function" ? a : b) as (
      lock: unknown
    ) => unknown | Promise<unknown>;
    if (opts.ifAvailable) {
      // Held by someone else means the callback gets null, not a queue.
      return Promise.resolve(cb(this.held.has(name) ? null : { name }));
    }
    this.held.add(name);
    return Promise.resolve(cb({ name })).then((p) => {
      // A held lock's callback returns a promise that stays pending; record
      // how to settle it so a test can simulate the page going away.
      if (p instanceof Promise) return p;
      this.held.delete(name);
      return p;
    });
  }
}

let locks: FakeLocks;
let deleted: string[];
let existing: string[];

function installGlobals() {
  locks = new FakeLocks();
  deleted = [];
  existing = [];
  vi.stubGlobal("navigator", { locks });
  vi.stubGlobal("indexedDB", {
    databases: async () => existing.map((name) => ({ name })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      existing = existing.filter((n) => n !== name);
      const req: Record<string, unknown> = {};
      queueMicrotask(() => (req.onsuccess as () => void)?.());
      return req;
    },
  });
}

async function load() {
  vi.resetModules();
  installGlobals();
  return import("./quick-storage");
}

describe("quick storage", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("uses the real database until it is told otherwise", async () => {
    const m = await load();
    expect(m.dbName()).toBe("awful-chat");
    expect(m.isQuickStorage()).toBe(false);
  });

  it("switches to a throwaway name, once", async () => {
    const m = await load();
    const name = m.useQuickStorage();
    expect(name).toMatch(/^awful-quick-[0-9a-f]{16}$/);
    expect(m.dbName()).toBe(name);
    expect(m.isQuickStorage()).toBe(true);
    expect(m.useQuickStorage()).toBe(name); // idempotent
  });

  it("deletes its own database and opens an empty one in its place", async () => {
    const m = await load();
    const name = m.useQuickStorage();
    await m.dropQuickStorage();
    expect(deleted).toEqual([name]);
    // NEVER back to the real database. A page that has been quick stays
    // quick: anything still in flight after a hang-up - a participant
    // removal, a stray sync - has to land somewhere disposable rather than in
    // the user's own data.
    expect(m.isQuickStorage()).toBe(true);
    expect(m.dbName()).not.toBe("awful-chat");
    expect(m.dbName()).toMatch(/^awful-quick-[0-9a-f]{16}$/);
    expect(m.dbName()).not.toBe(name);
  });

  it("the scope it rotates to is not a database until something writes", async () => {
    const m = await load();
    m.useQuickStorage();
    await m.dropQuickStorage();
    // Nothing opened the new name, so there is nothing of it to find.
    existing = [];
    await m.sweepOrphanQuickStorage();
    expect(deleted.length).toBe(1);
  });

  it("sweeps a database whose page is gone", async () => {
    const m = await load();
    existing = ["awful-chat", "awful-quick-dead0000dead0000", "awful-auth"];
    await m.sweepOrphanQuickStorage();
    expect(deleted).toEqual(["awful-quick-dead0000dead0000"]);
  });

  it("leaves a database another quick page is still holding", async () => {
    const m = await load();
    locks.held.add("awful-quick-alive000alive000");
    existing = ["awful-quick-alive000alive000", "awful-quick-dead0000dead0000"];
    await m.sweepOrphanQuickStorage();
    expect(deleted).toEqual(["awful-quick-dead0000dead0000"]);
  });

  it("never sweeps its own", async () => {
    const m = await load();
    const mine = m.useQuickStorage();
    existing = [mine];
    await m.sweepOrphanQuickStorage();
    expect(deleted).toEqual([]);
  });

  it("does nothing where databases() does not exist", async () => {
    const m = await load();
    vi.stubGlobal("indexedDB", { deleteDatabase: () => ({}) });
    existing = ["awful-quick-dead0000dead0000"];
    await expect(m.sweepOrphanQuickStorage()).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });
});
