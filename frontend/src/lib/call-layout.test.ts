import { describe, expect, it } from "vitest";
import { callGridRects, callLayoutGroups, cameraStripGeometry, DEFAULT_CALL_LAYOUT, filterCallTiles, parseCallLayout } from "./call-layout";
import type { SpotlightTile } from "./spotlight";

const camera = (id: string, local = false, video = true): SpotlightTile => ({ id, peerId: id, kind: "camera", isLocal: local, videoTrack: video ? {} as MediaStreamTrack : null });
const share = (id: string, local = false): SpotlightTile => ({ ...camera(id, local), kind: "screen" });
const people = [camera("ana"), camera("bruno"), camera("carla", false, false), camera("you", true)];
const prefs = DEFAULT_CALL_LAYOUT;
const groups = (tiles: SpotlightTile[], patch = {}, pin: string | null = null, speaker: string | null = null) => callLayoutGroups(tiles, { ...prefs, ...patch }, pin, speaker, new Set(["ana"]));

describe("call layouts", () => {
  it("Auto uses a grid until a share or app appears, then returns to the grid", () => {
    expect(groups(people).grid).toBe(true);
    const screen = share("screen");
    expect(groups([...people, screen]).main).toEqual([screen]);
    expect(groups([...people, screen]).strip).toEqual(people);
    expect(groups(people).grid).toBe(true);
    const app: SpotlightTile = { ...screen, kind: "plugin" };
    expect(groups([...people, app]).main).toEqual([app]);
  });
  it("shows your own screen big and two shares side by side", () => {
    const own = share("own", true), remote = share("remote");
    expect(groups([...people, own]).main).toEqual([own]);
    expect(groups([...people, own, remote]).main).toEqual([own, remote]);
  });
  it("a pin keeps the cameras beside a share; explicit Grid ignores pins", () => {
    const screen = share("screen");
    expect(groups([...people, screen], {}, screen.id).strip).toEqual(people);
    expect(groups([...people, screen], { layout: "grid" }, screen.id).main).toEqual([...people, screen]);
  });
  it("Spotlight uses the held speaker unless explicitly pinned", () => {
    const tiles = [...people, share("screen")];
    expect(groups(tiles, { layout: "spotlight" }, null, "bruno").main[0].id).toBe("bruno");
    expect(groups(tiles, { layout: "spotlight" }, "screen", "bruno").main[0].id).toBe("screen");
    expect(groups(tiles, { layout: "spotlight" }, "gone", "bruno").main[0].id).toBe("bruno");
  });
  it("orders current speakers first without changing the remaining order", () => {
    expect(groups([people[1], people[2], people[0], share("s")]).strip.map((t) => t.id)).toEqual(["ana", "bruno", "carla"]);
  });
  it("honours all filters, including hiding self and deliberately empty views", () => {
    const tiles = [...people, share("s"), { ...share("app"), kind: "plugin" as const }];
    expect(filterCallTiles(tiles, { ...prefs, self: false }).some((t) => t.isLocal)).toBe(false);
    expect(filterCallTiles(tiles, { ...prefs, people: "video" }).map((t) => t.id)).not.toContain("carla");
    expect(filterCallTiles(tiles, { ...prefs, people: "none", screens: false, apps: false })).toEqual([]);
    expect(filterCallTiles(tiles, { ...prefs, people: "none" }).map((t) => t.id)).toEqual(["s", "app"]);
  });
});

describe("mockup geometry", () => {
  it("uses the mockup's 8px gutters and centres incomplete grid rows", () => {
    expect(callGridRects(4, 1264, 672)[0]).toEqual({ x: 0, y: 0, w: 628, h: 332 });
    const rects = callGridRects(5, 1264, 672);
    expect(rects[3].x).toBeGreaterThan(0);
    expect(rects[4].x + rects[4].w).toBeCloseTo(1264 - rects[3].x);
    expect(callGridRects(0, 1264, 672)).toEqual([]);
  });
  it("matches the medium side strip and its overflow example", () => {
    const g = cameraStripGeometry(1264, 672, prefs, 10);
    expect(g).toMatchObject({ position: "side", mainW: 1032, mainH: 672, tileW: 224, tileH: 126, shown: 4, more: 6 });
  });
  it("chooses bottom on narrow stages and honours explicit and hidden positions", () => {
    expect(cameraStripGeometry(600, 400, prefs, 4).position).toBe("bottom");
    expect(cameraStripGeometry(600, 400, { ...prefs, strip: "side" }, 4).position).toBe("side");
    expect(cameraStripGeometry(1264, 672, { ...prefs, strip: "hidden" }, 4)).toMatchObject({ mainW: 1264, mainH: 672, shown: 0, more: 0 });
    expect(cameraStripGeometry(1264, 672, prefs, 0)).toMatchObject({ mainW: 1264, mainH: 672 });
  });
  it("keeps the phone strip swipeable without rendering an overflow placeholder", () => {
    expect(cameraStripGeometry(374, 330, prefs, 10, true)).toMatchObject({ scroll: true, shown: 10, more: 0, tileW: 84, tileH: 112 });
  });
  it("always reserves an overflow cell, even when only one cell fits", () => {
    expect(cameraStripGeometry(800, 100, prefs, 10)).toMatchObject({ shown: 0, more: 10 });
  });
});

describe("device-local layout preference parsing", () => {
  it("defaults safely for absent, malformed, or untrusted storage", () => {
    for (const value of [null, "{", "null", "42", '{"layout":"invalid","self":0,"screens":"false"}']) expect(parseCallLayout(value)).toEqual(prefs);
  });
  it("round trips all layout choices", () => {
    const value = { layout: "grid", strip: "bottom", size: "l", people: "none", self: false, screens: false, apps: false, stripPx: 180 };
    expect(parseCallLayout(JSON.stringify(value))).toEqual(value);
  });
  it("clamps dragged sizes and rejects nonnumeric sizes", () => {
    expect(parseCallLayout('{"stripPx":10000}').stripPx).toBe(480);
    expect(parseCallLayout('{"stripPx":-1}').stripPx).toBe(64);
    expect(parseCallLayout('{"stripPx":"180"}').stripPx).toBeNull();
  });
});
