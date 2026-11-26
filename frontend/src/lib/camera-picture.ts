/**
 * The camera's own picture controls: brightness, contrast, saturation and
 * exposure.
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
 */

import { loadAudioPrefs, saveAudioPrefs, type CameraPicture } from "$lib/transport/audio-prefs";

export const PICTURE_KEYS = [
  "brightness",
  "contrast",
  "saturation",
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
  exposureCompensation: "Exposure",
  exposureTime: "Exposure",
};

// Not in every TypeScript DOM library yet.
type Range = { min?: number; max?: number; step?: number };
type Capabilities = Partial<Record<PictureKey, Range>> & { exposureMode?: string[] };
type Settings = Partial<Record<PictureKey, number>> & { exposureMode?: string; deviceId?: string };

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
 * The controls this camera offers, with where each is now. One exposure
 * control at most: compensation where there is one (it steers the camera's
 * automatic exposure), the exposure time otherwise (which turns the
 * automatic exposure off while it is set).
 */
export function pictureControls(track: MediaStreamTrack): PictureControl[] {
  const caps = capabilitiesOf(track);
  const now = settingsOf(track);
  const keys = PICTURE_KEYS.filter(
    (k) => k !== "exposureTime" || !usable(caps.exposureCompensation)
  ).filter((k) => k !== "exposureTime" || (caps.exposureMode ?? []).includes("manual"));
  const out: PictureControl[] = [];
  for (const key of keys) {
    const range = caps[key];
    if (!usable(range)) continue;
    const step = range.step && range.step > 0 ? range.step : (range.max - range.min) / 100;
    out.push({
      key,
      label: LABELS[key],
      min: range.min,
      max: range.max,
      step,
      value: clamp(now[key] ?? (range.min + range.max) / 2, range.min, range.max),
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

/** The constraints that put the camera at these values. */
export function pictureConstraints(
  values: PictureValues,
  exposureMode?: string
): MediaTrackConstraintSet {
  const set: Record<string, unknown> = { ...values };
  // An exposure time only holds with the automatic exposure off.
  if (values.exposureTime !== undefined) set.exposureMode = "manual";
  else if (exposureMode) set.exposureMode = exposureMode;
  return set as MediaTrackConstraintSet;
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

/**
 * For a camera just opened: note its own values the first time it is seen,
 * then put back what was chosen for it last time. Never throws: a camera
 * that refuses keeps its picture as it is.
 */
export async function restorePicture(track: MediaStreamTrack): Promise<void> {
  const { deviceId } = settingsOf(track);
  if (!deviceId) return;
  const saved = savedFor(deviceId);
  if (!saved) {
    const controls = pictureControls(track);
    if (controls.length === 0) return;
    const defaults: PictureValues = {};
    for (const c of controls) defaults[c.key] = c.value;
    save(deviceId, { values: {}, defaults, exposureMode: settingsOf(track).exposureMode });
    return;
  }
  if (Object.keys(saved.values).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [pictureConstraints(saved.values)] });
  } catch {
    // Another camera behind the same id, or one that changed its mind.
  }
}

/**
 * Change one control now and remember it. Moves of a slider come faster
 * than a camera takes them, so only the latest waiting value is applied
 * once the one in flight is done.
 */
const pending = new WeakMap<MediaStreamTrack, PictureValues>();
const running = new WeakSet<MediaStreamTrack>();

export async function setPicture(
  track: MediaStreamTrack,
  key: PictureKey,
  value: number
): Promise<void> {
  const { deviceId } = settingsOf(track);
  if (deviceId) {
    const saved = savedFor(deviceId) ?? { values: {}, defaults: {} };
    save(deviceId, { ...saved, values: { ...saved.values, [key]: value } });
  }
  pending.set(track, { ...pending.get(track), [key]: value });
  if (running.has(track)) return;
  running.add(track);
  try {
    for (let next = pending.get(track); next; next = pending.get(track)) {
      pending.delete(track);
      try {
        await track.applyConstraints({ advanced: [pictureConstraints(next)] });
      } catch {
        // Out of range for a camera that narrowed it, or one gone away.
      }
    }
  } finally {
    running.delete(track);
  }
}

/** Back to what the camera had the first time it was seen here. */
export async function resetPicture(track: MediaStreamTrack): Promise<void> {
  const { deviceId } = settingsOf(track);
  const saved = savedFor(deviceId);
  if (!deviceId || !saved) return;
  save(deviceId, { ...saved, values: {} });
  const defaults = { ...saved.defaults };
  // Back to automatic exposure, if that is how it started: its time is the
  // camera's to choose then.
  if (saved.exposureMode && saved.exposureMode !== "manual") delete defaults.exposureTime;
  try {
    await track.applyConstraints({
      advanced: [pictureConstraints(defaults, saved.exposureMode)],
    });
  } catch {
    // Keeps whatever it has.
  }
}

/** Whether anything is changed from the camera's own values. */
export function pictureChanged(track: MediaStreamTrack): boolean {
  const saved = savedFor(settingsOf(track).deviceId);
  return !!saved && Object.keys(saved.values).length > 0;
}
