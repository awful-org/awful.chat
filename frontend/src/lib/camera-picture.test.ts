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
  autoMode,
  byHand,
  pictureChanged,
  pictureSets,
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
    // Like Chrome: each set whole or not at all, and resolved either way.
    applyConstraints: async (c: { advanced: Record<string, unknown>[] }) => {
      for (const set of c.advanced) {
        const ok = Object.entries(set).every(([k, v]) => {
          const cap = caps[k];
          if (Array.isArray(cap)) return cap.includes(v);
          const r = cap as { min?: number; max?: number } | undefined;
          return !!r && typeof v === "number" && v >= (r.min ?? -Infinity) && v <= (r.max ?? Infinity);
        });
        if (!ok) continue;
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
    expect(pictureControls(track, false).map((c) => [c.label, c.value])).toEqual([
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
    expect(pictureControls(track, false).map((c) => c.key)).toEqual(["exposureCompensation"]);
  });

  it("on Windows, where compensation is the camera's gain, the exposure time instead", () => {
    const { track } = camera(
      "win",
      {
        exposureCompensation: { min: 0, max: 255, step: 1 },
        exposureMode: ["manual", "continuous"],
        exposureTime: { min: 1, max: 10000, step: 1 },
      },
      { exposureCompensation: 0, exposureTime: 100 }
    );
    expect(pictureControls(track, true).map((c) => c.key)).toEqual(["exposureTime"]);
  });

  it("an exposure time stops at one frame's time, so the frame rate holds", () => {
    const { track } = camera(
      "linux",
      { exposureMode: ["manual", "continuous"], exposureTime: { min: 3, max: 2047, step: 1 } },
      { exposureTime: 156, frameRate: 30 }
    );
    expect(pictureControls(track, false)[0].max).toBe(333);
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
  it("one set per control; an exposure time with its manual mode", () => {
    expect(pictureSets({ brightness: 1, exposureTime: 100 })).toEqual([
      { brightness: 1 },
      { exposureMode: "manual", exposureTime: 100 },
    ]);
    // A mode on its own only if the camera offers it.
    expect(pictureSets({}, { exposureMode: ["manual"] }, { exposureMode: "none" })).toEqual([]);
    expect(pictureSets({}, { exposureMode: ["continuous"] }, { exposureMode: "continuous" })).toEqual([
      { exposureMode: "continuous" },
    ]);
  });

  it("a value the camera no longer takes does not keep the others from being restored", async () => {
    const first = webcam();
    await restorePicture(first.track);
    await setPicture(first.track, "brightness", 200);
    await setPicture(first.track, "saturation", 150);
    // Opened in a mode with a narrower saturation range.
    const narrow = camera(
      "cam-1",
      { brightness: { min: 0, max: 255 }, saturation: { min: 0, max: 100 } },
      { brightness: 128, saturation: 50 }
    );
    await restorePicture(narrow.track);
    expect(narrow.state.brightness).toBe(200);
    expect(narrow.state.saturation).toBe(50);
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

  it("a burst of slider moves applies the latest", async () => {
    const { track, applied } = webcam();
    const a = setPicture(track, "brightness", 10);
    void setPicture(track, "brightness", 20);
    await setPicture(track, "brightness", 30);
    await a;
    expect(applied.map((s) => s.brightness)).toEqual([30]);
  });

  it("a move sent just before Reset does not land after it", async () => {
    const first = webcam();
    await restorePicture(first.track);
    void setPicture(first.track, "brightness", 250);
    await resetPicture(first.track);
    expect(first.state.brightness).toBe(128);
    expect(pictureChanged(first.track)).toBe(false);
  });

  it("Auto turns automatic exposure back on and keeps the rest", async () => {
    const first = webcam();
    await restorePicture(first.track);
    await setPicture(first.track, "brightness", 200);
    await setPicture(first.track, "exposureTime", 300);
    expect(byHand(first.track, "exposureTime")).toBe(true);
    await autoMode(first.track, "exposureTime");
    expect(first.state.exposureMode).toBe("continuous");
    expect(first.state.brightness).toBe(200);
    expect(byHand(first.track, "exposureTime")).toBe(false);
    expect(pictureChanged(first.track)).toBe(true);
  });

  it("Reset with a mode the camera does not offer still restores the rest", async () => {
    const first = camera(
      "no-auto",
      { brightness: { min: 0, max: 255 }, exposureMode: ["manual"], exposureTime: { min: 1, max: 300 } },
      { brightness: 100, exposureMode: "none", exposureTime: 50 }
    );
    await restorePicture(first.track);
    await setPicture(first.track, "brightness", 10);
    await resetPicture(first.track);
    expect(first.state.brightness).toBe(100);
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

  it("warmth is the white balance, set with its manual mode, and Auto and Reset give it back", async () => {
    const warm = () =>
      camera(
        "wb",
        {
          brightness: { min: 0, max: 255, step: 1 },
          whiteBalanceMode: ["manual", "continuous"],
          colorTemperature: { min: 2800, max: 6500, step: 10 },
        },
        { brightness: 128, whiteBalanceMode: "continuous", colorTemperature: 4600 }
      );
    const first = warm();
    expect(pictureControls(first.track, false).map((c) => [c.key, c.label])).toEqual([
      ["brightness", "Brightness"],
      ["colorTemperature", "Warmth"],
    ]);
    await restorePicture(first.track);
    await setPicture(first.track, "colorTemperature", 5600);
    expect(first.applied.at(-1)).toEqual({ whiteBalanceMode: "manual", colorTemperature: 5600 });
    expect(byHand(first.track, "colorTemperature")).toBe(true);

    // Auto: the camera's white balance again, the rest kept.
    await setPicture(first.track, "brightness", 200);
    await autoMode(first.track, "colorTemperature");
    expect(first.state.whiteBalanceMode).toBe("continuous");
    expect(first.state.brightness).toBe(200);
    expect(byHand(first.track, "colorTemperature")).toBe(false);

    // Reset after a warmth set by hand: automatic white balance, as it started.
    await setPicture(first.track, "colorTemperature", 3000);
    await resetPicture(first.track);
    expect(first.state.whiteBalanceMode).toBe("continuous");
    expect(first.state.brightness).toBe(128);
    expect(first.applied.at(-1)).not.toHaveProperty("colorTemperature");
  });

  it("warmth without a manual white balance cannot hold, so is not offered", () => {
    const { track } = camera(
      "wb-auto-only",
      { whiteBalanceMode: ["continuous"], colorTemperature: { min: 2800, max: 6500 } },
      {}
    );
    expect(pictureControls(track, false)).toEqual([]);
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
      whiteBalanceMode: "continuous",
    };
    saveAudioPrefs({ cameraPicture: many as never });
    const saved = loadAudioPrefs().cameraPicture;
    expect(Object.keys(saved)).toHaveLength(20);
    expect(saved["cam-0"]).toBeUndefined();
    expect(saved["cam-24"]).toEqual({
      values: { brightness: 1 },
      defaults: { brightness: 0 },
      exposureMode: "continuous",
      whiteBalanceMode: "continuous",
    });
  });

  it("the prefs know every control the picture module has", () => {
    expect([...CAMERA_PICTURE_KEYS]).toEqual([...PICTURE_KEYS]);
  });
});
