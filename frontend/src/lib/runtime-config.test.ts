import { describe, expect, it, vi, beforeEach } from "vitest";

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
