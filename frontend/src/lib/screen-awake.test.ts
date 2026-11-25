import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Lock extends EventTarget {
  released = false;
  async release() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

let locks: Lock[];
let request: ReturnType<typeof vi.fn>;
let doc: EventTarget & { hidden: boolean };
const held = () => locks.filter((l) => !l.released).length;
const settle = () => new Promise((r) => setTimeout(r, 0));

async function load() {
  vi.resetModules();
  return (await import("./screen-awake")).keepScreenAwake;
}

beforeEach(() => {
  locks = [];
  request = vi.fn(async () => {
    const l = new Lock();
    locks.push(l);
    return l;
  });
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { wakeLock: { request } });
});
afterEach(() => void vi.unstubAllGlobals());

describe("keepScreenAwake", () => {
  it("holds one lock for everyone, until the last lets go", async () => {
    const keep = await load();
    const call = keep();
    const sync = keep();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    sync();
    sync();
    expect(held()).toBe(1);
    call();
    expect(held()).toBe(0);
  });

  it("takes it again when the page comes back, if it is still wanted", async () => {
    const keep = await load();
    const done = keep();
    await settle();
    await locks[0].release();
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(held()).toBe(0);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(held()).toBe(1);
    done();
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(held()).toBe(0);
  });

  it("does not keep one granted after it was let go", async () => {
    const keep = await load();
    keep()();
    await settle();
    expect(locks).toHaveLength(1);
    expect(held()).toBe(0);
    keep();
    await settle();
    expect(held()).toBe(1);
  });

  it("is nothing where it is refused or unknown", async () => {
    request.mockRejectedValueOnce(new Error("denied"));
    const keep = await load();
    keep()();
    await settle();
    vi.stubGlobal("navigator", {});
    (await load())()();
  });
});
