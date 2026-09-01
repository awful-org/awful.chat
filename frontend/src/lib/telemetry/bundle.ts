/**
 * Bundle assembly. The bundle is the ONLY artifact that leaves the tab, so
 * this module and `redact.ts` are the two files a privacy review must read.
 *
 * `bundle.test.ts` holds the gate for the whole feature: it feeds a recorder a
 * real room code, a real `did:key:`, a chat payload and an infoHash, and
 * asserts that none of the four strings survives into `JSON.stringify` of the
 * result.
 */

import type { ClientBundle, DiagEvent, DiagSeverity } from "./schema";
import { DIAG_SCHEMA_VERSION } from "./schema";
import type { RecorderSnapshot } from "./recorder";
import { MAX_DETAIL_STRING } from "./event";

/**
 * What only the caller knows.
 *
 * Everything else - the peerId, the runtime config, the fault flag - comes from
 * the `RecorderSnapshot`, deliberately: two sources for one field is how a
 * bundle ends up disagreeing with the events inside it.
 */
export interface BundleContext {
  /** `__APP_VERSION__`. A vite define, so it is not readable from a test. */
  version: string;
  /** `__APP_COMMIT__`. */
  commit: string;
  /** `navigator.userAgent`, truncated here. */
  ua: string;
  /** Wall clock ms at export. */
  now: number;
  randomHex(bytes: number): string;
}

export function buildClientBundle(
  snap: RecorderSnapshot,
  ctx: BundleContext
): ClientBundle {
  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    bundleId: ctx.randomHex(16),
    sessionId: snap.sessionId,
    createdAt: ctx.now,
    startedAt: snap.startedAt,
    vantage: "client",
    app: { version: ctx.version, commit: ctx.commit },
    env: { ua: ctx.ua.slice(0, MAX_DETAIL_STRING) },
    config: { ...snap.runtime, sfuHosts: [...snap.runtime.sfuHosts] },
    self: { peerId: snap.selfPeerId },
    rooms: snap.rooms.map((r) => ({ ...r })),
    peers: snap.peers.map((p) => ({ ...p })),
    counters: { ...snap.counters },
    events: snap.events,
    sfuSnapshots: snap.sfuSnapshots,
    meta: {
      ringCapacity: snap.ringCapacity,
      dropped: snap.dropped,
      suppressed: { ...snap.suppressed },
      faultsActive: snap.faultsActive,
      truncated: false,
    },
  };
}

/** The order in which insight is sacrificed. An error is never lost first. */
const SACRIFICE_ORDER: readonly DiagSeverity[] = ["debug", "info", "warn", "error"];

/**
 * Shrink a bundle to fit an upload.
 *
 * The SFU snapshots go first: each one is kilobytes, and its summary already
 * rides an `sfu.diag` event that stays. Events then go by severity class,
 * oldest first inside a class, so a `debug` sample is always lost before an
 * `error`.
 *
 * `maxBytes` is measured against `JSON.stringify` length, which is a character
 * count. That under-counts a multi-byte character, so the caller must leave
 * headroom below the collector's real byte limit.
 */
export function trimBundleForUpload(
  b: ClientBundle,
  maxBytes: number
): ClientBundle {
  if (JSON.stringify(b).length <= maxBytes) return b;

  const out: ClientBundle = {
    ...b,
    sfuSnapshots: [...b.sfuSnapshots],
    events: [...b.events],
    meta: { ...b.meta, truncated: true },
  };

  while (out.sfuSnapshots.length > 0) {
    out.sfuSnapshots.shift();
    if (JSON.stringify(out).length <= maxBytes) return out;
  }

  // Index the events once, in sacrifice order. Re-sorting or re-filtering per
  // removal would be quadratic on a 4096-event ring.
  const doomed: number[] = [];
  for (const sev of SACRIFICE_ORDER) {
    for (let i = 0; i < out.events.length; i++) {
      if (out.events[i].sev === sev) doomed.push(i);
    }
  }

  // Remove in shrinking batches. One `JSON.stringify` per batch, not per
  // event: a full measurement of a large bundle is the expensive part.
  const keep = new Set<number>(out.events.map((_, i) => i));
  let cut = 0;
  while (cut < doomed.length) {
    const batch = Math.max(1, Math.ceil((doomed.length - cut) / 8));
    for (let i = 0; i < batch && cut < doomed.length; i++, cut++) {
      keep.delete(doomed[cut]);
    }
    out.events = pick(b.events, keep);
    if (JSON.stringify(out).length <= maxBytes) return out;
  }

  return out;
}

function pick(events: DiagEvent[], keep: Set<number>): DiagEvent[] {
  const out: DiagEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (keep.has(i)) out.push(events[i]);
  }
  return out;
}
