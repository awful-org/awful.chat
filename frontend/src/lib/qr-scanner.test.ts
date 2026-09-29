import { describe, expect, it } from "vitest";
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
