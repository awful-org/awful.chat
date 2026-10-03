/**
 * Where the joined plugin tiles sit inside the call panel.
 *
 * A joined plugin's content mounts once in a floating layer over the panel
 * and follows its placeholder tile (VoiceVideoCallView's persistent plugin
 * layer). Following it used to mean a getBoundingClientRect per tile on every
 * animation frame for the whole call. These pieces let the stage measure only
 * when the layout can have moved, and stop again once it is still.
 */

/** A tile's box, relative to the call panel. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every joined plugin tile's box, by tile id. Null for a tile filtered out of
 * the grid: its content stays mounted, hidden, so the party's audio plays on.
 */
export type TileRects = Record<string, TileRect | null>;

/** Same tiles in the same boxes: four number compares each, no serializing. */
export function sameTileRects(a: TileRects, b: TileRects): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const x = a[key];
    const y = b[key];
    if (x === null || y === null) return x === y;
    return (
      y !== undefined && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h
    );
  });
}

/**
 * Frames the boxes must hold still before measuring stops. Anything that
 * resizes keeps poking while it moves (a ResizeObserver fires every frame of
 * a height transition), so this only has to cover a layout that settles a
 * frame or two after the change that caused it.
 */
export const SETTLE_FRAMES = 10;

/**
 * Measures on animation frames while the layout may still be moving.
 *
 * poke() asks for a measurement on the next frame. Measuring then continues
 * frame by frame until `measure` has reported no change SETTLE_FRAMES times
 * in a row, and stops. Pokes while it runs only restart that count, so a
 * burst of them costs one frame each, and at rest nothing is scheduled.
 */
export class SettlingMeasure {
  readonly #measure: () => boolean;
  readonly #raf: (cb: () => void) => number;
  readonly #caf: (id: number) => void;
  #frame: number | null = null;
  #still = 0;

  /**
   * @param measure Reads the layout; true when something moved.
   * @param raf/caf The frame clock, for tests. The browser's by default.
   */
  constructor(
    measure: () => boolean,
    raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
    caf: (id: number) => void = (id) => cancelAnimationFrame(id)
  ) {
    this.#measure = measure;
    this.#raf = raf;
    this.#caf = caf;
  }

  poke(): void {
    this.#still = 0;
    if (this.#frame === null) this.#frame = this.#raf(this.#tick);
  }

  stop(): void {
    if (this.#frame !== null) this.#caf(this.#frame);
    this.#frame = null;
  }

  #tick = (): void => {
    this.#frame = null;
    if (this.#measure()) this.#still = 0;
    else this.#still++;
    if (this.#still < SETTLE_FRAMES) this.#frame = this.#raf(this.#tick);
  };
}
