import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryIdOf, newRoomSecret } from "$lib/room-security/keys";
import { channelOfPlace, consumeRoomLocation, dmOfPlace, dmPlace, noteChannel, parkedRoom, showPlace } from "./room-location";

/** window.location and history.replaceState over one address. */
function addressBar(href: string) {
  let url = new URL(href, "https://awful.example");
  const replaced: string[] = [];
  vi.stubGlobal("window", {
    get location() {
      return url;
    },
  });
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_state: unknown, _title: string, next: string) => {
      replaced.push(next);
      url = new URL(next, url);
    },
  });
  return { replaced, shown: () => url.pathname + url.hash };
}

afterEach(() => vi.unstubAllGlobals());

// Moved out of AppView so the setup and unlock screens can run it before
// AppView has loaded; what it does must not have changed on the way.
describe("consumeRoomLocation", () => {
  // The code in an invite link IS the room's secret.
  it("takes a secret out of the address bar as it reads it", () => {
    const secret = newRoomSecret();
    const bar = addressBar(`/r/#${secret}`);
    expect(consumeRoomLocation()).toBe(secret);
    expect(bar.shown()).toBe("/r/");
  });

  it("does the same with a short code, and with a link from before fragments", () => {
    let bar = addressBar("/r/#K5T-8R5");
    expect(consumeRoomLocation()).toBe("k5t-8r5");
    expect(bar.shown()).toBe("/r/");
    const secret = newRoomSecret();
    bar = addressBar(`/r/${secret}`);
    expect(consumeRoomLocation()).toBe(secret);
    expect(bar.shown()).toBe("/r/");
  });

  it("leaves a public room id in place, so a reload reopens the room", () => {
    const id = discoveryIdOf(newRoomSecret());
    const bar = addressBar(`/r/#${id}`);
    expect(consumeRoomLocation()).toBe(id);
    expect(bar.replaced).toEqual([]);
  });

  it("reads nothing outside /r/, or from an empty one", () => {
    for (const href of [`/app#${newRoomSecret()}`, "/r/", "/"]) {
      const bar = addressBar(href);
      expect(consumeRoomLocation(), href).toBeNull();
      expect(bar.replaced, href).toEqual([]);
    }
  });
});

describe("an invitation passed on by an app that touched it", () => {
  it.each([
    ["no slash before the #", (s: string) => `/r#${s}`],
    ["a full stop after it", (s: string) => `/r/#${s}.`],
    ["a bracket after it", (s: string) => `/r/#${s})`],
    ["a tracking parameter", (s: string) => `/r/?fbclid=x#${s}`],
  ])("opens with %s", (_what, href) => {
    const secret = newRoomSecret();
    const bar = addressBar(href(secret));
    expect(consumeRoomLocation()).toBe(secret);
    expect(bar.shown()).toBe("/r/");
  });
});

describe("parkedRoom", () => {
  function storage() {
    const held = new Map<string, string>();
    return Object.assign(held, {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    });
  }
  function browser(href = "/r/") {
    const tab = storage();
    const device = storage();
    vi.stubGlobal("sessionStorage", tab);
    vi.stubGlobal("localStorage", device);
    addressBar(href);
    return { tab, device };
  }
  /** The module as a load of the tab at this address would load it. */
  async function loaded(href = "/r/") {
    addressBar(href);
    vi.resetModules();
    return import("./room-location");
  }
  const KEY = "awful:parked-invitation:v1";

  it("keeps an invitation through a reload until its join has run", async () => {
    const { tab } = browser();
    const secret = newRoomSecret();
    parkedRoom.code = secret;
    const after = (await loaded()).parkedRoom;
    expect(after.code).toBe(secret);
    after.code = null;
    expect(after.code).toBeNull();
    expect(tab.size).toBe(0);
    expect((await loaded()).parkedRoom.code).toBeNull();
  });

  it("calls it off when the tab goes to another address", async () => {
    const { tab } = browser();
    parkedRoom.code = newRoomSecret();
    expect((await loaded("/app")).parkedRoom.code).toBeNull();
    expect(tab.size).toBe(0);
    expect((await loaded("/r/")).parkedRoom.code).toBeNull();
  });

  it("holds nothing readable, and nothing at all once the device is wiped", async () => {
    const { tab, device } = browser();
    const secret = newRoomSecret();
    parkedRoom.code = secret;
    const held = tab.get(KEY)!;
    expect(held).not.toContain(secret.slice(3));
    // The wipe reaches the device's storage, not a tab that is not running.
    device.clear();
    expect((await loaded()).parkedRoom.code).toBeNull();
    expect(tab.size).toBe(0);
    // Nor does a key made since open it.
    (await loaded()).parkedRoom.code = "k5t-8r5";
    tab.set(KEY, held);
    expect((await loaded()).parkedRoom.code).toBeNull();
  });

  it("is forgotten in every tab with the account", async () => {
    const { tab } = browser();
    parkedRoom.code = newRoomSecret();
    const held = tab.get(KEY)!;
    (await loaded()).forgetParkedRooms();
    expect(tab.size).toBe(0);
    tab.set(KEY, held); // Another tab's copy.
    expect((await loaded()).parkedRoom.code).toBeNull();
  });

  it("keeps a short code as well, and no public room id", async () => {
    const { tab } = browser();
    parkedRoom.code = "k5t-8r5";
    expect((await loaded()).parkedRoom.code).toBe("k5t-8r5");
    parkedRoom.code = discoveryIdOf(newRoomSecret());
    expect(tab.size).toBe(0);
    parkedRoom.code = null;
  });

  it("works from memory where there is no storage", () => {
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("localStorage", undefined);
    parkedRoom.code = "k5t-8r5";
    expect(parkedRoom.code).toBe("k5t-8r5");
    parkedRoom.code = null;
  });
});

describe("the place a history entry stands for", () => {
  const DM = "dm-4f1c0a";

  /** The tab's history, with storage for the key. */
  function tab() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const entries: { state: any; url: string }[] = [{ state: null, url: "/app" }];
    const at = () => new URL(entries.at(-1)!.url, "https://awful.example");
    vi.stubGlobal("window", { get location() { return at(); } });
    vi.stubGlobal("history", {
      get state() { return entries.at(-1)!.state; },
      pushState: (state: unknown, _: string, url: string) => void entries.push({ state, url }),
      replaceState: (state: unknown, _: string, url?: string) => {
        entries[entries.length - 1] = { state, url: url ?? entries.at(-1)!.url };
      },
    });
    return { entries, store };
  }

  it("keeps a DM in the entry, sealed, and out of the address", () => {
    const { entries } = tab();
    expect(dmOfPlace()).toBeNull();
    showPlace(dmPlace(DM), "/app");
    expect(dmOfPlace()).toBe(DM);
    expect(entries.at(-1)!.url).toBe("/app");
    expect(JSON.stringify(entries)).not.toContain("4f1c0a");
  });

  it("reads nothing once a wipe took the key", () => {
    const { store } = tab();
    showPlace(dmPlace(DM), "/app");
    store.clear();
    expect(dmOfPlace()).toBeNull();
    // Nor under the next key there.
    dmPlace("dm-other");
    expect(dmOfPlace()).toBeNull();
  });

  it("reads nothing from an entry that is not one", () => {
    const { entries } = tab();
    dmPlace(DM);
    for (const dm of ["", "junk", "a.b.c", 7, {}, null]) {
      entries[0].state = { dm };
      expect(dmOfPlace()).toBeNull();
    }
  });

  it("adds no entry for the place already there", () => {
    const { entries } = tab();
    showPlace(dmPlace(DM), "/app");
    showPlace(dmPlace(DM), "/app");
    expect(entries).toHaveLength(2);
    showPlace(dmPlace("dm-other"), "/app");
    showPlace({ roomCode: "a" }, "/r/#a");
    showPlace({ roomCode: "a", channel: "x" }, "/r/#a");
    showPlace({}, "/app");
    expect(entries.map((e) => e.url)).toEqual(["/app", "/app", "/app", "/r/#a", "/app"]);
  });

  it("keeps the channel of the room it is on", () => {
    tab();
    showPlace({ roomCode: "a" }, "/r/#a");
    expect(channelOfPlace("a")).toBe("");
    noteChannel("a", "x");
    expect(channelOfPlace("a")).toBe("x");
    noteChannel("b", "y");
    expect(channelOfPlace("a")).toBe("x");
    expect(channelOfPlace("b")).toBeNull();
    noteChannel("a", "");
    expect(channelOfPlace("a")).toBe("");
  });
});
