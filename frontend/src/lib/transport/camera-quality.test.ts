import { describe, expect, it } from "vitest";
import {
  cameraCaptureConstraints,
  openCamera,
  cameraDisplaySizes,
  cameraEncodings,
  layerBitrate,
  layerForTile,
  TOP_LAYER,
} from "./camera-quality";

describe("camera capture", () => {
  it("is 1080p on a computer and 720p on a phone, at 30 fps", () => {
    expect(cameraCaptureConstraints(false)).toEqual({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    });
    expect(cameraCaptureConstraints(true)).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });
});

describe("camera levels", () => {
  it("1080p goes as 270p, 540p and 1080p", () => {
    const e = cameraEncodings(1920, 1080);
    expect(e.map((x) => x.scaleResolutionDownBy)).toEqual([4, 2, 1]);
    expect(e.map((x) => x.maxBitrate)).toEqual([250_000, 800_000, 2_500_000]);
  });

  it("720p goes as 180p, 360p and 720p", () => {
    expect(cameraEncodings(1280, 720).map((x) => x.maxBitrate)).toEqual([
      150_000, 450_000, 1_500_000,
    ]);
  });

  it("an upright phone camera is sized by its short side, as a lying one", () => {
    expect(cameraEncodings(720, 1280)).toEqual(cameraEncodings(1280, 720));
  });

  it("a smaller capture asks for fewer levels and keeps its full size", () => {
    expect(cameraEncodings(640, 480).map((x) => x.scaleResolutionDownBy)).toEqual([2, 1]);
    expect(cameraEncodings(960, 540).map((x) => x.scaleResolutionDownBy)).toEqual([4, 2, 1]);
    expect(cameraEncodings(320, 240).map((x) => x.scaleResolutionDownBy)).toEqual([1]);
  });

  it("a track that does not say its size is taken as 720p", () => {
    expect(cameraEncodings(0, 0)).toEqual(cameraEncodings(1280, 720));
  });

  it("every level can drop frame rate before size", () => {
    expect(cameraEncodings(1280, 720).every((x) => (x as { scalabilityMode?: string }).scalabilityMode === "L1T3")).toBe(true);
  });

  it("bitrate grows with size", () => {
    const sizes = [90, 180, 270, 360, 540, 720, 1080, 2160];
    const rates = sizes.map(layerBitrate);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
  });
});

describe("the level a tile needs", () => {
  it("small, middle and large tiles", () => {
    expect(layerForTile(300)).toBe(0);
    expect(layerForTile(320)).toBe(0);
    expect(layerForTile(321)).toBe(1);
    expect(layerForTile(640)).toBe(1);
    expect(layerForTile(641)).toBe(TOP_LAYER);
  });

  it("counts the screen's pixel ratio, up to 2", () => {
    expect(layerForTile(200, 2)).toBe(1);
    expect(layerForTile(200, 3)).toBe(1);
    expect(layerForTile(160, 3)).toBe(0);
    expect(layerForTile(400, 2)).toBe(TOP_LAYER);
  });

  it("an unmeasured surface gets the top", () => {
    expect(layerForTile(null, 1)).toBe(TOP_LAYER);
  });
});

describe("display sizes", () => {
  it("is the largest it is shown at, or null when also shown unmeasured or not yet measured", () => {
    const sizes = cameraDisplaySizes(
      ["a", "b", "c"],
      new Set(["b"]),
      [
        ["a", 200],
        ["a", 500],
        ["b", 100],
      ]
    );
    expect(sizes).toEqual(
      new Map([
        ["a", 500],
        ["b", null],
        ["c", null],
      ])
    );
  });

  it("a tile measured at zero (not laid out yet) is not measured", () => {
    expect(cameraDisplaySizes(["a"], new Set(), [["a", 0]])).toEqual(new Map([["a", null]]));
  });
});

describe("opening the chosen camera", () => {
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const media = (outcomes: (Error | "ok")[]) => {
    const asked: MediaStreamConstraints[] = [];
    return {
      asked,
      getUserMedia: async (c?: MediaStreamConstraints) => {
        asked.push(c ?? {});
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return {} as MediaStream;
      },
    };
  };
  const size = { width: { ideal: 1920 } };

  it("asks for the chosen camera exactly, so a smaller one is not passed over", async () => {
    const m = media(["ok"]);
    await openCamera("cam-1", size, false, m);
    expect(m.asked).toEqual([{ video: { width: { ideal: 1920 }, deviceId: { exact: "cam-1" } }, audio: false }]);
  });

  it("falls back to any camera when the chosen one is gone", async () => {
    for (const name of ["OverconstrainedError", "NotFoundError"]) {
      const m = media([fail(name), "ok"]);
      await openCamera("gone", size, false, m);
      expect(m.asked[1]).toEqual({ video: { width: { ideal: 1920 }, deviceId: { ideal: "gone" } }, audio: false });
    }
  });

  it("does not ask again after a refusal", async () => {
    const m = media([fail("NotAllowedError"), "ok"]);
    await expect(openCamera("cam-1", size, false, m)).rejects.toThrow("NotAllowedError");
    expect(m.asked).toHaveLength(1);
  });

  it("with no camera chosen, just the size", async () => {
    const m = media(["ok"]);
    await openCamera(null, size, true, m);
    expect(m.asked).toEqual([{ video: { width: { ideal: 1920 } }, audio: true }]);
  });
});
