import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKLET_URL } from "./worklet-url";

// The DTLN worklet is 8 MB (5 MB on the wire). It used to be fetched at
// module load of the transport, which every route evaluated: the landing
// page, the identity setup and the unlock screen all downloaded it for
// visitors who never called anyone.

// Anything else (TURN credentials, on connect) gets a quiet "nothing here".
const fetchSpy = vi.fn(async (url: RequestInfo | URL) =>
  String(url) === WORKLET_URL ? new Response("worklet") : new Response(null, { status: 204 })
);
const workletFetches = () => fetchSpy.mock.calls.filter(([url]) => String(url) === WORKLET_URL).length;

function prefs(saved: Record<string, unknown> | null): void {
  const backing = new Map<string, string>();
  if (saved) backing.set("awful_audio_prefs", JSON.stringify(saved));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  prefs(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("warmWorkletWhenIdle", () => {
  it("fetches the worklet once, in idle time, however often it is asked", async () => {
    const { warmWorkletWhenIdle } = await import("./worklet-warmup");
    warmWorkletWhenIdle();
    warmWorkletWhenIdle();
    expect(workletFetches()).toBe(0);
    await vi.runAllTimersAsync();
    expect(workletFetches()).toBe(1);
    warmWorkletWhenIdle();
    await vi.runAllTimersAsync();
    expect(workletFetches()).toBe(1);
  });

  it("leaves it alone with noise suppression off", async () => {
    prefs({ dtlnEnabled: false });
    const { warmWorkletWhenIdle } = await import("./worklet-warmup");
    warmWorkletWhenIdle();
    await vi.runAllTimersAsync();
    expect(workletFetches()).toBe(0);
  });

  it("leaves it alone when the browser asks to save data", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const { warmWorkletWhenIdle } = await import("./worklet-warmup");
    warmWorkletWhenIdle();
    await vi.runAllTimersAsync();
    expect(workletFetches()).toBe(0);
  });
});

describe("the transport module", () => {
  /** Stands in for the network classes so the module loads in node: every method is a no-op. */
  function inert() {
    return class {
      constructor() {
        return new Proxy(this, {
          get: (target, key) => (key in target || key === "then" ? Reflect.get(target, key) : () => {}),
        });
      }
    };
  }
  const heavy = {
    "$lib/transport/libp2p/transport": "LibP2PTransport",
    "$lib/transport/libp2p/voice": "LibP2PVoice",
    "$lib/transport/mediasoup": "MediasoupVideo",
    "$lib/transport/file/webtorrent": "WebTorrentFileTransport",
  };
  afterEach(() => {
    for (const path of Object.keys(heavy)) vi.doUnmock(path);
  });

  // The whole transport graph loads here, which takes a while on a busy run.
  it("fetches nothing on load: not on the landing page, the setup or the unlock screen", async () => {
    for (const [path, name] of Object.entries(heavy)) vi.doMock(path, () => ({ [name]: inert() }));
    await import("$lib/transport/transport.svelte");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workletFetches()).toBe(0);
  }, 30_000);

  it("asks for the warm-up when an unlocked session connects, not a locked page", async () => {
    for (const [path, name] of Object.entries(heavy)) vi.doMock(path, () => ({ [name]: inert() }));
    const identity = { identityStore: { isUnlocked: false } };
    const warm = vi.fn();
    vi.doMock("$lib/identity/identity.svelte", () => identity);
    vi.doMock("./worklet-warmup", () => ({ warmWorkletWhenIdle: warm }));
    try {
      const { connect } = await import("$lib/transport/transport.svelte");
      // A locked page restored from the back-forward cache reconnects too.
      void connect().catch(() => {});
      expect(warm).not.toHaveBeenCalled();
      identity.identityStore.isUnlocked = true;
      void connect().catch(() => {});
      expect(warm).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("$lib/identity/identity.svelte");
      vi.doUnmock("./worklet-warmup");
    }
  }, 30_000);
});
