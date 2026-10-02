import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app, /qs and /qc used to be static imports of App.svelte, which made
 * the whole app one entry chunk: the landing page waited for all ~2.9 MB of
 * it before painting anything.
 */

const PAGES = ["AppView", "QuickSend", "QuickCall"] as const;

/** Every page and prompt as a stub, counting which pages were loaded. */
function stubComponents() {
  const loaded: string[] = [];
  for (const name of PAGES) {
    vi.doMock(`$lib/components/${name}.svelte`, () => {
      loaded.push(name);
      return { default: () => {} };
    });
  }
  // Not what is being tested, and the worker registration needs the PWA plugin.
  for (const name of ["ReloadPrompt", "InstallPrompt", "NotifyPrompt"]) {
    vi.doMock(`$lib/components/${name}.svelte`, () => ({ default: () => {} }));
  }
  return loaded;
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  for (const name of [...PAGES, "ReloadPrompt", "InstallPrompt", "NotifyPrompt"]) {
    vi.doUnmock(`$lib/components/${name}.svelte`);
  }
  vi.unstubAllGlobals();
});

describe("the startup bundle", () => {
  it("does not load the app, /qs or /qc to show the landing page", async () => {
    const loaded = stubComponents();
    await import("./App.svelte");
    expect(loaded).toEqual([]);
  });

  it("loads a page once, when it is shown", async () => {
    const loaded = stubComponents();
    const { loadPage } = await import("./pages");
    const first = loadPage("app");
    expect(loadPage("app")).toBe(first);
    await first;
    await loadPage("app");
    expect(loaded).toEqual(["AppView"]);
  });

  it("tries a failed load again instead of keeping the failure", async () => {
    let attempts = 0;
    vi.doMock("$lib/components/QuickSend.svelte", () => {
      if (attempts++ === 0) throw new Error("offline");
      return { default: () => {} };
    });
    const { loadPage } = await import("./pages");
    await expect(loadPage("qs")).rejects.toThrow();
    await expect(loadPage("qs")).resolves.toBeTypeOf("function");
    expect(attempts).toBe(2);
  });
});

describe("pageFor", () => {
  // Has to agree with App.svelte's route effect.
  it("names the page an address shows", async () => {
    const { pageFor } = await import("./pages");
    expect(pageFor("/")).toBeNull();
    expect(pageFor("/r/")).toBe("app");
    expect(pageFor("/r/k5t-8r5")).toBe("app");
    expect(pageFor("/app")).toBe("app");
    expect(pageFor("/share-target")).toBe("app");
    // App.svelte matches these exactly: "/app/" is the landing page.
    expect(pageFor("/app/")).toBeNull();
    expect(pageFor("/r")).toBeNull();
  });

  it("knows /qs and /qc only when the instance serves them", async () => {
    const { pageFor } = await import("./pages");
    const { setRuntimeConfig } = await import("$lib/runtime-config");
    expect(pageFor("/qs")).toBeNull();
    expect(pageFor("/qc/")).toBeNull();
    setRuntimeConfig({ useQs: true, useQc: true });
    expect(pageFor("/qs")).toBe("qs");
    expect(pageFor("/qc/")).toBe("qc");
  });
});

describe("preloadPage", () => {
  /** A head that records what is appended, and the list index.html carries. */
  function page(list: string | null) {
    const head: Record<string, string>[] = [];
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "page-chunks" && list !== null ? { textContent: list } : null),
      createElement: () => ({}),
      head: { appendChild: (link: Record<string, string>) => head.push({ ...link }) },
    });
    return head;
  }

  it("fetches the page's chunks and styles without running them", async () => {
    const head = page(JSON.stringify({ app: ["/assets/AppView-x.js", "/assets/app-y.css"], qs: ["/assets/QuickSend-z.js"] }));
    const { preloadPage } = await import("./pages");
    preloadPage("app");
    expect(head).toEqual([
      { rel: "modulepreload", crossOrigin: "", href: "/assets/AppView-x.js" },
      { rel: "preload", as: "style", crossOrigin: "", href: "/assets/app-y.css" },
    ]);
  });

  it("does nothing for the landing page, without a list, or with a damaged one", async () => {
    const { preloadPage } = await import("./pages");
    const cases: [string | null, "app" | null][] = [
      [JSON.stringify({ app: ["/assets/AppView-x.js"] }), null], // the landing page
      [null, "app"], // `pnpm dev`: no list
      ["{ not json", "app"],
      ['{"app": "nope"}', "app"],
    ];
    for (const [list, which] of cases) {
      const head = page(list);
      preloadPage(which);
      expect(head).toEqual([]);
    }
  });
});
