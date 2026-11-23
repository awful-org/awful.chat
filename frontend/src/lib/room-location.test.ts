import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryIdOf, newRoomSecret } from "$lib/room-security/keys";
import { consumeRoomLocation, parkedRoom } from "./room-location";

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
  function tabStorage() {
    const held = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    });
    return held;
  }
  /** The module as a reload of the tab would load it. */
  async function reloaded() {
    vi.resetModules();
    return (await import("./room-location")).parkedRoom;
  }

  it("keeps an invitation through a reload until its join has run", async () => {
    const held = tabStorage();
    const secret = newRoomSecret();
    parkedRoom.code = secret;
    const after = await reloaded();
    expect(after.code).toBe(secret);
    after.code = null;
    expect(after.code).toBeNull();
    expect(held.size).toBe(0);
    expect((await reloaded()).code).toBeNull();
  });

  it("keeps a short code as well, and no public room id", async () => {
    const held = tabStorage();
    parkedRoom.code = "k5t-8r5";
    expect((await reloaded()).code).toBe("k5t-8r5");
    parkedRoom.code = discoveryIdOf(newRoomSecret());
    expect(held.size).toBe(0);
    parkedRoom.code = null;
  });

  it("works from memory where there is no storage", () => {
    vi.stubGlobal("sessionStorage", undefined);
    parkedRoom.code = "k5t-8r5";
    expect(parkedRoom.code).toBe("k5t-8r5");
    parkedRoom.code = null;
  });
});
