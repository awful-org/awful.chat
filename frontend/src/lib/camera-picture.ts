/**
 * The camera's own picture controls: brightness, contrast, saturation,
 * warmth (its white balance) and exposure.
 *
 * These are the camera's settings, changed through the track
 * (applyConstraints), not a filter drawn over the video: they cost nothing,
 * and what the camera makes is what everyone in the call sees. Which ones
 * there are depends on the camera and the browser. Chrome offers them for
 * most webcams on Windows and Linux, and exposure on Android; Firefox and
 * Safari offer none. Only what the track says it can do is shown.
 *
 * Saved per camera (by deviceId), with the values the camera had the first
 * time it was seen here, so Reset can go back to them. A webcam keeps its
 * settings until it is unplugged, so what it reports when opened later can
 * be an earlier adjustment rather than its own default.
 *
 * Each control is applied in a set of its own. Chrome applies a set whole or
 * not at all, and resolves either way: in one set, a single value the camera
 * no longer takes (a range that changed with its mode) silently kept all
 * the others from being applied.
 */

import { loadAudioPrefs, saveAudioPrefs, type CameraPicture } from "$lib/transport/audio-prefs";

export const PICTURE_KEYS = [
  "brightness",
  "contrast",
  "saturation",
  "colorTemperature",
  "exposureCompensation",
  "exposureTime",
] as const;
export type PictureKey = (typeof PICTURE_KEYS)[number];
export type PictureValues = Partial<Record<PictureKey, number>>;

export interface PictureControl {
  key: PictureKey;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

const LABELS: Record<PictureKey, string> = {
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  colorTemperature: "Warmth",
  exposureCompensation: "Exposure",
  exposureTime: "Exposure",
};

/** A camera's automatic modes, each of which a control set by hand turns off. */
export type ModeKey = "exposureMode" | "whiteBalanceMode";

/**
 * The controls that hold only with their automatic mode off: an exposure
 * time while automatic exposure runs, or a white balance while automatic
 * white balance does, is overridden by the camera at once. Each is sent with
 * its mode set to manual, offered only where the camera has that mode, and
 * has an Auto to go back.
 *
 * A white balance is a colour temperature in kelvin: the light the camera
 * takes the room to be lit by. Set higher than the room's, it corrects for
 * a bluer light than there is, so the picture comes out warmer: the slider's
 * right is warmer, as its name says.
 */
export const MODE_OF = {
  exposureTime: "exposureMode",
  colorTemperature: "whiteBalanceMode",
} as const satisfies Partial<Record<PictureKey, ModeKey>>;
export type ManualKey = keyof typeof MODE_OF;

function modeOf(key: PictureKey): ModeKey | undefined {
  return (MODE_OF as Partial<Record<PictureKey, ModeKey>>)[key];
}

// Not in every TypeScript DOM library yet.
type Range = { min?: number; max?: number; step?: number };
type Capabilities = Partial<Record<PictureKey, Range>> & Partial<Record<ModeKey, string[]>>;
type Settings = Partial<Record<PictureKey, number>> &
  Partial<Record<ModeKey, string>> & {
    deviceId?: string;
    frameRate?: number;
  };

function capabilitiesOf(track: MediaStreamTrack): Capabilities {
  try {
    return (track.getCapabilities?.() ?? {}) as Capabilities;
  } catch {
    return {};
  }
}

function settingsOf(track: MediaStreamTrack): Settings {
  return track.getSettings() as Settings;
}

/**
 * Chrome on Windows hands the camera's GAIN over as exposure compensation:
 * more noise, or nothing at all while the automatic exposure runs. There,
 * the exposure time is the exposure control.
 */
export function onWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * The controls this camera offers, with where each is now. One exposure
 * control at most: compensation where it is real (it steers the camera's
 * automatic exposure), the exposure time otherwise.
 *
 * An exposure time is in units of 100 microseconds, and one longer than a
 * frame makes most webcams drop their frame rate to fit it: the slider
 * stops at one frame's time.
 */
export function pictureControls(
  track: MediaStreamTrack,
  windows = onWindows()
): PictureControl[] {
  const caps = capabilitiesOf(track);
  const now = settingsOf(track);
  const compensation = !windows && usable(caps.exposureCompensation);
  const out: PictureControl[] = [];
  for (const key of PICTURE_KEYS) {
    if (key === "exposureCompensation" && !compensation) continue;
    if (key === "exposureTime" && compensation) continue;
    const mode = modeOf(key);
    if (mode && !(caps[mode] ?? []).includes("manual")) continue;
    const range = caps[key];
    if (!usable(range)) continue;
    let { min, max } = range;
    if (key === "exposureTime" && now.frameRate && now.frameRate > 0) {
      const frame = Math.floor(10_000 / now.frameRate);
      if (frame > min) max = Math.min(max, frame);
    }
    const step = range.step && range.step > 0 ? range.step : (max - min) / 100;
    out.push({
      key,
      label: LABELS[key],
      min,
      max,
      step,
      value: clamp(now[key] ?? (min + max) / 2, min, max),
    });
  }
  return out;
}

function usable(r: Range | undefined): r is Required<Pick<Range, "min" | "max">> & Range {
  return (
    !!r &&
    typeof r.min === "number" &&
    typeof r.max === "number" &&
    Number.isFinite(r.min) &&
    Number.isFinite(r.max) &&
    r.max > r.min
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * The constraint sets that put the camera at these values, one per
 * control. A control that needs a manual mode (MODE_OF) goes with it, in
 * the same set. `modes` are modes to set on their own (Reset, Auto), each
 * sent only if its control is not being set and the camera offers that
 * mode: Chrome on Linux reports "none" for a camera without automatic
 * exposure, which no set may name.
 */
export function pictureSets(
  values: PictureValues,
  caps: Capabilities = {},
  modes: Partial<Record<ModeKey, string>> = {}
): MediaTrackConstraintSet[] {
  const sets: Record<string, unknown>[] = [];
  for (const key of PICTURE_KEYS) {
    const v = values[key];
    if (v === undefined) continue;
    const mode = modeOf(key);
    sets.push(mode ? { [mode]: "manual", [key]: v } : { [key]: v });
  }
  for (const [key, mode] of Object.entries(MODE_OF) as [ManualKey, ModeKey][]) {
    const want = modes[mode];
    if (want && values[key] === undefined && (caps[mode] ?? []).includes(want)) {
      sets.push({ [mode]: want });
    }
  }
  return sets as MediaTrackConstraintSet[];
}

/** The camera's modes as they are now, to keep for Reset. */
function modesOf(s: Settings): Pick<CameraPicture, ModeKey> {
  const out: Pick<CameraPicture, ModeKey> = {};
  if (s.exposureMode) out.exposureMode = s.exposureMode;
  if (s.whiteBalanceMode) out.whiteBalanceMode = s.whiteBalanceMode;
  return out;
}

/** What is saved for this track's camera, if anything. */
function savedFor(deviceId: string | undefined): CameraPicture | undefined {
  return deviceId ? loadAudioPrefs().cameraPicture[deviceId] : undefined;
}

function save(deviceId: string, entry: CameraPicture): void {
  const all = { ...loadAudioPrefs().cameraPicture };
  // Newest last, so the oldest is the one dropped when the list is full.
  delete all[deviceId];
  all[deviceId] = entry;
  saveAudioPrefs({ cameraPicture: all });
}

// Everything done to one camera's track happens in order: a slider move
// sent just before Reset must not land after it.
const queue = new WeakMap<MediaStreamTrack, Promise<void>>();

function enqueue(track: MediaStreamTrack, job: () => Promise<void>): Promise<void> {
  const done = (queue.get(track) ?? Promise.resolve()).then(job).catch(() => {});
  queue.set(track, done);
  return done;
}

async function apply(track: MediaStreamTrack, sets: MediaTrackConstraintSet[]): Promise<void> {
  if (sets.length === 0) return;
  try {
    await track.applyConstraints({ advanced: sets });
  } catch {
    // A camera that went away or refuses: it keeps what it has.
  }
}

/**
 * For a camera just opened: note its own values the first time it is seen,
 * then put back what was chosen for it last time. Never throws: a camera
 * that refuses keeps its picture as it is.
 */
export function restorePicture(track: MediaStreamTrack): Promise<void> {
  const { deviceId } = settingsOf(track);
  if (!deviceId) return Promise.resolve();
  const saved = savedFor(deviceId);
  if (!saved) {
    const controls = pictureControls(track);
    if (controls.length === 0) return Promise.resolve();
    const defaults: PictureValues = {};
    for (const c of controls) defaults[c.key] = c.value;
    save(deviceId, { values: {}, defaults, ...modesOf(settingsOf(track)) });
    return Promise.resolve();
  }
  // A control with no value of its own noted yet (one added since this
  // camera was first seen, or one it offers only in another browser): its
  // value now is the camera's own, as long as it was never set here. Without
  // it Reset would leave that control where it was moved to.
  const filled = backfill(track, saved);
  if (filled) save(deviceId, filled);
  return enqueue(track, () => apply(track, pictureSets(saved.values)));
}

function backfill(track: MediaStreamTrack, saved: CameraPicture): CameraPicture | null {
  const now = settingsOf(track);
  const defaults = { ...saved.defaults };
  const modes: Pick<CameraPicture, ModeKey> = {};
  let changed = false;
  for (const c of pictureControls(track)) {
    if (c.key in defaults || c.key in saved.values) continue;
    defaults[c.key] = c.value;
    changed = true;
  }
  for (const [key, mode] of Object.entries(MODE_OF) as [ManualKey, ModeKey][]) {
    if (saved[mode] || key in saved.values || !now[mode]) continue;
    modes[mode] = now[mode];
    changed = true;
  }
  return changed ? { ...saved, ...modes, defaults } : null;
}

/**
 * Change one control now and remember it. Moves of a slider come faster
 * than a camera takes them: they gather while one is being applied, and the
 * latest of each control goes next.
 */
const pending = new WeakMap<MediaStreamTrack, PictureValues>();
const scheduled = new WeakSet<MediaStreamTrack>();

export function setPicture(track: MediaStreamTrack, key: PictureKey, value: number): Promise<void> {
  const { deviceId } = settingsOf(track);
  if (deviceId) {
    const saved = savedFor(deviceId) ?? { values: {}, defaults: {} };
    save(deviceId, { ...saved, values: { ...saved.values, [key]: value } });
  }
  pending.set(track, { ...pending.get(track), [key]: value });
  if (scheduled.has(track)) return queue.get(track) ?? Promise.resolve();
  scheduled.add(track);
  return enqueue(track, async () => {
    scheduled.delete(track);
    const values = pending.get(track);
    pending.delete(track);
    if (values) await apply(track, pictureSets(values));
  });
}

/** Back to what the camera had the first time it was seen here. */
export function resetPicture(track: MediaStreamTrack): Promise<void> {
  const { deviceId } = settingsOf(track);
  const saved = savedFor(deviceId);
  pending.delete(track);
  if (!deviceId || !saved) return queue.get(track) ?? Promise.resolve();
  save(deviceId, { ...saved, values: {} });
  const defaults = { ...saved.defaults };
  // Back to an automatic mode, where that is how it started: its value is
  // the camera's to choose then.
  const modes: Partial<Record<ModeKey, string>> = {};
  for (const [key, mode] of Object.entries(MODE_OF) as [ManualKey, ModeKey][]) {
    const was = saved[mode];
    if (!was) continue;
    modes[mode] = was;
    if (was !== "manual") delete defaults[key];
  }
  const caps = capabilitiesOf(track);
  return enqueue(track, () => apply(track, pictureSets(defaults, caps, modes)));
}

/** Whether this control is set by hand, and so its automatic mode off. */
export function byHand(track: MediaStreamTrack, key: ManualKey): boolean {
  return savedFor(settingsOf(track).deviceId)?.values[key] !== undefined;
}

/**
 * This control's automatic mode back on, keeping every other control as it
 * is. Only where the camera has an automatic mode for it.
 */
export function autoMode(track: MediaStreamTrack, key: ManualKey): Promise<void> {
  const caps = capabilitiesOf(track);
  const { deviceId } = settingsOf(track);
  const saved = savedFor(deviceId);
  const p = pending.get(track);
  if (p) delete p[key];
  if (deviceId && saved) {
    const values = { ...saved.values };
    delete values[key];
    save(deviceId, { ...saved, values });
  }
  return enqueue(track, () =>
    apply(track, pictureSets({}, caps, { [MODE_OF[key]]: "continuous" }))
  );
}

/** Whether the camera is choosing this control itself now (its automatic mode). */
export function isAuto(track: MediaStreamTrack, key: ManualKey): boolean {
  const mode = settingsOf(track)[MODE_OF[key]];
  return !!mode && mode !== "manual" && mode !== "none";
}

/** Whether this camera has an automatic mode for this control to go back to. */
export function hasAuto(track: MediaStreamTrack, key: ManualKey): boolean {
  return (capabilitiesOf(track)[MODE_OF[key]] ?? []).includes("continuous");
}

/** Whether anything is changed from the camera's own values. */
export function pictureChanged(track: MediaStreamTrack): boolean {
  const saved = savedFor(settingsOf(track).deviceId);
  return !!saved && Object.keys(saved.values).length > 0;
}
