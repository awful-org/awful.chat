import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, generateMnemonic, lockIdentity } from "./identity";
import { identityStore, init, lock, restore, unlock } from "./identity.svelte";
import { wipeLocalDatabase } from "../storage";

const PASSWORD = "correct horse battery staple";

describe("restoring an account from its phrase", () => {
  let mnemonic: string;
  beforeEach(async () => {
    await wipeLocalDatabase();
    lockIdentity();
    identityStore.isUnlocked = false;
    identityStore.justLoggedOut = false;
    ({ mnemonic } = await createIdentity(PASSWORD));
    lockIdentity();
    await init();
  });

  it("is left locked, for a reload, over another account this page had open", async () => {
    await unlock(PASSWORD);
    lock();
    expect(await restore(generateMnemonic(), PASSWORD)).toBe(true);
    expect(identityStore.isUnlocked).toBe(false);
    expect(identityStore.did).toBeNull();
  });

  it("is too after a password that did not unlock it", async () => {
    await unlock(PASSWORD);
    lock();
    identityStore.justLoggedOut = false; // As the unlock screen does on a try.
    await expect(unlock("wrong")).rejects.toThrow();
    expect(await restore(generateMnemonic(), PASSWORD)).toBe(true);
    expect(identityStore.isUnlocked).toBe(false);
  });

  it("unlocks the same account", async () => {
    await unlock(PASSWORD);
    lock();
    expect(await restore(mnemonic, PASSWORD)).toBe(false);
    expect(identityStore.isUnlocked).toBe(true);
  });

  it("unlocks another account where the last was never opened in this page", async () => {
    vi.resetModules(); // A page of its own.
    const { identityStore, init, restore } = await import("./identity.svelte");
    await init();
    expect(await restore(generateMnemonic(), PASSWORD)).toBe(false);
    expect(identityStore.isUnlocked).toBe(true);
  });
});
