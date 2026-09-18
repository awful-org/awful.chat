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
