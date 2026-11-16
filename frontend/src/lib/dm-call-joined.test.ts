import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
};

describe("calls this device took part in", () => {
  beforeEach(() => {
    backing.clear();
    vi.resetModules();
  });

  it("remembers a call across a reload", async () => {
    (await import("./dm-call-joined")).noteDmCallJoined("abcdefgh");
    vi.resetModules();
    const reloaded = await import("./dm-call-joined");
    expect(reloaded.joinedDmCall("abcdefgh")).toBe(true);
    expect(reloaded.joinedDmCall("zzzzzzzz")).toBe(false);
  });

  it("takes in another device's list: a union on a merge, theirs on a replace", async () => {
    const mod = await import("./dm-call-joined");
    mod.noteDmCallJoined("here");
    mod.importDmCallsJoined(["there", "here", 42, ""], "add");
    expect(mod.dmCallsJoined()).toEqual(["there", "here"]);
    expect(JSON.parse(backing.get("awful:dm-calls-joined:v1")!)).toEqual(["there", "here"]);
    mod.importDmCallsJoined(["only-there"], "replace");
    expect(mod.joinedDmCall("here")).toBe(false);
    expect(mod.joinedDmCall("only-there")).toBe(true);
  });

  it("a merge past the bound keeps this device's own calls", async () => {
    const mod = await import("./dm-call-joined");
    for (let i = 0; i < 200; i++) mod.noteDmCallJoined(`here-${i}`);
    mod.importDmCallsJoined(Array.from({ length: 50 }, (_, i) => `there-${i}`), "add");
    expect(mod.dmCallsJoined()).toHaveLength(200);
    expect(mod.joinedDmCall("here-0")).toBe(true);
    expect(mod.joinedDmCall("there-0")).toBe(false);
  });

  it("keeps only the newest 200", async () => {
    const mod = await import("./dm-call-joined");
    for (let i = 0; i < 205; i++) mod.noteDmCallJoined(`call-${String(i).padStart(4, "0")}`);
    const stored = JSON.parse(backing.get("awful:dm-calls-joined:v1")!);
    expect(stored).toHaveLength(200);
    expect(mod.joinedDmCall("call-0000")).toBe(false);
    expect(mod.joinedDmCall("call-0204")).toBe(true);
  });
});
