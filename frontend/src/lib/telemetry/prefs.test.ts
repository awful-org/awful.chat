import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as PrefsModule from "./prefs.svelte";

// Node has no localStorage and no window; the module reads both defensively.
// Both stubs must exist BEFORE the import, because the `$state` initializer
// reads storage and the cross-tab listener registers at import time.
const store = new Map<string, string>();
let storageHandler: ((e: { key: string; newValue: string | null }) => void) | null =
  null;

beforeEach(() => {
  store.clear();
  storageHandler = null;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (
      type: string,
      handler: (e: { key: string; newValue: string | null }) => void
    ) => {
      if (type === "storage") storageHandler = handler;
    },
  };
});

async function freshModule(): Promise<typeof PrefsModule> {
  // A new module registry per test, so the `$state` initializer re-reads the
  // stub above rather than a value cached by an earlier test.
  vi.resetModules();
  return import("./prefs.svelte");
}

describe("diagPrefs", () => {
  it("defaults both exits to off, so a fresh install discloses nothing", async () => {
    // The recorder is always on in memory. These two gate disk and network.
    const { diagPrefs } = await freshModule();
    expect(diagPrefs.persist).toBe(false);
    expect(diagPrefs.upload).toBe(false);
  });

  it("reads a stored choice", async () => {
    store.set("awful:diag-persist:v1", "1");
    store.set("awful:diag-upload:v1", "1");
    const { diagPrefs } = await freshModule();
    expect(diagPrefs.persist).toBe(true);
    expect(diagPrefs.upload).toBe(true);
  });

  it("persists each setter under its own key", async () => {
    const { diagPrefs, setDiagPersist, setDiagUpload } = await freshModule();
    setDiagPersist(true);
    expect(diagPrefs.persist).toBe(true);
    expect(store.get("awful:diag-persist:v1")).toBe("1");
    setDiagUpload(true);
    expect(store.get("awful:diag-upload:v1")).toBe("1");
    setDiagPersist(false);
    expect(store.get("awful:diag-persist:v1")).toBe("0");
  });

  it("survives blocked storage", async () => {
    const { setDiagPersist, diagPrefs } = await freshModule();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => setDiagPersist(true)).not.toThrow();
    expect(diagPrefs.persist).toBe(true);
  });

  it("follows both keys across tabs", async () => {
    const { diagPrefs } = await freshModule();
    expect(storageHandler).not.toBeNull();
    storageHandler?.({ key: "awful:diag-persist:v1", newValue: "1" });
    storageHandler?.({ key: "awful:diag-upload:v1", newValue: "1" });
    expect(diagPrefs.persist).toBe(true);
    expect(diagPrefs.upload).toBe(true);
    storageHandler?.({ key: "awful:diag-upload:v1", newValue: null });
    expect(diagPrefs.upload).toBe(false);
    expect(diagPrefs.persist).toBe(true);
  });

  it("ignores an unrelated key", async () => {
    const { diagPrefs } = await freshModule();
    storageHandler?.({ key: "awful:italic-own-name:v1", newValue: "1" });
    expect(diagPrefs.persist).toBe(false);
    expect(diagPrefs.upload).toBe(false);
  });
});
