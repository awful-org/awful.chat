import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryIdOf, newRoomSecret } from "$lib/room-security/keys";
import { consumeRoomLocation } from "./room-location";

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
