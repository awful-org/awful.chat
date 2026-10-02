import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

/**
 * Fresh module per test: loadRuntimeConfig() is once-only by design, and the
 * cached value would otherwise leak between cases.
 */
async function load(fetchImpl: typeof fetch) {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchImpl);
  return await import("./runtime-config");
}

function respond(body: string, contentType = "application/json"): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

describe("loadRuntimeConfig", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("reads the served values", async () => {
    const m = await load(
      respond(
        JSON.stringify({
          apiUrl: " https://relay.example.com ",
          relayMultiaddr: "/dns4/relay.example.com/tcp/443/wss/p2p/12D3KooA",
          sfuUrls: ["wss://a.example/sfu", " wss://b.example/sfu "],
        })
      )
    );
    const cfg = await m.loadRuntimeConfig();
    expect(cfg.apiUrl).toBe("https://relay.example.com");
    expect(m.sfuUrls()).toEqual(["wss://a.example/sfu", "wss://b.example/sfu"]);
  });

  it("keeps an optional page off unless the flag plainly says yes", async () => {
    // The entrypoint writes a JSON boolean, but a hand-edited config.json (or
    // a VITE_ variable, which is always a string) writes "true". Both count;
    // anything else leaves the route off rather than half-on.
    for (const [raw, expected] of [
      [true, true],
      ["true", true],
      ["YES", true],
      ["1", true],
      [false, false],
      ["false", false],
      ["", false],
      ["maybe", false],
      [undefined, false],
    ] as const) {
      const m = await load(respond(JSON.stringify({ useQs: raw })));
      await m.loadRuntimeConfig();
      expect(m.useQs(), `useQs for ${JSON.stringify(raw)}`).toBe(expected);
      expect(m.useQc()).toBe(false); // absent stays off
    }
  });

  it("accepts the single-url form", async () => {
    const m = await load(respond(JSON.stringify({ sfuUrl: "wss://one/sfu" })));
    await m.loadRuntimeConfig();
    expect(m.sfuUrls()).toEqual(["wss://one/sfu"]);
  });

  // An SPA answers an unknown path with index.html and a 200, so a host with
  // no config.json hands back a whole HTML page. Parsed as configuration it
  // would blank every value and take the instance offline - which is worse
  // than having no config.json at all.
  it("does not mistake the SPA fallback page for configuration", async () => {
    for (const [body, type] of [
      ["<!doctype html><html><body>app</body></html>", "text/html"],
      ["<!DOCTYPE html>\n<html></html>", "application/json"],
    ]) {
      const m = await load(respond(body, type));
      m.setRuntimeConfig({ apiUrl: "https://kept.example" });
      const cfg = await m.loadRuntimeConfig();
      expect(cfg.apiUrl).toBe("https://kept.example");
    }
  });

  it("survives a missing file, a 404 and a network error", async () => {
    const notFound = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    for (const impl of [notFound, boom, respond("{ not json")]) {
      const m = await load(impl);
      await expect(m.loadRuntimeConfig()).resolves.toBeTruthy();
    }
  });

  // A failed load must not be remembered as an answer. Launching an
  // installed PWA while offline is a supported path (the service worker
  // serves the shell from cache), and the config fetch is the one request no
  // cache can answer - so a blip at launch would otherwise run the whole
  // session with no relay, silently, until somebody reloaded.
  it("retries after a failure instead of caching it", async () => {
    let attempt = 0;
    const flaky = (async () => {
      if (attempt++ === 0) throw new Error("offline");
      return new Response(JSON.stringify({ apiUrl: "https://back.example" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const m = await load(flaky);
    await m.loadRuntimeConfig();
    expect(m.isConfigured()).toBe(false);
    expect(m.apiUrl()).toBe("");
    await m.loadRuntimeConfig();
    expect(attempt).toBe(2);
    expect(m.isConfigured()).toBe(true);
    expect(m.apiUrl()).toBe("https://back.example");
  });

  it("fetches once, however many callers ask", async () => {
    const spy = vi.fn(
      async () =>
        new Response("{}", { headers: { "content-type": "application/json" } })
    );
    const m = await load(spy as unknown as typeof fetch);
    await Promise.all([m.loadRuntimeConfig(), m.loadRuntimeConfig()]);
    await m.loadRuntimeConfig();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/** A localStorage that outlives the module instances `load` makes, like a browser's. */
function storage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

/** A fetch that never answers: a stalled connection, lie-fi, a captive portal. */
const stalled = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

describe("a launch that has been configured before", () => {
  beforeEach(() => vi.unstubAllGlobals());

  // Every launch, the installed app included, used to wait a round trip for
  // /config.json before showing anything - and a stalled one blanked the
  // screen for four seconds, then ran with no relay at all.
  it("starts from the last good copy without waiting for the network", async () => {
    storage();
    const first = await load(respond(JSON.stringify({ apiUrl: "https://relay.example" })));
    await first.loadRuntimeConfig();

    const m = await load(stalled);
    const cfg = await Promise.race([
      m.loadRuntimeConfig(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(cfg?.apiUrl).toBe("https://relay.example");
    expect(m.apiUrl()).toBe("https://relay.example");
    expect(m.isConfigured()).toBe(true);
  });

  it("refreshes in the background and uses what the instance serves now", async () => {
    storage();
    const first = await load(respond(JSON.stringify({ apiUrl: "https://old.example" })));
    await first.loadRuntimeConfig();

    let answer!: (r: Response) => void;
    const later = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const m = await load(later);
    await m.loadRuntimeConfig();
    expect(m.apiUrl()).toBe("https://old.example");
    answer(new Response(JSON.stringify({ apiUrl: "https://new.example" }), {
      headers: { "content-type": "application/json" },
    }));
    await vi.waitFor(() => expect(m.apiUrl()).toBe("https://new.example"));
    expect((await m.loadRuntimeConfig()).apiUrl).toBe("https://new.example");

    // And the next launch starts from the new one.
    const next = await load(stalled);
    expect((await next.loadRuntimeConfig()).apiUrl).toBe("https://new.example");
  });

  it("keeps the last good copy when the refresh fails or the file is gone", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    for (const impl of [notFound, offline, respond("<!doctype html><html></html>", "text/html")]) {
      storage();
      const first = await load(respond(JSON.stringify({ relayMultiaddr: "/dns4/r.example/tcp/443/wss/p2p/12D3KooA" })));
      await first.loadRuntimeConfig();
      const m = await load(impl);
      await m.loadRuntimeConfig();
      await new Promise((r) => setTimeout(r, 0));
      expect(m.relayMultiaddr()).toBe("/dns4/r.example/tcp/443/wss/p2p/12D3KooA");
      expect(m.isConfigured()).toBe(true);
    }
  });

  it("ignores a damaged copy and waits for the network, as a first launch does", async () => {
    const saved = storage();
    const first = await load(respond(JSON.stringify({ apiUrl: "https://relay.example" })));
    await first.loadRuntimeConfig();
    for (const key of saved.keys()) saved.set(key, "{ not json");
    const m = await load(respond(JSON.stringify({ apiUrl: "https://fresh.example" })));
    expect((await m.loadRuntimeConfig()).apiUrl).toBe("https://fresh.example");
  });
});

describe("a first launch whose load failed", () => {
  /** window and document as event targets, so retries can be fired. */
  function page() {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    return { win, doc };
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** Offline for the first `failures` attempts, then the served file. */
  function flaky(failures: number) {
    const calls = { count: 0 };
    const impl = (async () => {
      if (calls.count++ < failures) throw new Error("offline");
      return new Response(JSON.stringify({ apiUrl: "https://back.example" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  // Lie-fi and a captive portal never fire "online", and an installed app
  // has no reload button: the session ran with no relay until force-closed.
  it("tries again on a timer, not only when the browser says it is online", async () => {
    page();
    const { calls, impl } = flaky(2);
    const m = await load(impl);
    await m.loadRuntimeConfig();
    expect(m.isConfigured()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.count).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.count).toBe(3);
    expect(m.isConfigured()).toBe(true);
    expect(m.apiUrl()).toBe("https://back.example");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.count).toBe(3);
  });

  it("tries again when the page is shown again", async () => {
    const { doc } = page();
    const { calls, impl } = flaky(1);
    const m = await load(impl);
    await m.loadRuntimeConfig();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.count).toBe(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.count).toBe(2);
    expect(m.isConfigured()).toBe(true);
  });

  it("tries once per failure, whichever reason comes first", async () => {
    const { win, doc } = page();
    const { calls, impl } = flaky(1);
    const m = await load(impl);
    await m.loadRuntimeConfig();
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.count).toBe(2);
    expect(m.isConfigured()).toBe(true);
  });

  // A file that is not there is an operator's to fix, not a blip: asking
  // again every few seconds, or at every glance at the tab, would only fill
  // the console - `pnpm dev`, which serves no config.json, included.
  it("asks again for a file that is not there only when back online", async () => {
    for (const missing of [
      async () => new Response("", { status: 404 }),
      async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }),
    ]) {
      const { win, doc } = page();
      const spy = vi.fn(missing);
      const m = await load(spy as unknown as typeof fetch);
      await m.loadRuntimeConfig();
      await vi.advanceTimersByTimeAsync(300_000);
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
      win.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(2);
    }
  });
});
