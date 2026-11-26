import { beforeEach, describe, expect, it } from "vitest";

// The suite runs without a DOM; the prefs only need getItem/setItem.
const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
};

const {
  PICTURE_KEYS,
  pictureChanged,
  pictureConstraints,
  pictureControls,
  resetPicture,
  restorePicture,
  setPicture,
} = await import("./camera-picture");
const { CAMERA_PICTURE_KEYS, loadAudioPrefs, saveAudioPrefs } = await import(
  "./transport/audio-prefs"
);

/** A camera track that keeps what it is told, within its ranges. */
function camera(
  deviceId: string,
  caps: Record<string, unknown>,
  settings: Record<string, unknown>
) {
  const state: Record<string, unknown> = { ...settings, deviceId };
  const applied: Record<string, unknown>[] = [];
  const track = {
    getCapabilities: () => caps,
    getSettings: () => ({ ...state }),
    applyConstraints: async (c: { advanced: Record<string, unknown>[] }) => {
      for (const set of c.advanced) {
        applied.push(set);
        Object.assign(state, set);
      }
    },
  } as unknown as MediaStreamTrack;
  return { track, applied, state };
}

const webcam = () =>
  camera(
    "cam-1",
    {
      brightness: { min: 0, max: 255, step: 1 },
      contrast: { min: 0, max: 100, step: 1 },
      saturation: { min: 0, max: 200, step: 1 },
      exposureMode: ["manual", "continuous"],
      exposureTime: { min: 3, max: 2047, step: 1 },
    },
    { brightness: 128, contrast: 50, saturation: 100, exposureMode: "continuous", exposureTime: 250 }
  );

beforeEach(() => backing.clear());

describe("which controls a camera has", () => {
  it("lists what the camera offers, where it is now", () => {
    const { track } = webcam();
    expect(pictureControls(track).map((c) => [c.label, c.value])).toEqual([
      ["Brightness", 128],
      ["Contrast", 50],
      ["Saturation", 100],
      ["Exposure", 250],
    ]);
  });

  it("one exposure control: compensation over time", () => {
    const { track } = camera(
      "phone",
      {
        exposureCompensation: { min: -2, max: 2, step: 0.1 },
        exposureMode: ["manual", "continuous"],
        exposureTime: { min: 1, max: 100, step: 1 },
      },
      { exposureCompensation: 0 }
    );
    expect(pictureControls(track).map((c) => c.key)).toEqual(["exposureCompensation"]);
  });

  it("nothing from a browser that offers nothing, or an empty range", () => {
    expect(pictureControls(camera("a", {}, {}).track)).toEqual([]);
    expect(pictureControls(camera("b", { brightness: { min: 5, max: 5 } }, {}).track)).toEqual([]);
    const throws = { getCapabilities: () => { throw new Error("no"); }, getSettings: () => ({}) };
    expect(pictureControls(throws as unknown as MediaStreamTrack)).toEqual([]);
  });

  it("an exposure time without a manual mode cannot hold, so is not offered", () => {
    const { track } = camera("c", { exposureTime: { min: 1, max: 9 }, exposureMode: ["continuous"] }, {});
    expect(pictureControls(track)).toEqual([]);
  });
});

describe("changing and keeping the picture", () => {
  it("an exposure time turns the automatic exposure off", () => {
    expect(pictureConstraints({ exposureTime: 100 })).toEqual({ exposureTime: 100, exposureMode: "manual" });
    expect(pictureConstraints({ brightness: 1 })).toEqual({ brightness: 1 });
  });

  it("a change is applied and kept for the camera, then put back when it opens again", async () => {
    const first = webcam();
    await restorePicture(first.track);
    expect(first.applied).toEqual([]);
    await setPicture(first.track, "brightness", 200);
    expect(first.state.brightness).toBe(200);
    expect(pictureChanged(first.track)).toBe(true);

    const again = webcam();
    await restorePicture(again.track);
    expect(again.state.brightness).toBe(200);
  });

  it("only the latest of a burst of slider moves is applied after the one in flight", async () => {
    const { track, applied } = webcam();
    const a = setPicture(track, "brightness", 10);
    void setPicture(track, "brightness", 20);
    void setPicture(track, "brightness", 30);
    await a;
    expect(applied.map((s) => s.brightness)).toEqual([10, 30]);
  });

  it("reset goes back to the camera's values from the first time it was seen", async () => {
    const first = webcam();
    await restorePicture(first.track);
    await setPicture(first.track, "brightness", 220);
    await setPicture(first.track, "exposureTime", 900);
    expect(first.state.exposureMode).toBe("manual");

    // Opened later: the webcam kept the adjustment, as real ones do until
    // unplugged, so what it reports now is not its own default.
    const later = camera("cam-1", webcam().track.getCapabilities() as Record<string, unknown>, {
      brightness: 220,
      contrast: 50,
      saturation: 100,
      exposureMode: "manual",
      exposureTime: 900,
    });
    await restorePicture(later.track);
    await resetPicture(later.track);
    expect(later.state.brightness).toBe(128);
    // Automatic exposure back on, its time left to the camera.
    expect(later.state.exposureMode).toBe("continuous");
    expect(later.applied.at(-1)).not.toHaveProperty("exposureTime");
    expect(pictureChanged(later.track)).toBe(false);
  });

  it("a camera that refuses keeps its picture, and nothing throws", async () => {
    const { track } = webcam();
    (track as unknown as { applyConstraints: () => Promise<void> }).applyConstraints = async () => {
      throw new Error("OverconstrainedError");
    };
    await restorePicture(track);
    await expect(setPicture(track, "brightness", 3)).resolves.toBeUndefined();
    await expect(resetPicture(track)).resolves.toBeUndefined();
  });
});

describe("saved settings", () => {
  it("keep only known controls and numbers, and the newest 20 cameras", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) many[`cam-${i}`] = { values: { brightness: i }, defaults: {} };
    many["cam-24"] = {
      values: { brightness: 1, zoom: 3, contrast: "x", saturation: Infinity },
      defaults: { brightness: 0 },
      exposureMode: "continuous",
    };
    saveAudioPrefs({ cameraPicture: many as never });
    const saved = loadAudioPrefs().cameraPicture;
    expect(Object.keys(saved)).toHaveLength(20);
    expect(saved["cam-0"]).toBeUndefined();
    expect(saved["cam-24"]).toEqual({
      values: { brightness: 1 },
      defaults: { brightness: 0 },
      exposureMode: "continuous",
    });
  });

  it("the prefs know every control the picture module has", () => {
    expect([...CAMERA_PICTURE_KEYS]).toEqual([...PICTURE_KEYS]);
  });
});
