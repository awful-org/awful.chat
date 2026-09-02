import { beforeEach, describe, expect, it } from "vitest";
import {
  setDuressPassword,
  clearDuressPassword,
  hasDuressPassword,
  isDuressPassword,
} from "./duress";
import { clearStorageCrypto, initStorageCrypto } from "./storage-crypto";

// Node has no localStorage; the module reads it defensively.
const store = new Map<string, string>();
beforeEach(async () => {
  store.clear();
  // The armed mark is keyed under the identity's index key, so the tests run
  // "unlocked" unless they say otherwise.
  await initStorageCrypto(new Uint8Array(32).fill(7));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("duress password", () => {
  it("matches only the exact password once set", async () => {
    expect(await hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("anything")).toBe(false);

    await setDuressPassword("wipe-me-1234");
    expect(await hasDuressPassword()).toBe(true);
    expect(await isDuressPassword("wipe-me-1234")).toBe(true);
    expect(await isDuressPassword("wipe-me-1235")).toBe(false);
    expect(await isDuressPassword("")).toBe(false);
  });

  it("stores only salt and hash - never the password", async () => {
    await setDuressPassword("hunter2duress");
    const raw = [...store.values()].join(" ");
    expect(raw).not.toContain("hunter2duress");
  });

  it("clear disarms it but leaves the record standing", async () => {
    await setDuressPassword("x-y-z-1");
    clearDuressPassword();
    expect(await hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("x-y-z-1")).toBe(false);
    // Removing the key would announce "this device never armed duress" as
    // loudly as its presence once announced the opposite.
    expect(store.has("awful:duress:v1")).toBe(true);
  });

  it("writes a record whether or not duress is armed, of the same shape", async () => {
    // Merely asking materializes it: a device that never opened the settings
    // must not be the one device with no such key.
    expect(await hasDuressPassword()).toBe(false);
    const decoy = JSON.parse(store.get("awful:duress:v1")!);
    expect(decoy.armed).toBeUndefined();
    expect(decoy.mark).toHaveLength(43);

    await setDuressPassword("wipe-me-1234");
    const real = JSON.parse(store.get("awful:duress:v1")!);

    // Same fields, same sizes: the mark is the only difference, and it is
    // opaque without the key. No password reaches the decoy's hash.
    expect(Object.keys(real).sort()).toEqual(Object.keys(decoy).sort());
    expect(real.iterations).toBe(decoy.iterations);
    expect(real.salt.length).toBe(decoy.salt.length);
    expect(real.hash.length).toBe(decoy.hash.length);
    expect(real.mark).toHaveLength(decoy.mark.length);
    expect(real.mark).not.toBe(decoy.mark);
  });

  it("without the session key an armed record reads as unarmed", async () => {
    await setDuressPassword("wipe-me-1234");
    clearStorageCrypto();
    // What a storage dump, or a coercer with devtools on a locked app, gets.
    expect(await hasDuressPassword()).toBe(false);
    // The wipe check itself never needed the key.
    expect(await isDuressPassword("wipe-me-1234")).toBe(true);
  });

  it("a corrupt record is treated as absent, not a crash", async () => {
    store.set("awful:duress:v1", "{not json");
    expect(await hasDuressPassword()).toBe(false);
    expect(await isDuressPassword("whatever")).toBe(false);
    // ...and replaced with a decoy rather than left as a tell of its own.
    expect(JSON.parse(store.get("awful:duress:v1")!).mark).toHaveLength(43);
  });

  it("a record from before the decoy existed still counts as armed", async () => {
    await setDuressPassword("legacy-pass-1");
    const rec = JSON.parse(store.get("awful:duress:v1")!);
    delete rec.armed;
    delete rec.mark;
    store.set("awful:duress:v1", JSON.stringify(rec));

    expect(await hasDuressPassword()).toBe(true);
    expect(await isDuressPassword("legacy-pass-1")).toBe(true);
    // ...and it now carries the opaque mark instead of the clear answer.
    const migrated = JSON.parse(store.get("awful:duress:v1")!);
    expect(migrated.mark).toHaveLength(43);
    expect(migrated.armed).toBeUndefined();
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
