/**
 * Shared watch-party clock sync and playback correction logic.
 *
 * Every participant plays their own local video file. This module never
 * touches the file. It only answers two questions, both pure and
 * synchronous: what time is it on the other person's clock, and given
 * where they say playback is, how far off is my player and what should
 * I do about it.
 *
 * The control law is Syncplay's three-band controller (small drift: do
 * nothing; medium drift: nudge the rate; large drift: seek), and the clock
 * model is NTP-style round-trip offset estimation, the same shape Jellyfin
 * uses in its TimeSyncController. See README.md for the full explanation
 * and the exact source lines each constant below comes from.
 *
 * No DOM, no timers, no network. The caller owns all of that.
 */

/** One authoritative playback snapshot. A timestamp and a rate, never a bare position. */
export type WatchTick = {
  paused: boolean;
  /** media position in seconds, true at `atMs` on the sender's clock */
  position: number;
  /** sender wall clock, ms since epoch */
  atMs: number;
  /** playback rate; 1 is normal */
  rate: number;
  /** monotonically increasing per sender, for ordering ticks inside one room */
  seq: number;
};

/** One NTP-style round-trip sample: t0 local send, t1 remote receive, t2 remote send, t3 local receive. */
export type ClockSample = { t0: number; t1: number; t2: number; t3: number };

export type ClockEstimate = { offsetMs: number; rttMs: number; samples: number };

/**
 * NTP-style offset from round-trip samples, median-filtered.
 *
 * `offsetMs` is defined so that `remoteClockMs = localClockMs + offsetMs`:
 * add it to a local timestamp to get the equivalent point on the remote
 * clock. Each sample gives an independent offset and round-trip-time
 * estimate; the median of each is reported rather than the mean, because
 * one slow or reordered packet skews a mean but cannot move a median as
 * long as it stays a minority of the batch. `samples` is the number of
 * samples given, so a caller can refuse to act on an estimate built from
 * too few of them.
 */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate {
  if (samples.length === 0) {
    return { offsetMs: 0, rttMs: 0, samples: 0 };
  }
  const offsets: number[] = [];
  const rtts: number[] = [];
  for (const s of samples) {
    offsets.push((s.t1 - s.t0 + (s.t2 - s.t3)) / 2);
    rtts.push(s.t3 - s.t0 - (s.t2 - s.t1));
  }
  return {
    offsetMs: median(offsets),
    rttMs: median(rtts),
    samples: samples.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Where the tick says playback is, right now, on the local clock.
 *
 * A paused tick does not advance: `position` is returned unchanged
 * regardless of how much time has passed. A playing tick advances by
 * elapsed sender-clock time times `rate`. `nowMs` is the caller's local
 * clock; `offsetMs` (from `estimateClock`) converts it to the sender's
 * clock before computing elapsed time.
 */
export function projectPosition(tick: WatchTick, nowMs: number, offsetMs: number): number {
  if (tick.paused) {
    return tick.position;
  }
  const remoteNowMs = nowMs + offsetMs;
  const elapsedSeconds = (remoteNowMs - tick.atMs) / 1000;
  return tick.position + elapsedSeconds * tick.rate;
}

export type CorrectionAction = "none" | "seek" | "rate" | "pause" | "resume";

export type Correction = {
  action: CorrectionAction;
  targetPosition: number;
  rate: number;
  driftMs: number;
};

export type WatchSyncConfig = {
  seekThresholdMs: number;
  rateThresholdMs: number;
  slowRate: number;
  fastRate: number;
  maxRateCorrectionMs: number;
};

/**
 * Defaults are Syncplay's own control-law constants (`syncplay/constants.py`,
 * quoted in the research doc, finding 10), applied symmetrically. Syncplay
 * splits "ahead" and "behind" into slightly different thresholds; this
 * module uses one number per band, taking the stricter (smaller) of
 * Syncplay's two bounds so a correction never waits longer than Syncplay's
 * own most aggressive case in either direction.
 */
export const DEFAULT_WATCH_SYNC: WatchSyncConfig = {
  // DEFAULT_REWIND_THRESHOLD = 4 ("behind by >4 s: seek forward"). Syncplay's
  // ahead-side bound is DEFAULT_FASTFORWARD_THRESHOLD = 5; 4 s is the
  // stricter of the two, so it is used for both directions here.
  seekThresholdMs: 4000,
  // DEFAULT_SLOWDOWN_KICKIN_THRESHOLD = 1.5 ("beyond 1.5 s ahead, reduce
  // rate"). Syncplay's behind-side bound is FASTFORWARD_BEHIND_THRESHOLD =
  // 1.75; 1.5 s is the stricter of the two, so it is used for both
  // directions here.
  rateThresholdMs: 1500,
  // SLOWDOWN_RATE = 0.95 ("ahead: play at 0.95x"). Applied when the local
  // player is ahead of the tick and needs to slow down to let it catch up.
  slowRate: 0.95,
  // Syncplay names no symmetric speed-up rate; its own text describes the
  // mechanism generally as "a 5% rate change is neither [visible nor
  // audible]" (finding 10). 1.05 is that same 5% change mirrored for the
  // behind case, not a separately quoted Syncplay constant.
  fastRate: 1.05,
  // SLOWDOWN_RESET_THRESHOLD = 0.1 ("resume 1.0x within 100 ms"). Once a
  // rate correction is in effect, it holds until drift falls under this
  // much tighter bound, rather than the wider entry threshold, so playback
  // does not chatter between "none" and "rate" right at the edge.
  maxRateCorrectionMs: 100,
};

/**
 * The control law. Small drift is corrected by rate, large drift by seek.
 *
 * `local.position`/`local.paused` are the caller's own player state, in
 * the same seconds unit as `WatchTick.position`. `local.rate` is the
 * rate the player is currently applying; passing back whatever rate a
 * previous `Correction` set (or 1, if none was ever applied) gives the
 * hysteresis Syncplay relies on: a correction that has already kicked in
 * keeps running until drift falls under `maxRateCorrectionMs`, not merely
 * back under `rateThresholdMs`, so playback does not oscillate at the
 * boundary.
 *
 * `driftMs` is `local.position - projectedPosition`, in milliseconds:
 * positive means the local player is ahead of the tick, negative means it
 * is behind. It is always reported, even for `"none"`, `"pause"`, and
 * `"resume"`, so a caller can log or graph it.
 *
 * A paused/playing disagreement between `local.paused` and `tick.paused`
 * is corrected first and alone, with `"pause"` or `"resume"`, before any
 * position math: there is no point rate-correcting a player that is about
 * to be paused or resumed anyway.
 */
export function decideCorrection(
  local: { position: number; paused: boolean; rate: number },
  tick: WatchTick,
  nowMs: number,
  offsetMs: number,
  cfg: Partial<WatchSyncConfig> = {},
): Correction {
  const config: WatchSyncConfig = { ...DEFAULT_WATCH_SYNC, ...cfg };
  const targetPosition = projectPosition(tick, nowMs, offsetMs);
  const driftMs = (local.position - targetPosition) * 1000;

  if (local.paused !== tick.paused) {
    return {
      action: tick.paused ? "pause" : "resume",
      targetPosition,
      rate: 1,
      driftMs,
    };
  }

  const absDriftMs = Math.abs(driftMs);

  if (absDriftMs > config.seekThresholdMs) {
    return { action: "seek", targetPosition, rate: 1, driftMs };
  }

  const wasCorrecting = local.rate !== 1;
  const rateExitThresholdMs = wasCorrecting ? config.maxRateCorrectionMs : config.rateThresholdMs;

  if (absDriftMs > rateExitThresholdMs) {
    const rate = driftMs > 0 ? config.slowRate : config.fastRate;
    return { action: "rate", targetPosition, rate, driftMs };
  }

  return { action: "none", targetPosition, rate: 1, driftMs };
}
