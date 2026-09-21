import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("$lib/identity/identity", () => ({
  isUnlocked: () => true,
  requireSession: () => ({ did: "did:test", privateKey: new Uint8Array(32) }),
}));
vi.mock("$lib/runtime-config", () => ({ apiUrl: () => "https://relay.test" }));
vi.mock("$lib/transport/transport.svelte", () => ({ peerId: () => "device-a" }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  const storage = new Map([["awful:push-key:v1", "test-key"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", { PushManager: {}, addEventListener: vi.fn() });
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("navigator", { serviceWorker: {
    getRegistration: async () => ({ pushManager: {
      getSubscription: async () => ({ toJSON: () => ({
        endpoint: "https://push.test/device", keys: { p256dh: "key", auth: "auth" },
      }) }),
    } }),
  } });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

it("retries push configuration after an offline attempt in the same session", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, publicKey: "test-key" }) })
    .mockResolvedValueOnce({ ok: true });
  const push = await import("./push.svelte");
  expect(await push.ensurePushSubscription()).toBe(false);
  expect(await push.ensurePushSubscription()).toBe(true);
  expect(push.pushState.status).toBe("subscribed");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("restores subscribed UI after permission recovery without reposting the same endpoint", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, publicKey: "test-key" }) })
    .mockResolvedValueOnce({ ok: true });
  const push = await import("./push.svelte");
  expect(await push.ensurePushSubscription()).toBe(true);
  vi.stubGlobal("Notification", { permission: "denied" });
  expect(await push.ensurePushSubscription()).toBe(false);
  expect(push.pushState.reason).toBe("permission");
  vi.stubGlobal("Notification", { permission: "granted" });
  expect(await push.ensurePushSubscription()).toBe(true);
  expect(push.pushState).toEqual({ status: "subscribed", reason: null });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
