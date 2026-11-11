import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicDenoiser } from "$lib/audio/dtln-processor";
import { pickMicTestEngine } from "./mic-test-engine";

/** Only waitUntilReady matters here: it resolves, or rejects with `error`. */
function model(error?: string) {
  const waitUntilReady = vi.fn(async () => {
    if (error) throw new TypeError(error);
  });
  return { waitUntilReady } as unknown as MicDenoiser & { waitUntilReady: typeof waitUntilReady };
}

describe("pickMicTestEngine", () => {
  beforeEach(() => {
    // dfnUnsupportedReason() wants AudioWorklet (and SIMD, which Node has).
    vi.stubGlobal("AudioWorkletNode", class {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs what was wanted, silently, when it gets ready", async () => {
    const dfn3 = model();
    const dtln = model();
    expect(await pickMicTestEngine("dfn3", 48000, { dfn3, dtln })).toEqual({
      engine: "dfn3",
      notice: null,
    });
    expect(dtln.waitUntilReady).not.toHaveBeenCalled();
  });

  it("falls back to DTLN when DeepFilterNet3 cannot load, and says so", async () => {
    const picked = await pickMicTestEngine("dfn3", 48000, {
      dfn3: model("Failed to fetch"),
      dtln: model(),
    });
    expect(picked).toEqual({
      engine: "dtln",
      notice: "DeepFilterNet couldn't start, so this test uses DTLN.",
    });
  });

  it("skips DeepFilterNet3 where it cannot run, naming why, without loading it", async () => {
    const dfn3 = model();
    const picked = await pickMicTestEngine("dfn3", 44100, { dfn3, dtln: model() });
    expect(picked.engine).toBe("dtln");
    expect(picked.notice).toMatch(/DeepFilterNet can't run on this device \(.*44100 Hz.*\), so this test uses DTLN/);
    expect(dfn3.waitUntilReady).not.toHaveBeenCalled();
  });

  it("ends on the browser's own suppression when no model gets ready", async () => {
    const picked = await pickMicTestEngine("dfn3", 48000, {
      dfn3: model("Failed to fetch"),
      dtln: model("DTLN ready timeout"),
    });
    expect(picked).toEqual({
      engine: null,
      notice:
        "DeepFilterNet couldn't start and DTLN couldn't start, so this test uses browser noise suppression.",
    });
  });

  it("leaves DeepFilterNet3 alone when DTLN, or nothing, is what is in use", async () => {
    const dfn3 = model();
    expect((await pickMicTestEngine("dtln", 48000, { dfn3, dtln: model() })).engine).toBe("dtln");
    expect(await pickMicTestEngine("browser", 48000, { dfn3, dtln: model() })).toEqual({
      engine: null,
      notice: null,
    });
    expect(dfn3.waitUntilReady).not.toHaveBeenCalled();
  });
});
