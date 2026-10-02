import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app, /qs and /qc used to be static imports of App.svelte, which made
 * the whole app one entry chunk: the landing page waited for all ~2.9 MB of
 * it before painting anything. And the app's own setup and unlock screens
 * lived inside AppView, so an invite link's first visit still waited for
 * nearly all of it before showing a form.
 */

const PAGES = ["AppView", "IdentityGate", "QuickSend", "QuickCall"] as const;

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
  vi.restoreAllMocks();
});

describe("the startup bundle", () => {
  it("does not load the app, its setup screens, /qs or /qc to show the landing page", async () => {
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

  it("tries a failed load again instead of keeping the failure, and says why it failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    vi.doMock("$lib/components/QuickSend.svelte", () => {
      if (attempts++ === 0) throw new Error("offline");
      return { default: () => {} };
    });
    const { loadPage } = await import("./pages");
    await expect(loadPage("qs")).rejects.toThrow();
    // The screen only says "could not load"; a module that threw is a bug.
    expect(logged).toHaveBeenCalledWith("[pages] qs could not load", expect.any(Error));
    await expect(loadPage("qs")).resolves.toBeTypeOf("function");
    expect(attempts).toBe(2);
  });
});

/**
 * Modules the setup and unlock screens must not bring with them. The device
 * sync dialog is one through sync.svelte, which it imports.
 */
const HEAVY = [
  "$lib/components/AppView.svelte",
  "$lib/transport/transport.svelte",
  "$lib/transport/sync.svelte",
  "$lib/transport/libp2p/transport",
  "$lib/room-security/invitation-pairing",
];

describe("the setup and unlock screens", () => {
  /**
   * The icon and UI component libraries, which the test compiled module by
   * module - about 1,650 icons and 400 bits-ui files, most of its 20 s - to
   * learn nothing: neither imports any of the app. Each is a stub that
   * answers any name, a component or a namespace of them (Dialog.Root), and
   * nothing renders on import.
   */
  const LIBRARIES = ["@lucide/svelte", "bits-ui"];
  function libraryStub(): object {
    const named = (name: string | symbol) => typeof name === "string" && name !== "then";
    const anything: object = new Proxy(function stub() {}, {
      get: (_, name) => (named(name) ? anything : undefined),
    });
    return new Proxy({}, { get: (_, name) => (named(name) ? anything : undefined), has: (_, name) => named(name) });
  }

  /** Each heavy module as a stub that records being loaded. */
  function watchHeavy() {
    const loaded: string[] = [];
    for (const path of HEAVY) {
      vi.doMock(path, () => {
        loaded.push(path);
        return {};
      });
    }
    for (const library of LIBRARIES) vi.doMock(library, libraryStub);
    return loaded;
  }
  afterEach(() => {
    for (const path of [...HEAVY, ...LIBRARIES]) vi.doUnmock(path);
  });

  // An invite link's first visit, and every launch that starts at the unlock
  // screen, used to wait for libp2p, the call UI and the transport (about
  // 2 MB) before the form appeared. The app now loads behind them.
  it("load none of the app", async () => {
    const loaded = watchHeavy();
    await import("$lib/components/IdentityGate.svelte");
    expect(loaded).toEqual([]);
  }, 60_000);

  it("(the watch works: the device sync dialog does bring the transport)", async () => {
    const loaded = watchHeavy();
    await import("$lib/components/DeviceSyncDialog.svelte").catch(() => {});
    expect(loaded).toContain("$lib/transport/sync.svelte");
  }, 60_000);
});

describe("routeFor", () => {
  // App.svelte routes with it, and main.ts preloads from it before App runs.
  it("names what an address shows", async () => {
    const { routeFor } = await import("./pages");
    expect(routeFor("/")).toBe("landing");
    expect(routeFor("/r/")).toBe("app");
    expect(routeFor("/r/k5t-8r5")).toBe("app");
    expect(routeFor("/app")).toBe("app");
    expect(routeFor("/share-target")).toBe("app");
    // Matched exactly: "/app/" is the landing page.
    expect(routeFor("/app/")).toBe("landing");
    expect(routeFor("/r")).toBe("landing");
  });

  it("knows /qs and /qc only when the instance serves them", async () => {
    const { routeFor } = await import("./pages");
    const { setRuntimeConfig } = await import("$lib/runtime-config");
    expect(routeFor("/qs")).toBe("landing");
    expect(routeFor("/qc/")).toBe("landing");
    setRuntimeConfig({ useQs: true, useQc: true });
    expect(routeFor("/qs")).toBe("qs");
    expect(routeFor("/qc/")).toBe("qc");
  });

  // A saved copy of the configuration can be wrong about exactly these two,
  // so main.ts waits for the served one before routing them.
  it("tells which addresses exist only when the instance says so", async () => {
    const { optionalRoute } = await import("./pages");
    expect(optionalRoute("/qs")).toBe("qs");
    expect(optionalRoute("/qc/")).toBe("qc");
    for (const other of ["/", "/app", "/r/", "/qsx", "/q", "/r/qs"]) {
      expect(optionalRoute(other), other).toBeNull();
    }
  });

  it("starts the app's address at the setup and unlock screens", async () => {
    const { firstPage } = await import("./pages");
    expect(firstPage("app")).toBe("gate");
    expect(firstPage("qs")).toBe("qs");
    expect(firstPage("qc")).toBe("qc");
    expect(firstPage("landing")).toBeNull();
  });
});

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

describe("preloadPage", () => {
  it("fetches the page's chunks and styles without running them, once", async () => {
    const head = page(JSON.stringify({ app: ["/assets/AppView-x.js", "/assets/app-y.css"], qs: ["/assets/QuickSend-z.js"] }));
    const { preloadPage } = await import("./pages");
    preloadPage("app");
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

describe("prefetchPage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The app behind the setup screen: worth having by the time the password
  // is typed, but never at the cost of the screen that is up.
  it("waits for an idle moment", async () => {
    const head = page(JSON.stringify({ app: ["/assets/AppView-x.js"] }));
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => void (idle = fn));
    const { prefetchPage } = await import("./pages");
    prefetchPage("app");
    expect(head).toEqual([]);
    idle?.();
    expect(head).toHaveLength(1);
  });

  // A preload still unused a few seconds after the load is a console
  // warning, and the app's stylesheets wait for the password.
  it("fetches the stylesheets into the cache rather than preloading them", async () => {
    const head = page(JSON.stringify({ app: ["/assets/AppView-x.js", "/assets/app-y.css"] }));
    const { prefetchPage } = await import("./pages");
    prefetchPage("app");
    await vi.runAllTimersAsync();
    expect(head).toEqual([
      { rel: "modulepreload", crossOrigin: "", href: "/assets/AppView-x.js" },
      { rel: "prefetch", crossOrigin: "", href: "/assets/app-y.css" },
    ]);
  });

  // The service worker's precache downloads the same chunks regardless, so
  // holding back saved nothing; it only left the unlock needing the network.
  it("fetches it when the browser asks to save data too", async () => {
    const head = page(JSON.stringify({ app: ["/assets/AppView-x.js"] }));
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const { prefetchPage } = await import("./pages");
    prefetchPage("app");
    await vi.runAllTimersAsync();
    expect(head).toEqual([{ rel: "modulepreload", crossOrigin: "", href: "/assets/AppView-x.js" }]);
  });
});
