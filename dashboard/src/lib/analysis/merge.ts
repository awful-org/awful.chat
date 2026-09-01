/**
 * The workspace model: many loaded vantages become a small number of captures,
 * each with one absolute-time timeline.
 *
 * Two problems make this more than a concatenation.
 *
 * 1. GROUPING. Nothing in a bundle names the incident it belongs to. Two
 *    vantages belong to the same capture when their wall-clock windows overlap
 *    AND they share at least one peerId. No shared secret and no new wire
 *    message is needed: a peerId is the join key, and both servers already
 *    know it.
 * 2. CLOCK SKEW. Two browsers disagree about `Date.now()` by seconds. Without
 *    a correction, "A saw B connect before B saw A" is noise, and every
 *    cross-vantage finding is worthless. `peer.clock` events carry the four
 *    NTP-style timestamps, which give one offset measurement per peer pair.
 */

import type {
  ClientBundle,
  DiagBundle,
  DiagEvent,
  DiagKind,
  DiagPeerRef,
  RelayVantage,
} from "../schema";

/** Beyond this the correction failed and every cross-vantage finding is suspect. */
export const MAX_ACCEPTABLE_SKEW_MS = 2000;

/** Jacobi iterations for the offset solve. The system is tiny and converges fast. */
const SOLVE_ITERATIONS = 200;

export type VantageKind = "client" | "relay" | "sfu" | "log";

export interface LoadedVantage {
  /** The file, or the relay bundle id, this came from. */
  source: string;
  kind: VantageKind;
  /**
   * Vantages that came out of ONE loaded file. They are the same session by
   * construction, so they are grouped together even when clock skew pushed a
   * window out of overlap.
   */
  bundleKey: string;
  /** peerId of the observer, so "who saw this" is never ambiguous. */
  observer: string;
  /** Wall clock ms of the observer's `t = 0`. Zero for an already-absolute vantage. */
  epoch: number;
  /** Applied skew correction, added to every absolute time. */
  offset: number;
  events: VantageEvent[];
  window: { from: number; to: number };
  /** Present for a client vantage. */
  bundle?: ClientBundle;
  /** Present for a relay vantage. */
  relay?: RelayVantage;
}

/**
 * A log line that no template matched.
 *
 * NOT a wire kind: it never appears in a bundle, so it is deliberately absent
 * from `DiagKind`. It exists so a parser can keep an unrecognised line rather
 * than drop it silently, and so a reader can see that it was not understood.
 */
export const LOG_RAW_KIND = "log.raw";

/** A wire kind, or the dashboard's own "not understood" marker. */
export type MergedKind = DiagKind | typeof LOG_RAW_KIND;

/**
 * An event as held by a vantage: a wire event from a bundle, or a line a log
 * parser recognised - or did not.
 */
export type VantageEvent = Omit<DiagEvent, "kind"> & { kind: MergedKind };

export interface MergedEvent extends Omit<DiagEvent, "kind"> {
  kind: MergedKind;
  /** Absolute wall-clock ms after skew correction. */
  at: number;
  vantage: VantageKind;
  /** Which loaded file this came from. */
  source: string;
  /** peerId of the observer. */
  observer: string;
}

export interface PeerSummary {
  peerId: string;
  /** Identity ordinals are bundle-local, so this is a set of `source:ref`. */
  identityRefs: string[];
  /** Observers that named this peer. */
  observers: string[];
  firstSeen: number;
  lastSeen: number;
  /** True when this peer uploaded a vantage of its own. */
  hasVantage: boolean;
}

export interface RoomSummary {
  /**
   * `source:ref` for a client vantage, `relay:ref` for a relay vantage.
   *
   * A client room ref is bundle-local: "r1" in two bundles is two different
   * rooms, and there is deliberately no way to join them - the room code is
   * the room's only membership secret. A relay ref is an HMAC under one boot
   * secret, so relay refs from ONE relay lifetime do join.
   */
  key: string;
  ref: string;
  kind: "text" | "dm" | "sync" | "unknown";
  observers: string[];
  eventCount: number;
}

export interface Capture {
  /** Derived and stable: the earliest observer plus the window start. */
  id: string;
  window: { from: number; to: number };
  vantages: LoadedVantage[];
  /** Every event from every vantage, skew-corrected, sorted by absolute time. */
  timeline: MergedEvent[];
  peers: Map<string, PeerSummary>;
  rooms: Map<string, RoomSummary>;
  /** Worst residual left by the offset solve, in ms. */
  maxSkewResidualMs: number;
  warnings: string[];
}

export interface Workspace {
  captures: Capture[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Vantage extraction
// ---------------------------------------------------------------------------

/**
 * Split a loaded bundle into its vantages. A stapled relay view is a SECOND
 * vantage on the same session, not part of the client's.
 */
export function vantagesOf(bundle: DiagBundle, source: string): LoadedVantage[] {
  const out: LoadedVantage[] = [];
  const clientTimes = bundle.events.map((e) => bundle.startedAt + e.t);
  out.push({
    source,
    kind: "client",
    bundleKey: source,
    observer: bundle.self.peerId,
    epoch: bundle.startedAt,
    offset: 0,
    events: bundle.events,
    window: {
      from: bundle.startedAt,
      to: Math.max(bundle.createdAt, ...clientTimes, bundle.startedAt),
    },
    bundle,
  });

  const view = bundle.relayView;
  if (view) {
    // A relay event's `t` is already unix ms: the relay has no session start.
    const times = view.events.map((e) => e.t);
    out.push({
      source: `${source}#relay`,
      kind: "relay",
      bundleKey: source,
      observer: view.relayPeerId,
      epoch: 0,
      offset: 0,
      events: view.events,
      window: {
        from: times.length > 0 ? Math.min(...times) : bundle.startedAt,
        to: times.length > 0 ? Math.max(...times) : bundle.createdAt,
      },
      relay: view,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Every peerId a vantage names: its observer, and every peer it mentions. */
export function peerIdsOf(v: LoadedVantage): Set<string> {
  const ids = new Set<string>();
  if (v.observer) ids.add(v.observer);
  for (const p of v.bundle?.peers ?? []) ids.add(p.peerId);
  for (const e of v.events) {
    if (e.peer) ids.add(e.peer);
  }
  for (const room of v.relay?.rooms ?? []) {
    for (const m of room.members) ids.add(m);
  }
  if (v.relay) ids.add(v.relay.observedPeerId);
  return ids;
}

function overlaps(a: LoadedVantage, b: LoadedVantage): boolean {
  return a.window.from <= b.window.to && b.window.from <= a.window.to;
}

function sharesPeer(a: Set<string>, b: Set<string>): boolean {
  for (const id of a) {
    if (b.has(id)) return true;
  }
  return false;
}

/** Union-find over the "same capture" relation. */
function group(vantages: LoadedVantage[]): LoadedVantage[][] {
  const parent = vantages.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const ids = vantages.map(peerIdsOf);
  for (let i = 0; i < vantages.length; i++) {
    for (let j = i + 1; j < vantages.length; j++) {
      const sameFile = vantages[i].bundleKey === vantages[j].bundleKey;
      if (!sameFile) {
        if (!overlaps(vantages[i], vantages[j])) continue;
        if (!sharesPeer(ids[i], ids[j])) continue;
      }
      parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, LoadedVantage[]>();
  for (let i = 0; i < vantages.length; i++) {
    const root = find(i);
    const list = byRoot.get(root);
    if (list) list.push(vantages[i]);
    else byRoot.set(root, [vantages[i]]);
  }
  return [...byRoot.values()];
}

// ---------------------------------------------------------------------------
// Clock skew
// ---------------------------------------------------------------------------

export interface SkewSample {
  /** The observer's vantage source. */
  from: string;
  /** The observed peer. */
  peer: string;
  /** `remote clock - local clock`, in ms. */
  offsetMs: number;
}

/**
 * One offset measurement per `peer.clock` event.
 *
 * `offset = ((t1 - t0) + (t2 - t3)) / 2` is the standard NTP estimator: it
 * cancels a symmetric path delay, so an asymmetric path is the only thing that
 * biases it.
 */
export function skewSamples(v: LoadedVantage): SkewSample[] {
  const out: SkewSample[] = [];
  for (const e of v.events) {
    if (e.kind !== "peer.clock" || !e.peer || !e.d) continue;
    const { t0, t1, t2, t3 } = e.d;
    if (
      typeof t0 !== "number" ||
      typeof t1 !== "number" ||
      typeof t2 !== "number" ||
      typeof t3 !== "number"
    ) {
      continue;
    }
    out.push({
      from: v.source,
      peer: e.peer,
      offsetMs: (t1 - t0 + (t2 - t3)) / 2,
    });
  }
  return out;
}

export interface SkewSolution {
  /** Offset per vantage source, to be ADDED to that vantage's times. */
  offsets: Map<string, number>;
  maxResidualMs: number;
  warnings: string[];
}

/**
 * Solve for a per-vantage offset.
 *
 * A sample says `clock(peer) - clock(observer) = offsetMs`. With one unknown
 * per vantage that is a linear system whose least-squares solution is the
 * minimiser of the sum of squared residuals. Jacobi iteration on the graph
 * Laplacian reaches it; the anchor is pinned at zero, so the solution is a
 * common time base rather than a true wall clock.
 *
 * The anchor is the vantage with the most samples, because it is the one whose
 * measurements the rest are corrected against.
 */
export function solveSkew(vantages: LoadedVantage[]): SkewSolution {
  const warnings: string[] = [];
  const bySource = new Map<string, LoadedVantage>();
  for (const v of vantages) bySource.set(v.source, v);

  // A sample names a PEER, not a vantage. Only a peer that uploaded a vantage
  // of its own can be corrected; the rest are measurements of an unknown clock.
  const vantageOfPeer = new Map<string, string>();
  for (const v of vantages) {
    if (v.kind === "client" && v.observer) vantageOfPeer.set(v.observer, v.source);
  }

  const edges: Array<{ a: string; b: string; delta: number }> = [];
  const sampleCount = new Map<string, number>();
  for (const v of vantages) {
    for (const s of skewSamples(v)) {
      const b = vantageOfPeer.get(s.peer);
      if (!b || b === s.from) continue;
      edges.push({ a: s.from, b, delta: s.offsetMs });
      sampleCount.set(s.from, (sampleCount.get(s.from) ?? 0) + 1);
      sampleCount.set(b, (sampleCount.get(b) ?? 0) + 1);
    }
  }

  const offsets = new Map<string, number>();
  for (const v of vantages) offsets.set(v.source, 0);

  if (edges.length === 0) {
    if (vantages.filter((v) => v.kind === "client").length > 1) {
      warnings.push(
        "No peer.clock samples: vantage offsets are 0 and every cross-vantage finding is suspect."
      );
    }
    return { offsets, maxResidualMs: 0, warnings };
  }

  let anchor = vantages[0].source;
  let best = -1;
  for (const [source, n] of sampleCount) {
    if (n > best) {
      best = n;
      anchor = source;
    }
  }

  // Average duplicate measurements of one edge first, so a chatty pair does
  // not outvote a quiet one.
  const merged = new Map<string, { a: string; b: string; delta: number; n: number }>();
  for (const e of edges) {
    const key = `${e.a}|${e.b}`;
    const hit = merged.get(key);
    if (hit) {
      hit.delta += e.delta;
      hit.n++;
    } else merged.set(key, { ...e, n: 1 });
  }
  const averaged = [...merged.values()].map((e) => ({
    a: e.a,
    b: e.b,
    delta: e.delta / e.n,
  }));

  for (let iter = 0; iter < SOLVE_ITERATIONS; iter++) {
    const sums = new Map<string, { total: number; n: number }>();
    for (const e of averaged) {
      // b = a + delta, and a = b - delta.
      add(sums, e.b, (offsets.get(e.a) ?? 0) + e.delta);
      add(sums, e.a, (offsets.get(e.b) ?? 0) - e.delta);
    }
    for (const [source, { total, n }] of sums) {
      if (source === anchor) continue;
      offsets.set(source, total / n);
    }
    offsets.set(anchor, 0);
  }

  let maxResidualMs = 0;
  for (const e of averaged) {
    const predicted = (offsets.get(e.b) ?? 0) - (offsets.get(e.a) ?? 0);
    maxResidualMs = Math.max(maxResidualMs, Math.abs(predicted - e.delta));
  }

  for (const v of vantages) {
    if (v.kind !== "client") continue;
    if (sampleCount.has(v.source)) continue;
    warnings.push(
      `${v.source}: no peer.clock sample, so its offset is 0 and its times may be wrong.`
    );
  }

  // A relay vantage's times come from ONE machine's clock, and it is the only
  // clock the relay ever reports, so it is the reference for itself.
  for (const v of vantages) {
    if (v.kind === "relay") offsets.set(v.source, 0);
  }

  return { offsets, maxResidualMs, warnings };
}

function add(
  sums: Map<string, { total: number; n: number }>,
  key: string,
  value: number
): void {
  const hit = sums.get(key);
  if (hit) {
    hit.total += value;
    hit.n++;
  } else sums.set(key, { total: value, n: 1 });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function roomKey(v: LoadedVantage, ref: string): string {
  return v.kind === "relay" ? `relay:${ref}` : `${v.source}:${ref}`;
}

function buildCapture(vantages: LoadedVantage[]): Capture {
  const skew = solveSkew(vantages);
  const timeline: MergedEvent[] = [];

  for (const v of vantages) {
    v.offset = skew.offsets.get(v.source) ?? 0;
    for (const e of v.events) {
      timeline.push({
        ...e,
        at: v.epoch + e.t + v.offset,
        vantage: v.kind,
        source: v.source,
        observer: v.observer,
      });
    }
  }
  // Stable: a tie keeps the order the vantages were loaded in, then `seq`.
  timeline.sort((a, b) => a.at - b.at || a.seq - b.seq);

  const peers = new Map<string, PeerSummary>();
  const touch = (peerId: string, at: number, observer: string): void => {
    const hit = peers.get(peerId);
    if (hit) {
      hit.firstSeen = Math.min(hit.firstSeen, at);
      hit.lastSeen = Math.max(hit.lastSeen, at);
      if (!hit.observers.includes(observer)) hit.observers.push(observer);
      return;
    }
    peers.set(peerId, {
      peerId,
      identityRefs: [],
      observers: [observer],
      firstSeen: at,
      lastSeen: at,
      hasVantage: false,
    });
  };

  for (const v of vantages) {
    if (v.observer) touch(v.observer, v.window.from, v.observer);
    for (const ref of v.bundle?.peers ?? []) {
      touch(ref.peerId, v.epoch + ref.firstSeen + v.offset, v.observer);
      touch(ref.peerId, v.epoch + ref.lastSeen + v.offset, v.observer);
      recordIdentity(peers, v, ref);
    }
  }
  for (const e of timeline) {
    if (e.peer) touch(e.peer, e.at, e.observer);
  }
  for (const v of vantages) {
    const hit = peers.get(v.observer);
    if (hit) hit.hasVantage = true;
  }

  const rooms = new Map<string, RoomSummary>();
  for (const v of vantages) {
    for (const r of v.bundle?.rooms ?? []) {
      rooms.set(roomKey(v, r.ref), {
        key: roomKey(v, r.ref),
        ref: r.ref,
        kind: r.kind,
        observers: [v.observer],
        eventCount: 0,
      });
    }
    for (const r of v.relay?.rooms ?? []) {
      const key = roomKey(v, r.ref);
      if (!rooms.has(key)) {
        rooms.set(key, {
          key,
          ref: r.ref,
          kind: "unknown",
          observers: [v.observer],
          eventCount: 0,
        });
      }
    }
  }
  for (const e of timeline) {
    if (!e.room) continue;
    const v = vantages.find((x) => x.source === e.source);
    if (!v) continue;
    const key = roomKey(v, e.room);
    const hit = rooms.get(key);
    if (hit) {
      hit.eventCount++;
      if (!hit.observers.includes(e.observer)) hit.observers.push(e.observer);
    } else {
      rooms.set(key, {
        key,
        ref: e.room,
        kind: "unknown",
        observers: [e.observer],
        eventCount: 1,
      });
    }
  }

  const from = Math.min(...vantages.map((v) => v.window.from + v.offset));
  const to = Math.max(...vantages.map((v) => v.window.to + v.offset));
  const anchor = [...vantages].sort((a, b) => a.source.localeCompare(b.source))[0];

  const warnings = [...skew.warnings];
  if (skew.maxResidualMs > MAX_ACCEPTABLE_SKEW_MS) {
    warnings.push(
      `Clock offsets did not converge: worst residual ${Math.round(skew.maxResidualMs)} ms.`
    );
  }

  return {
    id: `${anchor.source}@${from}`,
    window: { from, to },
    vantages,
    timeline,
    peers,
    rooms,
    maxSkewResidualMs: skew.maxResidualMs,
    warnings,
  };
}

function recordIdentity(
  peers: Map<string, PeerSummary>,
  v: LoadedVantage,
  ref: DiagPeerRef
): void {
  if (!ref.identityRef) return;
  const hit = peers.get(ref.peerId);
  if (!hit) return;
  const scoped = `${v.source}:${ref.identityRef}`;
  if (!hit.identityRefs.includes(scoped)) hit.identityRefs.push(scoped);
}

/**
 * Build the workspace.
 *
 * @param bundles loaded client bundles, each possibly with a stapled relay view
 * @param logEvents events parsed from raw server or console logs, already
 *   absolute-timed by `logs.ts`
 */
export function mergeSources(
  bundles: Array<{ bundle: DiagBundle; source: string }>,
  logEvents: MergedEvent[] = []
): Workspace {
  const warnings: string[] = [];
  const vantages: LoadedVantage[] = [];

  for (const { bundle, source } of bundles) {
    if (bundle.schemaVersion !== 1) {
      warnings.push(
        `${source}: schema version ${bundle.schemaVersion} is not understood, so it was refused.`
      );
      continue;
    }
    vantages.push(...vantagesOf(bundle, source));
  }

  // A log vantage per source, so a mis-parse is attributable to one file.
  const bySource = new Map<string, MergedEvent[]>();
  for (const e of logEvents) {
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }
  for (const [source, events] of bySource) {
    const times = events.map((e) => e.at);
    vantages.push({
      source,
      kind: "log",
      bundleKey: source,
      observer: events[0]?.observer ?? "",
      epoch: 0,
      offset: 0,
      // A log event is already absolute, so `t` carries the absolute time too.
      events: events.map((e) => ({ ...e, t: e.at })),
      window: {
        from: times.length > 0 ? Math.min(...times) : 0,
        to: times.length > 0 ? Math.max(...times) : 0,
      },
    });
  }

  const captures = group(vantages)
    .map(buildCapture)
    .sort((a, b) => b.window.from - a.window.from);

  return { captures, warnings };
}
