import { describe, expect, it } from "vitest";
import {
  estimateClock,
  projectPosition,
  decideCorrection,
  DEFAULT_WATCH_SYNC,
  type WatchTick,
  type ClockSample,
} from "./sync";

describe("estimateClock", () => {
  it("gives a clean offset and rtt for consistent samples", () => {
    // Remote clock is exactly 500 ms ahead of local. Every sample has a
    // 100 ms round trip split evenly: 50 ms out, 50 ms back.
    const samples: ClockSample[] = [
      { t0: 1000, t1: 1550, t2: 1560, t3: 1110 },
      { t0: 2000, t1: 2550, t2: 2560, t3: 2110 },
      { t0: 3000, t1: 3550, t2: 3560, t3: 3110 },
    ];
    const estimate = estimateClock(samples);
    expect(estimate.offsetMs).toBeCloseTo(500, 5);
    expect(estimate.rttMs).toBeCloseTo(100, 5);
    expect(estimate.samples).toBe(3);
  });

  it("is robust to one outlier sample via the median", () => {
    const clean: ClockSample[] = [
      { t0: 1000, t1: 1550, t2: 1560, t3: 1110 },
      { t0: 2000, t1: 2550, t2: 2560, t3: 2110 },
      { t0: 3000, t1: 3550, t2: 3560, t3: 3110 },
      { t0: 4000, t1: 4550, t2: 4560, t3: 4110 },
    ];
    // A wildly delayed reply: huge apparent rtt and offset, one bad sample
    // among five.
    const outlier: ClockSample = { t0: 5000, t1: 20_000, t2: 20_010, t3: 5110 };
    const estimate = estimateClock([...clean, outlier]);
    expect(estimate.offsetMs).toBeCloseTo(500, 5);
    expect(estimate.rttMs).toBeCloseTo(100, 5);
    expect(estimate.samples).toBe(5);
  });

  it("reports zero samples for an empty batch", () => {
    expect(estimateClock([])).toEqual({ offsetMs: 0, rttMs: 0, samples: 0 });
  });
});

describe("projectPosition", () => {
  it("advances position while playing at normal rate", () => {
    const tick: WatchTick = { paused: false, position: 10, atMs: 1000, rate: 1, seq: 1 };
    // 3 seconds later on the remote clock, no offset.
    expect(projectPosition(tick, 4000, 0)).toBeCloseTo(13, 5);
  });

  it("does not advance a paused tick regardless of elapsed time", () => {
    const tick: WatchTick = { paused: true, position: 42, atMs: 1000, rate: 1, seq: 1 };
    expect(projectPosition(tick, 999_000, 0)).toBe(42);
  });

  it("advances faster than wall-clock time at a rate above 1", () => {
    const tick: WatchTick = { paused: false, position: 0, atMs: 0, rate: 2, seq: 1 };
    // 5 seconds of remote wall-clock time at 2x rate is 10 seconds of media.
    expect(projectPosition(tick, 5000, 0)).toBeCloseTo(10, 5);
  });

  it("advances slower than wall-clock time at a rate below 1", () => {
    const tick: WatchTick = { paused: false, position: 0, atMs: 0, rate: 0.5, seq: 1 };
    expect(projectPosition(tick, 4000, 0)).toBeCloseTo(2, 5);
  });

  it("applies clock offset before computing elapsed time", () => {
    const tick: WatchTick = { paused: false, position: 10, atMs: 1000, rate: 1, seq: 1 };
    // Local clock reads 2000, but the remote clock is 2000 ms ahead, so the
    // remote-clock instant is 4000: 3 seconds past atMs.
    expect(projectPosition(tick, 2000, 2000)).toBeCloseTo(13, 5);
  });
});

describe("decideCorrection", () => {
  const baseTick: WatchTick = { paused: false, position: 100, atMs: 0, rate: 1, seq: 1 };

  it("does nothing when drift is inside the dead band", () => {
    // Tick projects to 100 at now=0/offset=0. Local is 0.5 s ahead, well
    // under the 1500 ms rate threshold.
    const local = { position: 100.5, paused: false, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("none");
    expect(result.rate).toBe(1);
    expect(result.driftMs).toBeCloseTo(500, 5);
  });

  it("slows down when local is ahead by a rate-band amount", () => {
    // 2 s ahead: past the 1500 ms rate threshold, under the 4000 ms seek
    // threshold.
    const local = { position: 102, paused: false, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("rate");
    expect(result.rate).toBe(DEFAULT_WATCH_SYNC.slowRate);
    expect(result.driftMs).toBeCloseTo(2000, 5);
  });

  it("speeds up when local is behind by a rate-band amount", () => {
    const local = { position: 98, paused: false, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("rate");
    expect(result.rate).toBe(DEFAULT_WATCH_SYNC.fastRate);
    expect(result.driftMs).toBeCloseTo(-2000, 5);
  });

  it("seeks when drift is past the seek band", () => {
    // 6 s ahead: past the 4000 ms seek threshold.
    const local = { position: 106, paused: false, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("seek");
    expect(result.targetPosition).toBeCloseTo(100, 5);
    expect(result.rate).toBe(1);
  });

  it("keeps correcting via rate below the entry threshold once already correcting", () => {
    // 0.3 s ahead: under the 1500 ms entry threshold, but the player is
    // already mid-correction (rate !== 1) and drift is still above the
    // 100 ms exit threshold, so correction continues instead of resetting.
    const local = { position: 100.3, paused: false, rate: DEFAULT_WATCH_SYNC.slowRate };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("rate");
    expect(result.rate).toBe(DEFAULT_WATCH_SYNC.slowRate);
  });

  it("resets to normal rate once a correction closes the drift", () => {
    // 0.05 s ahead: under the 100 ms exit threshold, even mid-correction.
    const local = { position: 100.05, paused: false, rate: DEFAULT_WATCH_SYNC.slowRate };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("none");
    expect(result.rate).toBe(1);
  });

  it("emits pause when local is playing but the tick is paused", () => {
    const pausedTick: WatchTick = { paused: true, position: 50, atMs: 0, rate: 1, seq: 2 };
    const local = { position: 50, paused: false, rate: 1 };
    const result = decideCorrection(local, pausedTick, 0, 0);
    expect(result.action).toBe("pause");
    expect(result.targetPosition).toBe(50);
  });

  it("emits resume when local is paused but the tick is playing", () => {
    const local = { position: 100, paused: true, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("resume");
  });

  it("prioritizes pause/resume over position drift", () => {
    // Large positional drift AND a paused disagreement: pause/resume wins,
    // no seek.
    const pausedTick: WatchTick = { paused: true, position: 50, atMs: 0, rate: 1, seq: 2 };
    const local = { position: 200, paused: false, rate: 1 };
    const result = decideCorrection(local, pausedTick, 0, 0);
    expect(result.action).toBe("pause");
  });

  it("handles a tick from the future without a sign error", () => {
    // The tick's projected position (100) is ahead of local (90): local is
    // behind by 10 s, well past the seek threshold, and the seek must go
    // forward to 100, not backward.
    const local = { position: 90, paused: false, rate: 1 };
    const result = decideCorrection(local, baseTick, 0, 0);
    expect(result.action).toBe("seek");
    expect(result.driftMs).toBeCloseTo(-10_000, 5);
    expect(result.targetPosition).toBeCloseTo(100, 5);
  });

  it("respects a custom config override", () => {
    const local = { position: 101, paused: false, rate: 1 };
    const strict = decideCorrection(local, baseTick, 0, 0, { rateThresholdMs: 500 });
    expect(strict.action).toBe("rate");
    const lenient = decideCorrection(local, baseTick, 0, 0, { rateThresholdMs: 5000 });
    expect(lenient.action).toBe("none");
  });
});
