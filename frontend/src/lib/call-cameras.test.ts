import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteCameraTileId } from "./call-tiles";

// The glue between what shows remote cameras and the SFU client. Svelte's
// server build, which this suite runs under, compiles $effect away, so these
// call the push the module's effect runs, with the stores it reads stubbed.
const h = vi.hoisted(() => ({
  setWantedCameras: vi.fn(),
  setCameraDisplaySizes: vi.fn(),
  transportState: { inCall: false },
  spotlightStore: { spotlightTile: null as unknown, pipCameraPeers: [] as string[] },
  callFocus: { pinnedTileId: null as string | null },
  poppedOut: new Set<string>(),
  speakers: { speaking: new Set<string>() },
}));

vi.mock("$lib/transport/transport.svelte", () => ({
  _video: {
    setWantedCameras: h.setWantedCameras,
    setCameraDisplaySizes: h.setCameraDisplaySizes,
  },
  transportState: h.transportState,
  selfId: () => "self",
}));
vi.mock("$lib/call-spotlight.svelte", () => ({ spotlightStore: h.spotlightStore }));
vi.mock("$lib/call-focus.svelte", () => ({ callFocus: h.callFocus }));
vi.mock("$lib/call-popout.svelte", () => ({ poppedOut: h.poppedOut }));
vi.mock("$lib/speakers.svelte", () => ({ speakers: h.speakers }));

const { pushWantedCameras, stageCameraHidden, stageCameraShown } = await import(
  "./call-cameras.svelte"
);

const camera = (peerId: string) => ({
  id: remoteCameraTileId(peerId),
  kind: "camera" as const,
  isLocal: false,
  peerId,
  videoTrack: null,
});

/** The set handed over by the latest push. */
function pushed(): Set<string> | undefined {
  return h.setWantedCameras.mock.calls.at(-1)?.[0];
}

// The stage's tiles are module state: every test hides what it showed.
let tiles: Element[] = [];
function tile(): Element {
  const el = {} as Element;
  tiles.push(el);
  return el;
}

beforeEach(() => {
  h.setWantedCameras.mockClear();
  h.transportState.inCall = true;
  h.spotlightStore.spotlightTile = null;
  h.spotlightStore.pipCameraPeers = [];
  h.callFocus.pinnedTileId = null;
  h.poppedOut.clear();
  h.speakers.speaking = new Set();
});

afterEach(() => {
  for (const el of tiles) stageCameraHidden(el);
  tiles = [];
});

describe("call-cameras: what the SFU client is told to receive", () => {
  it("receives every visible PiP camera after the stage unmounts, and releases hidden ones", () => {
    const stage = tile();
    stageCameraShown(stage, "peer-a");
    h.spotlightStore.pipCameraPeers = ["peer-a", "peer-b", "peer-c"];
    stageCameraHidden(stage);
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-a", "peer-b", "peer-c"]));
    h.spotlightStore.pipCameraPeers = ["peer-b"];
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-b"]));
    h.spotlightStore.pipCameraPeers = [];
    pushWantedCameras();
    expect(pushed()).toEqual(new Set());
  });
  it("sends nothing outside a call, and the call's screen once one starts", () => {
    h.transportState.inCall = false;
    stageCameraShown(tile(), "peer-a");

    pushWantedCameras();
    // Outside a call the client keeps no opinion: every camera received.
    expect(h.setWantedCameras).not.toHaveBeenCalled();

    h.transportState.inCall = true;
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-a"]));
  });

  it("follows the stage's tiles on and off the screen", () => {
    const a = tile();
    stageCameraShown(a, "peer-a");
    stageCameraShown(tile(), "peer-b");
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-a", "peer-b"]));

    stageCameraHidden(a);
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-b"]));
  });

  it("keeps a camera while another tile still shows it (grid to focus)", () => {
    const grid = tile();
    const focus = tile();
    stageCameraShown(grid, "peer-a");
    stageCameraShown(focus, "peer-a");

    stageCameraHidden(grid);
    pushWantedCameras();
    expect(pushed()).toEqual(new Set(["peer-a"]));

    stageCameraHidden(focus);
    pushWantedCameras();
    expect(pushed()).toEqual(new Set());
  });

  it("moves with a tile the stage hands to another peer", () => {
    const el = tile();
    stageCameraShown(el, "peer-a");
    stageCameraShown(el, "peer-x");

    pushWantedCameras();

    expect(pushed()).toEqual(new Set(["peer-x"]));
  });

  it("adds the spotlight, popped-out windows and whoever is talking, never us", () => {
    // Another room open: the stage is gone and these are all that is left.
    h.spotlightStore.spotlightTile = camera("peer-b");
    h.poppedOut.add(remoteCameraTileId("peer-c"));
    h.poppedOut.add("remote-screen-peer-e");
    h.speakers.speaking = new Set(["peer-d", "self"]);

    pushWantedCameras();

    expect(pushed()).toEqual(new Set(["peer-b", "peer-c", "peer-d"]));
  });

  it("asks for no one who is talking while a pin holds the spotlight", () => {
    const pinned = camera("peer-b");
    h.spotlightStore.spotlightTile = pinned;
    h.callFocus.pinnedTileId = pinned.id;
    h.speakers.speaking = new Set(["peer-d"]);

    pushWantedCameras();

    expect(pushed()).toEqual(new Set(["peer-b"]));
  });

  it("asks for no one who is talking in a quick call, where nothing computes a spotlight", () => {
    // /qc mounts the stage without AppView: no floating panel, no picture
    // in picture, and the spotlight store stays empty.
    stageCameraShown(tile(), "peer-a");
    h.speakers.speaking = new Set(["peer-d"]);

    pushWantedCameras();

    expect(pushed()).toEqual(new Set(["peer-a"]));
  });

  it("hands over each camera's largest size, and null where it cannot be measured", () => {
    // The observer is made once for the module, so one test covers it.
    let report: ((entries: { target: Element; contentRect: { width: number; height: number } }[]) => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: typeof report) {
          report = cb;
        }
        observe() {}
        unobserve() {}
      }
    );
    try {
      const sized = (width: number, height: number): Element => {
        const el = { getBoundingClientRect: () => ({ width, height }) } as unknown as Element;
        tiles.push(el);
        return el;
      };
      const small = sized(300, 169);
      stageCameraShown(small, "peer-a");
      stageCameraShown(sized(150, 84), "peer-b");
      stageCameraShown(sized(400, 225), "peer-b");
      h.spotlightStore.spotlightTile = camera("peer-c");

      h.speakers.speaking = new Set(["peer-d"]);
      h.poppedOut.add(remoteCameraTileId("peer-e"));
      h.spotlightStore.pipCameraPeers = ["peer-f"];

      pushWantedCameras();
      // Stage tiles at their size; the spotlight and the talker at the
      // floating panel's (320); a window of its own and picture in picture
      // unmeasured.
      expect(h.setCameraDisplaySizes.mock.calls.at(-1)?.[0]).toEqual(
        new Map<string, number | null>([
          ["peer-a", 300],
          ["peer-b", 400],
          ["peer-f", null],
          ["peer-c", 320],
          ["peer-d", 320],
          ["peer-e", null],
        ])
      );

      // The tile grows, say the window is made wider.
      report!([{ target: small, contentRect: { width: 900, height: 506 } }]);
      pushWantedCameras();
      expect(h.setCameraDisplaySizes.mock.calls.at(-1)?.[0].get("peer-a")).toBe(900);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
