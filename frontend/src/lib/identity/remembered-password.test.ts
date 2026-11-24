import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
const storage = vi.hoisted(() => ({ getWebAuthnRecord: vi.fn() }));
vi.mock("../storage", () => storage);
import { clearRememberedPassword, loadRememberedPassword, resetTimerOnLogin, saveRememberedPassword, setResetTimerOnLogin } from "./remembered-password";

beforeEach(async () => {
  storage.getWebAuthnRecord.mockResolvedValue(undefined);
  await clearRememberedPassword();
});
describe("remembered password cannot bypass biometric enrollment", () => {
  it("removes a legacy remembered password instead of returning it after enrollment", async () => {
    await saveRememberedPassword("secret-password", 15);
    expect(await loadRememberedPassword()).toBe("secret-password");
    storage.getWebAuthnRecord.mockResolvedValue({ id: "webauthn" });
    expect(await loadRememberedPassword()).toBeNull();
    storage.getWebAuthnRecord.mockResolvedValue(undefined);
    expect(await loadRememberedPassword()).toBeNull();
  });
  it("does not recreate remembered access when setup finishes after enrollment", async () => {
    storage.getWebAuthnRecord.mockResolvedValue({ id: "webauthn" });
    await saveRememberedPassword("secret-password", 15);
    storage.getWebAuthnRecord.mockResolvedValue(undefined);
    expect(await loadRememberedPassword()).toBeNull();
  });
});

describe("the timer that starts over on login", () => {
  it("is on unless turned off, and stays as chosen", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    expect(resetTimerOnLogin()).toBe(true);
    setResetTimerOnLogin(false);
    expect(resetTimerOnLogin()).toBe(false);
    setResetTimerOnLogin(true);
    expect(resetTimerOnLogin()).toBe(true);
    // What builds before this stored for a person who had turned it off.
    store.set("awful_remember_reset_timer", "false");
    expect(resetTimerOnLogin()).toBe(false);
    vi.unstubAllGlobals();
  });
});
