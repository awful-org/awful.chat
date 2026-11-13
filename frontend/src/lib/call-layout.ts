import type { SpotlightTile } from "./spotlight";

export interface CallLayoutPrefs {
  layout: "auto" | "spotlight" | "grid";
  strip: "auto" | "side" | "bottom" | "hidden";
  size: "s" | "m" | "l";
  people: "all" | "video" | "none";
  screens: boolean;
  apps: boolean;
  self: boolean;
  /** Custom dragged strip thickness; null follows S/M/L. */
  stripPx: number | null;
}

export const DEFAULT_CALL_LAYOUT: CallLayoutPrefs = {
  layout: "auto", strip: "auto", size: "m", people: "all",
  screens: true, apps: true, self: true, stripPx: null,
};

/** Stored choices are untrusted (including preferences from newer versions). */
export function parseCallLayout(raw: string | null): CallLayoutPrefs {
  const prefs = { ...DEFAULT_CALL_LAYOUT };
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return prefs;
    for (const key of ["layout", "strip", "size", "people"] as const) {
      const options = {
        layout: ["auto", "spotlight", "grid"], strip: ["auto", "side", "bottom", "hidden"],
        size: ["s", "m", "l"], people: ["all", "video", "none"],
      };
      if (options[key].includes(value[key])) Object.assign(prefs, { [key]: value[key] });
    }
    for (const key of ["screens", "apps", "self"] as const) {
      if (typeof value[key] === "boolean") prefs[key] = value[key];
    }
    if (typeof value.stripPx === "number" && Number.isFinite(value.stripPx)) prefs.stripPx = Math.max(64, Math.min(480, value.stripPx));
  } catch { /* Corrupt or unavailable storage uses defaults. */ }
  return prefs;
}

export function filterCallTiles<T extends SpotlightTile>(tiles: T[], prefs: CallLayoutPrefs): T[] {
  return tiles.filter((tile) => {
    if (tile.kind === "plugin") return prefs.apps;
    if (tile.kind !== "camera") return prefs.screens;
    if (tile.isLocal && !prefs.self) return false;
    return prefs.people === "all" || (prefs.people === "video" && tile.videoTrack !== null);
  });
}

/** Explicit pins override Auto, but Grid always means equal tiles. */
export function callLayoutGroups<T extends SpotlightTile>(
  tiles: T[], prefs: CallLayoutPrefs, pin: string | null, speaker: string | null,
  _speaking: ReadonlySet<string>,
): { main: T[]; strip: T[]; grid: boolean } {
  const pinned = tiles.find((t) => t.id === pin);
  const content = tiles.filter((t) => t.kind !== "camera");
  if (prefs.layout === "grid" || (prefs.layout === "auto" && !pinned && !content.length)) {
    return { main: tiles, strip: [], grid: true };
  }
  const main = pinned ? [pinned] : prefs.layout === "auto" && content.length
    ? content.slice(0, 2)
    : [tiles.find((t) => t.id === speaker) ?? content[0] ?? tiles[0]].filter((t): t is T => !!t);
  const ids = new Set(main.map((t) => t.id));
  // Speaker promotion belongs to the capacity-aware, stateful strip selector.
  const strip = tiles.filter((t) => !ids.has(t.id));
  return { main, strip, grid: false };
}

export interface CameraStripState {
  ids: string[];
  recent: ReadonlyMap<string, number>;
  clock: number;
}

export function createCameraStripState(): CameraStripState {
  return { ids: [], recent: new Map(), clock: 0 };
}

/** One independent state per surface. Never reorder an occupied visible slot.
 * Offscreen speakers replace idle cameras, never other active speakers, so
 * held speaking rings cannot bounce overlapping speakers in and out. If all
 * slots are speaking, an offscreen speaker waits until an idle slot exists.
 */
export function selectCameraStrip<T extends SpotlightTile>(
  previous: CameraStripState, tiles: T[], capacity: number,
  speaking: ReadonlySet<string>, lastSpokeAt?: ReadonlyMap<string, number>,
): CameraStripState {
  const count = Math.max(0, Math.min(tiles.length, Math.floor(capacity)));
  if (!count) return createCameraStripState();
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const active = new Set(tiles.filter((tile) => tile.kind === "camera" && speaking.has(tile.peerId)).map((tile) => tile.peerId));
  const clock = previous.clock + 1;
  const recent = new Map(tiles.filter((tile) => tile.kind === "camera").map((tile) => [
    tile.peerId, active.has(tile.peerId) ? clock : previous.recent.get(tile.peerId) ?? -Infinity,
  ]));
  // Fill departures in place, then append on growth. Fresh track/profile
  // objects and changes in source order do not affect the occupied slots.
  const ids = previous.ids.slice(0, count).map((id) => byId.has(id) ? id : "");
  while (ids.length < count) ids.push("");
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) ids[i] = tiles.find((tile) => !ids.includes(tile.id))!.id;
  }
  const last = (peerId: string) => lastSpokeAt ? lastSpokeAt.get(peerId) ?? -Infinity : recent.get(peerId) ?? -Infinity;
  for (const tile of tiles) {
    if (tile.kind !== "camera" || !active.has(tile.peerId) || ids.includes(tile.id)) continue;
    let victim = -1;
    for (let i = 0; i < ids.length; i++) {
      const occupant = byId.get(ids[i])!;
      // Never evict shared content or another currently speaking camera.
      if (occupant.kind !== "camera" || active.has(occupant.peerId)) continue;
      if (victim < 0 || last(occupant.peerId) < last(byId.get(ids[victim])!.peerId)) victim = i;
    }
    if (victim >= 0) ids[victim] = tile.id;
  }
  return { ids, recent, clock };
}

export interface LayoutRect { x: number; y: number; w: number; h: number }

/** Equal cells, with the incomplete last row centred just like the mockup. */
export function callGridRects(count: number, width: number, height: number): LayoutRect[] {
  const cols = Math.min(count, count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4);
  if (!cols) return [];
  const rows = Math.ceil(count / cols);
  const w = Math.max(0, (width - 8 * (cols - 1)) / cols);
  const h = Math.max(0, (height - 8 * (rows - 1)) / rows);
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, count - row * cols);
    return { x: (width - (inRow * w + (inRow - 1) * 8)) / 2 + (i % cols) * (w + 8), y: row * (h + 8), w, h };
  });
}

export function cameraStripGeometry(width: number, height: number, prefs: CallLayoutPrefs, count: number, phone = false) {
  const position = prefs.strip === "auto" ? (width >= 800 ? "side" : "bottom") : prefs.strip;
  const side = position === "side";
  const nominal = prefs.stripPx ?? (side ? { s: 168, m: 224, l: 296 }[prefs.size] : phone ? { s: 96, m: 112, l: 144 }[prefs.size] : { s: 96, m: 128, l: 168 }[prefs.size]);
  // A portrait/narrow PiP must fit at least one complete tile (or +N cell)
  // along the strip too, not only reserve enough room for the main content.
  const crossLimit = side ? height * 16 / 9 : phone ? width / 0.75 : width * 9 / 16;
  const thickness = Math.max(0, Math.min(nominal, (side ? width : height) * 0.45, crossLimit));
  const tileW = phone && !side ? thickness * 0.75 : side ? thickness : thickness * 16 / 9;
  const tileH = side ? thickness * 9 / 16 : thickness;
  const span = side ? height : width;
  const fits = Math.max(1, Math.floor((span + 8) / ((side ? tileH : tileW) + 8)));
  const hidden = position === "hidden" || count === 0;
  const scroll = phone && !side;
  const shown = hidden ? 0 : scroll ? count : count > fits ? Math.max(0, fits - 1) : count;
  return {
    position, side, tileW, tileH, shown, scroll,
    more: hidden || scroll ? 0 : count - shown,
    mainW: Math.max(0, width - (!hidden && side ? thickness + 8 : 0)),
    mainH: Math.max(0, height - (!hidden && !side ? tileH + 8 : 0)),
  };
}
