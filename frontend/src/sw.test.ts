import { afterEach, expect, it, vi } from "vitest";

const { matchPrecache } = vi.hoisted(() => ({ matchPrecache: vi.fn() }));
vi.mock("workbox-core", () => ({ clientsClaim: vi.fn() }));
vi.mock("workbox-precaching", () => ({ precacheAndRoute: vi.fn(), matchPrecache }));
vi.mock("$lib/share-target", () => ({ storeSharedPayload: vi.fn() }));
vi.mock("$lib/notify-intents", () => ({ storeNotifyIntent: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it("keeps offline navigation on the installed shell without fetching a different build's HTML", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal("self", {
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    __WB_MANIFEST: [],
  });
  vi.stubGlobal("navigator", { onLine: true });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const cached = new Response('<script src="/assets/installed-build.js"></script>');
  matchPrecache.mockResolvedValue(cached);
  await import("./sw");
  let response!: Promise<Response>;
  listeners.get("fetch")!({
    request: { method: "GET", mode: "navigate", url: "https://chat.test/app" },
    respondWith: (value: Promise<Response>) => { response = value; },
    waitUntil: vi.fn(),
  });
  expect(await response).toBe(cached);
  expect(fetch).not.toHaveBeenCalled();
});
