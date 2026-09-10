import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one thing that must not break: visiting /qs and coming back must leave
 * the landing page's own title and description exactly as index.html wrote
 * them. A route that "restores" the wrong values is worse than one that never
 * touched them, because the landing page is the page that actually ranks.
 *
 * A hand-rolled head rather than jsdom, which this repo does not carry and
 * which is not worth a dependency for six attributes. The cost is that the
 * fake is keyed by the exact selector strings the module uses, so a change to
 * one has to be made in both places - the assertions below would fail loudly
 * rather than silently pass, which is the tradeoff worth having.
 */

class FakeEl {
  attrs = new Map<string, string>();
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
}

let els: Map<string, FakeEl>;

function buildHead(): void {
  els = new Map();
  const put = (sel: string, attr: string, value: string) => {
    const el = new FakeEl();
    el.setAttribute(attr, value);
    els.set(sel, el);
  };
  put('meta[name="description"]', "content", "Landing description.");
  put('meta[property="og:title"]', "content", "Awful.chat");
  put('meta[property="og:description"]', "content", "Landing description.");
  put('meta[property="og:url"]', "content", "https://awful.chat");
  put('meta[name="twitter:title"]', "content", "Awful.chat");
  put('meta[name="twitter:description"]', "content", "Landing description.");
  put('link[rel="canonical"]', "href", "https://awful.chat");

  vi.stubGlobal("document", {
    title: "Awful.chat - private peer-to-peer chat",
    head: { querySelector: (sel: string) => els.get(sel) ?? null },
  });
  vi.stubGlobal("window", { location: { origin: "https://example.test" } });
}

function head() {
  const get = (sel: string, attr: string) => els.get(sel)?.getAttribute(attr) ?? null;
  return {
    title: (globalThis as unknown as { document: { title: string } }).document.title,
    description: get('meta[name="description"]', "content"),
    canonical: get('link[rel="canonical"]', "href"),
    ogUrl: get('meta[property="og:url"]', "content"),
    ogTitle: get('meta[property="og:title"]', "content"),
  };
}

async function load() {
  vi.resetModules();
  buildHead();
  return import("./page-meta");
}

describe("per-route page metadata", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("leaves the landing page exactly as index.html wrote it", async () => {
    const m = await load();
    m.applyRouteMeta("landing");
    expect(head()).toEqual({
      title: "Awful.chat - private peer-to-peer chat",
      description: "Landing description.",
      canonical: "https://awful.chat",
      ogUrl: "https://awful.chat",
      ogTitle: "Awful.chat - private peer-to-peer chat",
    });
  });

  it("gives /qs a title, a description and a canonical of its own", async () => {
    const m = await load();
    m.applyRouteMeta("qs");
    const h = head();
    expect(h.title).toMatch(/Send a file with no account/);
    expect(h.description).toMatch(/peer-to-peer/);
    // Origin-relative, unlike index.html's hardcoded tag: a self-hosted
    // instance canonicalises to itself rather than to awful.chat.
    expect(h.canonical).toBe("https://example.test/qs");
    expect(h.ogUrl).toBe("https://example.test/qs");
  });

  it("gives /qc its own, and the two do not collide", async () => {
    const m = await load();
    m.applyRouteMeta("qs");
    const qs = head();
    m.applyRouteMeta("qc");
    const qc = head();
    expect(qc.title).toMatch(/video call with no account/i);
    expect(qc.canonical).toBe("https://example.test/qc");
    expect(qc.title).not.toBe(qs.title);
    expect(qc.description).not.toBe(qs.description);
  });

  it("puts the landing title and description back on the way home", async () => {
    const m = await load();
    m.applyRouteMeta("qs");
    m.applyRouteMeta("landing");
    const h = head();
    expect(h.title).toBe("Awful.chat - private peer-to-peer chat");
    expect(h.description).toBe("Landing description.");
    expect(h.ogTitle).toBe("Awful.chat - private peer-to-peer chat");
  });

  it("survives a head with none of the tags in it", async () => {
    const m = await load();
    els.clear();
    expect(() => m.applyRouteMeta("qs")).not.toThrow();
  });

  it("does nothing at all where there is no document", async () => {
    vi.resetModules();
    vi.stubGlobal("document", undefined);
    const m = await import("./page-meta");
    expect(() => m.applyRouteMeta("qs")).not.toThrow();
  });
});
