import { describe, expect, it } from "vitest";
import { DEFAULT_CALL_LAYOUT } from "./call-layout";
import { pipLayoutCells, type PipLayout, type PipTile } from "./call-pip-layout";

const camera = (id: string, local = false, video = true): PipTile => ({ id, peerId: id, kind: "camera", isLocal: local, videoTrack: video ? {} as MediaStreamTrack : null, label: id });
const people = [camera("you", true), camera("ana"), camera("ben"), camera("cam-off", false, false)];
const screen: PipTile = { ...camera("screen", true), kind: "screen" };
const app: PipTile = { ...camera("app", false, false), kind: "plugin" };
const layout = (patch: Partial<PipLayout["prefs"]> = {}, tiles = [...people, screen, app]): PipLayout => ({ tiles, prefs: { ...DEFAULT_CALL_LAYOUT, ...patch }, pin: null, speaker: "ana", speaking: new Set() });

describe("shared PiP layouts", () => {
  it("promotes your own content in Auto and equally sizes everything in Grid", () => {
    const auto = pipLayoutCells(layout(), 320, 180);
    expect(auto.cells.slice(0, 2).map((c) => c.tile.id)).toEqual(["screen", "app"]);
    const grid = pipLayoutCells(layout({ layout: "grid" }), 320, 180);
    expect(grid.cells).toHaveLength(6);
    expect(new Set(grid.cells.map((c) => `${c.rect.w}:${c.rect.h}`)).size).toBe(1);
    expect(grid.overflow).toBeNull();
  });
  it("inherits Spotlight, pins and literal content/self/people filters", () => {
    const value = layout({ layout: "spotlight", strip: "hidden" });
    expect(pipLayoutCells(value, 320, 180).cells.map((c) => c.tile.id)).toEqual(["ana"]);
    value.pin = "screen";
    expect(pipLayoutCells(value, 320, 180).cells[0].tile.id).toBe("screen");
    value.prefs.screens = false;
    expect(pipLayoutCells(value, 320, 180).cells[0].tile.id).toBe("ana");
    const filtered = pipLayoutCells(layout({ layout: "grid", self: false, apps: false, screens: false, people: "video" }), 320, 180);
    expect(filtered.cells.map((c) => c.tile.id)).toEqual(["ana", "ben"]);
    expect(pipLayoutCells(layout({ people: "none", apps: false, screens: false }), 320, 180).cells).toEqual([]);
  });
  it("keeps content prominent and fits a bounded strip/overflow in resized PiP windows", () => {
    for (const [width, height] of [[320, 180], [180, 320], [900, 500], [120, 90]]) {
      for (const position of ["auto", "bottom", "side", "hidden"] as const) {
        const value = layout({ strip: position, stripPx: 480 }, [...people, ...Array.from({ length: 20 }, (_, i) => camera(`peer-${i}`)), screen]);
        const { cells, overflow } = pipLayoutCells(value, width, height);
        expect(cells[0].tile.id).toBe("screen");
        expect(cells[0].rect.w * cells[0].rect.h).toBeGreaterThan(width * height * .45);
        for (const rect of [...cells.map((c) => c.rect), ...(overflow ? [overflow.rect] : [])]) {
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.w).toBeLessThanOrEqual(width + .001);
          expect(rect.y + rect.h).toBeLessThanOrEqual(height + .001);
        }
      }
    }
  });
  it("uses independent bounds without changing saved strip preferences", () => {
    const value = layout({ strip: "side", size: "l", stripPx: 480 }, [...people, screen]);
    const before = structuredClone(value.prefs);
    const small = pipLayoutCells(value, 320, 180);
    const large = pipLayoutCells(value, 900, 500);
    expect(small.cells[0].rect.w).not.toBe(large.cells[0].rect.w);
    expect(value.prefs).toEqual(before);
  });
  it("retains independent stable speaker slots through PiP updates, filtering and resizing", () => {
    const value = layout({ strip: "side" }, [...Array.from({ length: 7 }, (_, i) => camera(`p${i}`)), screen]);
    const first = pipLayoutCells(value, 900, 500);
    expect(first.stripState.ids).toEqual(["p0", "p1"]);
    value.speaking = new Set(["p1"]);
    const visibleSpeaker = pipLayoutCells(value, 900, 500, first.stripState);
    expect(visibleSpeaker.stripState.ids).toEqual(first.stripState.ids);
    value.speaking = new Set(["p4"]);
    value.lastSpokeAt = new Map([["p0", 10], ["p1", 20], ["p4", 30]]);
    const promoted = pipLayoutCells(value, 900, 500, visibleSpeaker.stripState);
    expect(promoted.stripState.ids).toEqual(["p4", "p1"]);
    expect(promoted.cells.slice(1).map((cell) => cell.tile.id)).toEqual(["p4", "p1"]);
    expect(promoted.cells[2].rect).toEqual(first.cells[2].rect);
    expect(promoted.overflow?.count).toBe(5);
    // A second surface does not inherit the first surface's occupied slots.
    value.speaking = new Set();
    expect(pipLayoutCells(value, 900, 500).stripState.ids).toEqual(["p0", "p1"]);
    expect(pipLayoutCells(value, 900, 750, promoted.stripState).stripState.ids.slice(0, 2)).toEqual(["p4", "p1"]);
    value.tiles = value.tiles.filter((tile) => tile.id !== "p4");
    expect(pipLayoutCells(value, 900, 500, promoted.stripState).stripState.ids).toEqual(["p0", "p1"]);
    value.prefs.strip = "hidden";
    const hidden = pipLayoutCells(value, 900, 500, promoted.stripState);
    expect(hidden.stripState.ids).toEqual([]);
    expect(hidden.cells.map((cell) => cell.tile.id)).toEqual(["screen"]);
  });
});
