import { describe, it, expect, beforeEach } from "vitest";

// The suite runs without a DOM; the module only needs getItem/setItem.
const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
};
import {
  clampDfnAttenuation,
  loadAudioPrefs,
  loadPeerVolume,
  savePeerVolume,
  saveAudioPrefs,
} from "./audio-prefs";

describe("per-peer volume persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a volume by did", () => {
    savePeerVolume("did:key:zAlice", 0.4);
    expect(loadPeerVolume("did:key:zAlice")).toBeCloseTo(0.4);
    expect(loadPeerVolume("did:key:zNobody")).toBeNull();
  });

  it("treats the default of 1 as deletion, so the map holds only overrides", () => {
    savePeerVolume("did:key:zAlice", 0.4);
    savePeerVolume("did:key:zAlice", 1);
    expect(loadPeerVolume("did:key:zAlice")).toBeNull();
    expect(Object.keys(loadAudioPrefs().peerVolumes)).toHaveLength(0);
  });

  it("refuses non-did keys - a peerId is not a durable identity", () => {
    savePeerVolume("12D3KooWSomePeer", 0.4);
    expect(Object.keys(loadAudioPrefs().peerVolumes)).toHaveLength(0);
  });

  it("sanitizes stored junk: clamps, drops garbage, caps the map", () => {
    const junk: Record<string, unknown> = {
      "did:key:zLoud": 99,
      "did:key:zBad": "not a number",
      "12D3KooWNotADid": 0.5,
    };
    for (let i = 0; i < 250; i++) junk[`did:key:z${i}`] = 0.5;
    localStorage.setItem(
      "awful_audio_prefs",
      JSON.stringify({ peerVolumes: junk })
    );
    const loaded = loadAudioPrefs().peerVolumes;
    expect(loaded["did:key:zLoud"]).toBe(2.5);
    expect(loaded["did:key:zBad"]).toBeUndefined();
    expect(loaded["12D3KooWNotADid"]).toBeUndefined();
    expect(Object.keys(loaded).length).toBeLessThanOrEqual(200);
  });
});

describe("screen-share priority", () => {
  beforeEach(() => localStorage.clear());

  it.each(["", "motion", "detail"] as const)("persists %s independently of FPS", (hint) => {
    saveAudioPrefs({ shareContentHint: hint, shareFps: 15 });
    expect(loadAudioPrefs().shareContentHint).toBe(hint);
    expect(loadAudioPrefs().shareFps).toBe(15);
  });

  it.each([{}, { shareContentHint: "invalid" }])("defaults old or invalid settings to Auto", (prefs) => {
    localStorage.setItem("awful_audio_prefs", JSON.stringify(prefs));
    expect(loadAudioPrefs().shareContentHint).toBe("");
  });
});

describe("noise-suppression engine", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to DeepFilterNet3 with suppression on", () => {
    expect(loadAudioPrefs().noiseEngine).toBe("dfn3");
    expect(loadAudioPrefs().dtlnEnabled).toBe(true);
  });

  it("gives prefs saved before the engine choice DeepFilterNet3, keeping their on/off", () => {
    localStorage.setItem("awful_audio_prefs", JSON.stringify({ dtlnEnabled: false, noiseGate: 0.004 }));
    const prefs = loadAudioPrefs();
    expect(prefs.noiseEngine).toBe("dfn3");
    expect(prefs.dtlnEnabled).toBe(false);
    expect(prefs.noiseGate).toBe(0.004);
  });

  it("persists DTLN and drops an unknown engine", () => {
    saveAudioPrefs({ noiseEngine: "dtln" });
    expect(loadAudioPrefs().noiseEngine).toBe("dtln");
    localStorage.setItem("awful_audio_prefs", JSON.stringify({ noiseEngine: "rnnoise" }));
    expect(loadAudioPrefs().noiseEngine).toBe("dfn3");
  });
});

describe("DeepFilterNet3 strength", () => {
  beforeEach(() => localStorage.clear());

  const strength = () => {
    const p = loadAudioPrefs();
    return [p.dfnSpeechAttenuationDb, p.dfnPauseAttenuationDb];
  };

  it("defaults to the package's 25 dB while speaking and 45 dB in pauses", () => {
    expect(strength()).toEqual([25, 45]);
    // Prefs saved before the setting existed get the same.
    localStorage.setItem("awful_audio_prefs", JSON.stringify({ dtlnEnabled: true }));
    expect(strength()).toEqual([25, 45]);
  });

  it("persists both", () => {
    saveAudioPrefs({ dfnSpeechAttenuationDb: 12, dfnPauseAttenuationDb: 33 });
    expect(strength()).toEqual([12, 33]);
  });

  it("brings stored values back into range and order", () => {
    const stored = (speech: unknown, pause: unknown) => {
      localStorage.setItem(
        "awful_audio_prefs",
        JSON.stringify({ dfnSpeechAttenuationDb: speech, dfnPauseAttenuationDb: pause })
      );
      return strength();
    };
    expect(stored(100, 100)).toEqual([40, 60]);
    expect(stored(0, 0)).toEqual([6, 9]);
    // Pauses never at or below speech: the pause gate must always exist.
    expect(stored(30, 30)).toEqual([30, 33]);
    expect(stored("loud", null)).toEqual([25, 45]);
  });

  it("clamps in one place, pushing pauses up with speech", () => {
    expect(clampDfnAttenuation(40, 41)).toEqual({ speechDb: 40, pauseDb: 43 });
    expect(clampDfnAttenuation(10, 60)).toEqual({ speechDb: 10, pauseDb: 60 });
    expect(clampDfnAttenuation(Number.NaN, 45)).toEqual({ speechDb: 25, pauseDb: 45 });
  });
});
