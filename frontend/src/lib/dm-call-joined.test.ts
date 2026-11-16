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

  it("keeps only the newest 200", async () => {
    const mod = await import("./dm-call-joined");
    for (let i = 0; i < 205; i++) mod.noteDmCallJoined(`call-${String(i).padStart(4, "0")}`);
    const stored = JSON.parse(backing.get("awful:dm-calls-joined:v1")!);
    expect(stored).toHaveLength(200);
    expect(mod.joinedDmCall("call-0000")).toBe(false);
    expect(mod.joinedDmCall("call-0204")).toBe(true);
  });
});
