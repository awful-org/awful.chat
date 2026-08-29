import { beforeEach, describe, expect, it } from "vitest";
import {
  setDuressPassword,
  clearDuressPassword,
  hasDuressPassword,
  isDuressPassword,
} from "./duress";

// Node has no localStorage; the module reads it defensively.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("duress password", () => {
  it("matches only the exact password once set", async () => {
    expect(hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("anything")).toBe(false);

    await setDuressPassword("wipe-me-1234");
    expect(hasDuressPassword()).toBe(true);
    expect(await isDuressPassword("wipe-me-1234")).toBe(true);
    expect(await isDuressPassword("wipe-me-1235")).toBe(false);
    expect(await isDuressPassword("")).toBe(false);
  });

  it("stores only salt and hash - never the password", async () => {
    await setDuressPassword("hunter2duress");
    const raw = [...store.values()].join(" ");
    expect(raw).not.toContain("hunter2duress");
  });

  it("clear removes it", async () => {
    await setDuressPassword("x-y-z-1");
    clearDuressPassword();
    expect(hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("x-y-z-1")).toBe(false);
  });

  it("a corrupt record is treated as absent, not a crash", async () => {
    store.set("awful:duress:v1", "{not json");
    expect(hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("whatever")).toBe(false);
  });

  it("still rejects a near-miss password (constant-time compare doesn't break matching)", async () => {
    await setDuressPassword("wipe-me-1234");
    // One-character-off, one-byte-shorter, and empty - all should still miss.
    expect(await isDuressPassword("wipe-me-1235")).toBe(false);
    expect(await isDuressPassword("wipe-me-123")).toBe(false);
    expect(await isDuressPassword("")).toBe(false);
    // The real one still matches through the constant-time path.
    expect(await isDuressPassword("wipe-me-1234")).toBe(true);
  });
});
