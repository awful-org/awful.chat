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

// The subscribe and unsubscribe calls carry the mailbox's v2 proof, signed
// as themselves over the exact body - the endpoint included - so a captured
// one cannot be replayed as the other, or re-aimed at another endpoint.
it("signs subscribe and unsubscribe as themselves, over the endpoint", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
  const pub = ed25519.getPublicKey(new Uint8Array(32));
  const checkSigned = (init: RequestInit, action: string) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    const m = /^AwfulMailbox-v2 did:test (\d+) (\S+)$/.exec(auth);
    expect(m).not.toBeNull();
    const body = init.body as string;
    const signed = (a: string) => new TextEncoder().encode(
      `awful-mailbox:v2:${a}:relay.test:device-a:${m![1]}:${hex(sha256(new TextEncoder().encode(body)))}`);
    const sig = Uint8Array.from(atob(m![2]), (c) => c.charCodeAt(0));
    expect(ed25519.verify(sig, signed(action), pub)).toBe(true);
    const other = action === "push-subscribe" ? "push-unsubscribe" : "push-subscribe";
    expect(ed25519.verify(sig, signed(other), pub)).toBe(false);
    return JSON.parse(body);
  };

  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, publicKey: "test-key" }) })
    .mockResolvedValue({ ok: true });
  const push = await import("./push.svelte");
  expect(await push.ensurePushSubscription()).toBe(true);
  const sub = checkSigned(fetchMock.mock.calls[1][1], "push-subscribe");
  expect(sub).toMatchObject({
    device: "device-a",
    subscription: { endpoint: "https://push.test/device", keys: { p256dh: "key", auth: "auth" } },
  });
  expect(sub).not.toHaveProperty("sig");

  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => undefined } });
  await push.disablePush();
  const [url, init] = fetchMock.mock.calls[2];
  expect(url).toBe("https://relay.test/push/unsubscribe");
  expect(checkSigned(init, "push-unsubscribe")).toMatchObject({ device: "device-a" });
});
