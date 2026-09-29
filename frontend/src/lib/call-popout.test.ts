import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotlightTile } from "./spotlight";

// The popup is about:blank and drawn from here, so a fake window with a
// fake document is all the module touches.
type FakeEl = { style: Record<string, string>; textContent: string; srcObject: unknown };
let created: FakeEl[] = [];
let popup: { closed: boolean; close(): void };

function fakeElement(): FakeEl & Record<string, unknown> {
  const el = {
    style: {} as Record<string, string>,
    textContent: "",
    srcObject: null as unknown,
    addEventListener() {},
  };
  created.push(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  created = [];
  popup = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const doc = {
    title: "",
    body: { style: {}, replaceChildren() {}, append() {}, requestFullscreen: async () => {} },
    createElement: fakeElement,
    addEventListener() {},
    fullscreenElement: null,
  };
  Object.assign(popup, { document: doc, focus() {}, addEventListener() {} });
  vi.stubGlobal("window", {
    open: () => popup,
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 800,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
  });
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { openPopout, syncPopouts, poppedOut, closeAllPopouts } = await import("./call-popout.svelte");

const track = { id: "t1" } as unknown as MediaStreamTrack;
const share: SpotlightTile = {
  id: "remote-screen-ana",
  kind: "screen",
  isLocal: false,
  peerId: "ana",
  videoTrack: track,
};
const camera: SpotlightTile = {
  id: "remote-camera-ana",
  kind: "camera",
  isLocal: false,
  peerId: "ana",
  videoTrack: track,
};
const pending: SpotlightTile = {
  id: "pending-tx-ana",
  kind: "transmission",
  isLocal: false,
  peerId: "ana",
  videoTrack: null,
};
const name = () => "Ana";
/** The "no picture" line: the second element the window builds. */
const message = () => created[1].textContent;

describe("a popped-out stream whose tile goes away", () => {
  afterEach(() => closeAllPopouts());

  it("says the share ended and closes, instead of waiting", () => {
    openPopout(share, "Ana");
    syncPopouts([], name);
    expect(message()).toBe("Ana stopped sharing");
    expect(popup.closed).toBe(false);

    vi.advanceTimersByTime(3000);
    expect(popup.closed).toBe(true);
    expect(poppedOut.has(share.id)).toBe(false);
  });

  it("waits for a share that is only reconnecting, and picks it back up", () => {
    openPopout(share, "Ana");
    // Still watched, no picture: the placeholder tile stands in for it.
    syncPopouts([pending], name);
    expect(message()).toBe("Reconnecting to Ana's screen...");

    vi.advanceTimersByTime(10_000);
    expect(popup.closed).toBe(false);

    syncPopouts([share], name);
    vi.advanceTimersByTime(30_000);
    expect(popup.closed).toBe(false);
    expect(poppedOut.has(share.id)).toBe(true);
  });

  it("stops waiting once a reconnect turns into the share ending", () => {
    openPopout(share, "Ana");
    syncPopouts([pending], name);
    syncPopouts([], name);
    expect(message()).toBe("Ana stopped sharing");
    vi.advanceTimersByTime(3000);
    expect(popup.closed).toBe(true);
  });

  it("says a person left when their camera window loses its tile", () => {
    openPopout(camera, "Ana");
    syncPopouts([], name);
    expect(message()).toBe("Ana left the call");
  });
});
