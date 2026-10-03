import { describe, expect, it, vi } from "vitest";
import {
  SETTLE_FRAMES,
  SettlingMeasure,
  sameTileRects,
  type TileRects,
} from "./call-tile-rects";

/** A frame clock the test advances by hand. */
function frames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    raf: (cb: () => void) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    caf: (id: number) => void pending.delete(id),
    /** Run one frame; false when none was asked for. */
    step(): boolean {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb();
      return due.length > 0;
    },
    get pending() {
      return pending.size;
    },
  };
}

describe("sameTileRects", () => {
  const box = { x: 1, y: 2, w: 3, h: 4 };

  it("is true for the same tiles in the same boxes", () => {
    expect(sameTileRects({ a: box, b: null }, { a: { ...box }, b: null })).toBe(true);
  });

  it("notices a move, a resize, a tile hidden and a tile gone", () => {
    expect(sameTileRects({ a: box }, { a: { ...box, x: 9 } })).toBe(false);
    expect(sameTileRects({ a: box }, { a: { ...box, h: 9 } })).toBe(false);
    expect(sameTileRects({ a: box }, { a: null })).toBe(false);
    expect(sameTileRects({ a: box }, { b: box })).toBe(false);
    expect(sameTileRects({ a: box } as TileRects, {})).toBe(false);
  });
});

describe("SettlingMeasure", () => {
  it("schedules nothing until something can have moved", () => {
    const clock = frames();
    const measure = vi.fn(() => false);
    new SettlingMeasure(measure, clock.raf, clock.caf);

    // The old loop measured every frame for the whole call, moving or not.
    expect(clock.pending).toBe(0);
    expect(clock.step()).toBe(false);
    expect(measure).not.toHaveBeenCalled();
  });

  it("measures after a poke until the layout holds still, then stops", () => {
    const clock = frames();
    let moves = 3;
    const measure = vi.fn(() => moves-- > 0);
    const settle = new SettlingMeasure(measure, clock.raf, clock.caf);

    settle.poke();
    let ran = 0;
    while (clock.step()) ran++;

    // Three frames that moved, then SETTLE_FRAMES still ones, then quiet.
    expect(ran).toBe(3 + SETTLE_FRAMES);
    expect(measure).toHaveBeenCalledTimes(3 + SETTLE_FRAMES);
    expect(clock.pending).toBe(0);
  });

  it("folds a burst of pokes into one frame at a time", () => {
    const clock = frames();
    const measure = vi.fn(() => false);
    const settle = new SettlingMeasure(measure, clock.raf, clock.caf);

    // A ResizeObserver and a scroll can both fire within one frame.
    settle.poke();
    settle.poke();
    settle.poke();
    expect(clock.pending).toBe(1);

    clock.step();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("starts the count again when poked while settling", () => {
    const clock = frames();
    const measure = vi.fn(() => false);
    const settle = new SettlingMeasure(measure, clock.raf, clock.caf);

    settle.poke();
    for (let i = 0; i < SETTLE_FRAMES - 1; i++) clock.step();
    settle.poke();
    let ran = 0;
    while (clock.step()) ran++;

    expect(ran).toBe(SETTLE_FRAMES);
  });

  it("stop() cancels the frame it asked for", () => {
    const clock = frames();
    const measure = vi.fn(() => true);
    const settle = new SettlingMeasure(measure, clock.raf, clock.caf);

    settle.poke();
    settle.stop();

    expect(clock.step()).toBe(false);
    expect(measure).not.toHaveBeenCalled();
  });
});
