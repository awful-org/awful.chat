/**
 * Sampling rules for the ping plugin.
 *
 * All of it is pure so the parts that are easy to get quietly wrong - the
 * cadence, what counts as loss, which statistics are honest for the number
 * of samples taken - can be tested without a network.
 */

/** How long a run watches for, in milliseconds. */
export const WINDOW_MS = 30_000;

/**
 * Where the cadence starts.
 *
 * There is a floor and a ceiling, and this sits between them.
 *
 * The FLOOR is the round trip itself. Probe faster than the reply comes
 * back and several are in flight at once: you add traffic to the link whose
 * congestion you are measuring, so you become part of the answer, and the
 * samples stop being independent - one queueing event smears across several
 * probes and a single bad moment reads as many.
 *
 * The CEILING is how fast the thing being measured changes. A wifi
 * retransmit, a buffer filling, a handover - these live on the scale of a
 * few hundred milliseconds. Sample much slower and you alias: unrelated
 * snapshots instead of a picture of one condition.
 *
 * P2P round trips run 10-150ms, so 500ms clears twice the round trip for
 * anything up to 250ms while still landing ~60 samples inside the window.
 */
export const BASE_INTERVAL_MS = 500;

/** Past this a probe is loss, not latency. */
export const PROBE_TIMEOUT_MS = 2000;

export const MAX_TARGETS = 3;

/**
 * The next interval, given what the last probe cost.
 *
 * Backs off when the round trip approaches the cadence, for the same reason
 * TCP grows its retransmission timeout: a link that is struggling wants
 * fewer probes, not a fixed drumbeat that keeps arriving while the previous
 * one is still out. Loss is treated as the worst case, since a probe that
 * never came back tells us nothing except that the link is unhappy.
 */
export function nextInterval(rtt: number | null): number {
  if (rtt === null) return Math.min(BASE_INTERVAL_MS * 4, PROBE_TIMEOUT_MS);
  return Math.max(BASE_INTERVAL_MS, Math.round(2 * rtt));
}

export interface Sample {
  /** Milliseconds since the run began. */
  at: number;
  /** Round trip in milliseconds, or null for a probe that never answered. */
  rtt: number | null;
}

export interface Stats {
  min: number | null;
  median: number | null;
  max: number | null;
  /** Fraction of probes that never answered, 0 to 1. */
  loss: number;
  sent: number;
}

/**
 * Min, median, max and loss - deliberately not a mean.
 *
 * On a spotty link the mean is the one statistic that hides the problem: a
 * handful of 800ms spikes among fast replies averages out to "fine". The
 * median says what it is usually like and the max says how bad it gets,
 * which is the actual question being asked.
 */
export function summarize(samples: Sample[]): Stats {
  const answered = samples
    .map((s) => s.rtt)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  const sent = samples.length;
  const loss = sent === 0 ? 0 : (sent - answered.length) / sent;
  if (answered.length === 0) {
    return { min: null, median: null, max: null, loss, sent };
  }
  const mid = Math.floor(answered.length / 2);
  const median =
    answered.length % 2 === 0
      ? (answered[mid - 1] + answered[mid]) / 2
      : answered[mid];
  return {
    min: answered[0],
    median,
    max: answered[answered.length - 1],
    loss,
    sent,
  };
}

/**
 * Parse `/ping @alice, @bob` into the names asked for.
 *
 * Names only - resolving them to DIDs needs the room, which the caller has
 * and this does not.
 */
export function parsePingArgs(args: string, limit = MAX_TARGETS): string[] {
  return [
    ...new Set(
      args
        .split(/[,\s]+/)
        .map((t) => t.trim().replace(/^@/, ""))
        .filter(Boolean)
    ),
  ].slice(0, limit);
}

/**
 * The y-axis top for a chart of these samples.
 *
 * Rounded up to something readable and never zero, so a perfect run does
 * not divide by nothing, and driven by the worst ANSWERED probe - a lost
 * one has no height and must not set the scale.
 */
export function chartCeiling(samples: Sample[]): number {
  const worst = Math.max(
    0,
    ...samples.map((s) => s.rtt ?? 0).filter((v) => v > 0)
  );
  if (worst <= 0) return 50;
  const step = worst <= 100 ? 25 : worst <= 500 ? 50 : 250;
  return Math.ceil(worst / step) * step;
}

/**
 * A sample as it travels: [milliseconds since the run began, round trip].
 * null is a probe that never answered.
 */
export type PackedSample = [number, number | null];

/**
 * The most points worth publishing per peer.
 *
 * A run produces at most one sample every 500ms across a 30s window, so
 * sixty is already the ceiling for a healthy link - this only bites if the
 * cadence is ever lowered.
 */
export const MAX_PUBLISHED_POINTS = 60;

/**
 * Pack a run for publication.
 *
 * Everyone else in the room sees an empty chart otherwise: the samples live
 * on the machine that measured them, and one summary line is a poor
 * substitute for the shape. Pairs rather than objects, and whole
 * milliseconds rather than float noise, because a plugin update is capped
 * at 4 KB and `{"at":12345.6789,"rtt":42.1}` spends most of it on syntax.
 */
export function packSeries(
  samples: Sample[],
  maxPoints = MAX_PUBLISHED_POINTS
): PackedSample[] {
  const pack = (s: Sample): PackedSample => [
    Math.round(s.at),
    s.rtt === null ? null : Math.round(s.rtt),
  ];
  if (samples.length <= maxPoints) return samples.map(pack);
  // Count the OUTPUT, not the input. Stepping through the input by a
  // fractional stride overshoots by one on most lengths, and one point past
  // a budget is still past it.
  const out: PackedSample[] = [];
  for (let k = 0; k < maxPoints; k++) {
    out.push(pack(samples[Math.floor((k * samples.length) / maxPoints)]));
  }
  return out;
}

/** Back to what the chart draws. */
export function unpackSeries(packed: unknown): Sample[] {
  if (!Array.isArray(packed)) return [];
  const out: Sample[] = [];
  for (const p of packed) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const [at, rtt] = p;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
    if (rtt !== null && (typeof rtt !== "number" || !Number.isFinite(rtt))) {
      continue;
    }
    out.push({ at, rtt });
  }
  return out;
}
