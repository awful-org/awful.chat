import { afterEach, describe, expect, it, vi } from "vitest";
import { otherSideCameraId, preferBackCamera } from "./qr-scanner.svelte";

describe("preferBackCamera", () => {
  const cam = (id: string, label: string) => ({ id, label });

  // An iPhone lists each lens as a camera. The first "Back" match used to
  // win, and when that was the ultra wide or the telephoto the camera
  // opened and could not focus on a phone held up to it.
  it("skips the lenses that cannot focus up close", () => {
    expect(
      preferBackCamera([
        cam("f", "Front Camera"),
        cam("uw", "Back Ultra Wide Camera"),
        cam("t", "Back Telephoto Camera"),
        cam("b", "Back Camera"),
      ])
    ).toBe("b");
  });

  it("still takes a back lens over nothing", () => {
    expect(
      preferBackCamera([cam("f", "Front Camera"), cam("uw", "Back Ultra Wide Camera")])
    ).toBe("uw");
  });

  it("falls back to the last camera when nothing is labelled", () => {
    expect(preferBackCamera([cam("a", ""), cam("b", "")])).toBe("b");
  });
});

describe("otherSideCameraId", () => {
  const cam = (id: string, label: string) => ({ id, label });
  const iphone = [
    cam("f", "Front Camera"),
    cam("uw", "Back Ultra Wide Camera"),
    cam("t", "Back Telephoto Camera"),
    cam("b", "Back Camera"),
  ];

  // Stepping through the list went back -> front -> ultra wide -> telephoto,
  // and those two cannot read a code held up close.
  it("goes between the front camera and the good back one, skipping the other lenses", () => {
    expect(otherSideCameraId(iphone, "b")).toBe("f");
    expect(otherSideCameraId(iphone, "f")).toBe("b");
  });

  it("takes an Android's front/back pair", () => {
    const android = [cam("1", "camera2 1, facing front"), cam("0", "camera2 0, facing back")];
    expect(otherSideCameraId(android, "0")).toBe("1");
    expect(otherSideCameraId(android, "1")).toBe("0");
  });

  it("steps to the next camera when nothing says which way it faces", () => {
    expect(otherSideCameraId([cam("a", ""), cam("b", "")], "b")).toBe("a");
    expect(otherSideCameraId([cam("a", ""), cam("b", "")], "a")).toBe("b");
  });

  it("offers nothing with a single camera", () => {
    expect(otherSideCameraId([cam("a", "Back Camera")], "a")).toBeNull();
  });
});

describe("jsQR", () => {
  afterEach(() => {
    vi.doUnmock("jsqr");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Just enough of a camera, a page and a video element to start a scan. */
  function fakeCamera(): void {
    const track = { stop() {}, getSettings: () => ({ deviceId: "cam" }), getCapabilities: () => ({}) };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [{ kind: "videoinput", deviceId: "cam", label: "Back Camera" }],
      },
    });
    const video = { setAttribute() {}, play: async () => {}, remove() {}, readyState: 0 };
    vi.stubGlobal("document", {
      getElementById: () => ({ replaceChildren() {} }),
      createElement: (tag: string) => (tag === "video" ? video : { getContext: () => ({}) }),
    });
  }

  // jsQR is only the fallback for a platform with no QR detector of its own,
  // and it used to be downloaded and parsed with every page.
  it("is loaded only by a scan on a platform without a QR detector", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("jsqr", async (importOriginal) => {
      loads++;
      return await importOriginal();
    });
    const scanner = await import("./qr-scanner.svelte");
    expect(loads).toBe(0);

    fakeCamera();
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        static async getSupportedFormats() {
          return ["qr_code"];
        }
        async detect() {
          return [];
        }
      }
    );
    await scanner.startQrScan("view", () => false);
    await scanner.stopQrScan();
    expect(loads).toBe(0);

    vi.stubGlobal("BarcodeDetector", undefined);
    await scanner.startQrScan("view", () => false);
    await scanner.stopQrScan();
    expect(loads).toBe(1);
  });

  // The browser's own text names the chunk's https URL, so the dialogs - which
  // show a message only when it is about https - showed it as a camera problem.
  it("says plainly when it could not be downloaded, and tries again on the next scan", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("jsqr", async (importOriginal) => {
      if (loads++ === 0) {
        throw new TypeError("Failed to fetch dynamically imported module: https://awful.example/assets/jsQR-x.js");
      }
      return await importOriginal();
    });
    const scanner = await import("./qr-scanner.svelte");
    fakeCamera();
    vi.stubGlobal("BarcodeDetector", undefined);
    await expect(scanner.startQrScan("view", () => false)).rejects.toThrow(scanner.SCANNER_NOT_LOADED);
    await scanner.startQrScan("view", () => false);
    await scanner.stopQrScan();
    expect(loads).toBe(2);
  });
});
