import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteCameraTileId } from "./call-tiles";

// The glue between what shows remote cameras and the SFU client. Svelte's
// server build, which this suite runs under, compiles $effect away, so these
// call the push the module's effect runs, with the stores it reads stubbed.
const h = vi.hoisted(() => ({
  setWantedCameras: vi.fn(),
  transportState: { inCall: false },
  spotlightStore: { spotlightTile: null as unknown },
  callFocus: { pinnedTileId: null as string | null },
  poppedOut: new Set<string>(),
  speakers: { speaking: new Set<string>() },
}));

vi.mock("$lib/transport/transport.svelte", () => ({
  _video: { setWantedCameras: h.setWantedCameras },
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
  h.callFocus.pinnedTileId = null;
  h.poppedOut.clear();
  h.speakers.speaking = new Set();
});

afterEach(() => {
  for (const el of tiles) stageCameraHidden(el);
  tiles = [];
});

describe("call-cameras: what the SFU client is told to receive", () => {
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
});
