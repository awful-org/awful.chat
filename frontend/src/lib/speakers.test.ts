import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPEAKER_POLL_MS,
  speakers,
  stopAllSpeakers,
  updateSpeakerTracks,
} from "./speakers.svelte";

// This suite runs in node with no DOM and no Web Audio, so the few pieces the
// module touches stand in: a document whose visibility the tests flip, and an
// AudioContext whose analysers report a level the tests choose.
let level = 0;
let reads = 0;
const doc = Object.assign(new EventTarget(), { hidden: false });
const raf = vi.fn();

beforeAll(() => {
  Object.assign(globalThis, {
    document: doc,
    requestAnimationFrame: raf,
    MediaStream: class {
      constructor(readonly tracks: unknown[]) {}
    },
    AudioContext: class {
      state = "running";
      createAnalyser() {
        return {
          fftSize: 0,
          getByteFrequencyData(buf: Uint8Array) {
            reads++;
            buf.fill(level);
          },
        };
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  });
});

function liveTrack(): MediaStreamTrack {
  return { readyState: "live", kind: "audio" } as MediaStreamTrack;
}

function setHidden(hidden: boolean): void {
  doc.hidden = hidden;
  doc.dispatchEvent(new Event("visibilitychange"));
}

const peerA = new Map([["peer-a", { audioTrack: liveTrack() }]]);

beforeEach(() => {
  vi.useFakeTimers();
  level = 0;
  reads = 0;
  raf.mockClear();
});

afterEach(() => {
  stopAllSpeakers();
  doc.hidden = false;
  vi.useRealTimers();
});

describe("speaker detection loop", () => {
  it("reads the analysers ten times a second on a timer, never on animation frames", () => {
    updateSpeakerTracks(peerA, true, null, "self");

    vi.advanceTimersByTime(1000);

    // The loop used to re-request a frame on every vsync and skip five in
    // six, so the browser ran a rendering frame 60-120 times a second for
    // the whole call. The poll rate is all it needs.
    expect(reads).toBe(1000 / SPEAKER_POLL_MS);
    expect(raf).not.toHaveBeenCalled();
  });

  it("still lights the ring for a peer who is talking", () => {
    updateSpeakerTracks(peerA, true, null, "self");
    level = 40;

    vi.advanceTimersByTime(SPEAKER_POLL_MS);

    expect(speakers.speaking.has("peer-a")).toBe(true);
  });

  it("stops while the tab is hidden and picks up again when it is back", () => {
    updateSpeakerTracks(peerA, true, null, "self");
    vi.advanceTimersByTime(SPEAKER_POLL_MS);
    expect(reads).toBe(1);

    // What requestAnimationFrame did on its own: nothing runs in a hidden tab.
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    setHidden(false);
    vi.advanceTimersByTime(3 * SPEAKER_POLL_MS);
    expect(reads).toBe(4);
  });

  it("waits for the tab when the call starts in the background", () => {
    doc.hidden = true;
    updateSpeakerTracks(peerA, true, null, "self");
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(0);

    setHidden(false);
    vi.advanceTimersByTime(SPEAKER_POLL_MS);
    expect(reads).toBe(1);
  });

  it("leaves no timer behind once nobody is left to listen to", () => {
    updateSpeakerTracks(peerA, true, null, "self");
    expect(vi.getTimerCount()).toBe(1);

    updateSpeakerTracks(new Map(), true, null, "self");

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(0);
  });

  it("does not restart on a visible tab when the call has ended", () => {
    updateSpeakerTracks(peerA, true, null, "self");
    stopAllSpeakers();

    setHidden(true);
    setHidden(false);

    expect(vi.getTimerCount()).toBe(0);
  });
});
