/**
 * The deterministic finding engine.
 *
 * Every detector below walks `capture.timeline` (already skew-corrected and
 * sorted by `merge.ts`) and is a total, pure function of the capture: same
 * input, same findings, every time. No detector reaches outside the
 * `Capture` it is given, and none throws on a malformed `d` bag - a `d`
 * value can be any JSON primitive or absent, so every read below goes
 * through a `typeof` guard instead of assuming a shape.
 */

import type { Capture, MergedEvent } from "./merge";
import { MAX_ACCEPTABLE_SKEW_MS } from "./merge";
import { PEER_PROOF_GRACE_MS } from "./topology";
import type { DiagKind } from "../schema";
import type { FindingId, Rule } from "./rules";
import { RULES } from "./rules";

export interface Finding {
  id: FindingId;
  severity: Rule["severity"];
  subject: { peer?: string; pair?: [string, string]; room?: string; vantage?: string };
  /** Indices into `capture.timeline`. Clicking one jumps the Timeline view. */
  evidence: number[];
  detail: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Thresholds - every one named and derived, per the rule table.
// ---------------------------------------------------------------------------

/** Mirrors the relay's own reservation timeout in `libp2p/transport.ts`. */
export const RESERVATION_COMPLETE_DEADLINE_MS = 10_000;

/** Four dial failures in a row with no intervening success. */
export const DIAL_FAIL_STREAK_THRESHOLD = 4;

/** The window "in five minutes" is measured over, for both flap rules. */
export const FLAP_WINDOW_MS = 5 * 60_000;

/** Three relay disconnects inside `FLAP_WINDOW_MS`. */
export const RELAY_FLAP_MIN_COUNT = 3;

/** Three liveness drops inside `FLAP_WINDOW_MS`. */
export const LIVENESS_FLAP_MIN_COUNT = 3;

/** How long a room registration can go without a peer list before it is wedged. */
export const REGISTER_PEERS_DEADLINE_MS = 5_000;

/**
 * `4 * PEER_PROOF_GRACE_MS`: one grace window for the ordinary handshake, plus
 * three more before "still unproven" stops being a flicker and starts being a
 * real finding. `PEER_PROOF_GRACE_MS` is topology's own online/connecting
 * cutoff (`frontend/src/lib/peer-online-status.ts`).
 */
export const PROOF_DEADLINE_MS = 4 * PEER_PROOF_GRACE_MS;

/** How far apart two observers' `peer.connect` views of one pair may drift. */
export const ASYMMETRIC_WINDOW_MS = 10_000;

/** Three failed upgrade attempts for one peer. */
export const UPGRADE_FAIL_THRESHOLD = 3;

/** Two failed stream-confirm attempts for one peer. */
export const CONFIRM_FAIL_THRESHOLD = 2;

/** How long the rendezvous and gossip room counts may disagree. */
export const ROOM_VIEW_SPLIT_MS = 30_000;

/** How long a digest may go unanswered while a peer is proven. */
export const SYNC_STALL_MS = 60_000;

/** Mirrors `VOICE_SETUP_DEADLINE_MS` in the plan: 30s to reach ICE connected. */
export const VOICE_SETUP_DEADLINE_MS = 30_000;

/** Three ICE restarts for one voice peer. */
export const VOICE_RESTART_LOOP_THRESHOLD = 3;

/** `sfu.error` reasons that fall through to `failSession` with no branch. */
export const SFU_LATCHING_REASONS: readonly string[] = [
  "invalid-produce",
  "producer-limit",
  "consumer-limit",
];

/** Three SFU rejoins with no attempt cap in the client's ladder. */
export const SFU_REJOIN_LOOP_THRESHOLD = 3;

/** Two stalled tracks for one producer/peer. */
export const SFU_CONSUMER_STALL_THRESHOLD = 2;

/** How long the SFU room count and the voice roster may disagree. */
export const SFU_ROOM_SPLIT_MS = 30_000;

/** Live RTCPeerConnections that mean a leak, not a busy call. */
export const PC_LIVE_ALARM = 50;

/** How long a camera producer may stay announced and unconsumed. */
export const PRODUCER_CONSUME_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// Small, side-effect-free readers for the `d` bag. Never throw.
// ---------------------------------------------------------------------------

type DetailBag = MergedEvent["d"];

function str(d: DetailBag, key: string): string | null {
  const v = d?.[key];
  return typeof v === "string" ? v : null;
}

function num(d: DetailBag, key: string): number | null {
  const v = d?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(d: DetailBag, key: string): boolean | null {
  const v = d?.[key];
  return typeof v === "boolean" ? v : null;
}

function make(
  id: FindingId,
  subject: Finding["subject"],
  evidence: number[],
  detail: Finding["detail"]
): Finding {
  return { id, severity: RULES[id].severity, subject, evidence, detail };
}

// ---------------------------------------------------------------------------
// Generic detectors, reused by several rules.
// ---------------------------------------------------------------------------

type KeyMode = "observer" | "observer+peer" | "observer+room";

function keyOf(e: MergedEvent, mode: KeyMode): string | null {
  if (mode === "observer") return e.observer;
  if (mode === "observer+peer") return e.peer ? `${e.observer}|${e.peer}` : null;
  return e.room ? `${e.observer}|${e.room}` : null;
}

/**
 * Every `startKind` event that has no `endKinds` event, from the same key,
 * within `deadlineMs` at or after it. `deadlineMs` may be `Infinity` for "no
 * following event at all, ever".
 */
function findUnmatchedDeadline(
  timeline: MergedEvent[],
  startKind: DiagKind,
  endKinds: DiagKind[],
  deadlineMs: number,
  keyMode: KeyMode
): Array<{ startIndex: number; key: string }> {
  const endsByKey = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    // `MergedKind` is wider than `DiagKind`: a log line a parser did not
    // recognise carries `LOG_RAW_KIND`, and it matches no wire kind.
    if (!(endKinds as string[]).includes(e.kind)) return;
    const k = keyOf(e, keyMode);
    if (k === null) return;
    const list = endsByKey.get(k);
    if (list) list.push(i);
    else endsByKey.set(k, [i]);
  });

  const out: Array<{ startIndex: number; key: string }> = [];
  timeline.forEach((e, i) => {
    if (e.kind !== startKind) return;
    const k = keyOf(e, keyMode);
    if (k === null) return;
    const ends = endsByKey.get(k) ?? [];
    const matched = ends.some((endIdx) => {
      const endE = timeline[endIdx];
      return endE.at >= e.at && endE.at - e.at <= deadlineMs;
    });
    if (!matched) out.push({ startIndex: i, key: k });
  });
  return out;
}

function unmatchedDeadlineFindings(
  timeline: MergedEvent[],
  startKind: DiagKind,
  endKinds: DiagKind[],
  deadlineMs: number,
  keyMode: KeyMode,
  id: FindingId
): Finding[] {
  return findUnmatchedDeadline(timeline, startKind, endKinds, deadlineMs, keyMode).map(
    ({ startIndex, key }) => {
      const parts = key.split("|");
      const subject: Finding["subject"] =
        keyMode === "observer"
          ? { vantage: parts[0] }
          : keyMode === "observer+peer"
            ? { peer: parts[1], vantage: parts[0] }
            : { vantage: parts[0], room: parts[1] };
      return make(id, subject, [startIndex], {
        deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : null,
      });
    }
  );
}

/** `>= threshold` occurrences of `kind` for one `(observer, peer)` pair. */
function thresholdByPeerObserver(
  timeline: MergedEvent[],
  kind: DiagKind,
  threshold: number,
  id: FindingId
): Finding[] {
  const groups = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    if (e.kind !== kind || !e.peer) return;
    const key = `${e.observer}|${e.peer}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  const out: Finding[] = [];
  for (const [key, indices] of groups) {
    if (indices.length < threshold) continue;
    const [observer, peer] = key.split("|");
    out.push(make(id, { peer, vantage: observer }, indices, { count: indices.length }));
  }
  return out;
}

/** `>= threshold` occurrences of `kind` for one observer (no peer involved). */
function thresholdByObserver(
  timeline: MergedEvent[],
  kind: DiagKind,
  threshold: number,
  id: FindingId
): Finding[] {
  const groups = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    if (e.kind !== kind) return;
    const list = groups.get(e.observer);
    if (list) list.push(i);
    else groups.set(e.observer, [i]);
  });
  const out: Finding[] = [];
  for (const [observer, indices] of groups) {
    if (indices.length < threshold) continue;
    out.push(make(id, { vantage: observer }, indices, { count: indices.length }));
  }
  return out;
}

/** `>= minCount` occurrences of `kind` within `windowMs`, for one key. */
function windowedThreshold(
  timeline: MergedEvent[],
  kind: DiagKind,
  minCount: number,
  windowMs: number,
  id: FindingId,
  keyMode: "observer" | "observer+peer"
): Finding[] {
  const groups = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    if (e.kind !== kind) return;
    if (keyMode === "observer+peer" && !e.peer) return;
    const key = keyMode === "observer" ? e.observer : `${e.observer}|${e.peer}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  const out: Finding[] = [];
  for (const [key, indices] of groups) {
    for (let start = 0; start + minCount - 1 < indices.length; start++) {
      const end = start + minCount - 1;
      const startAt = timeline[indices[start]].at;
      const endAt = timeline[indices[end]].at;
      if (endAt - startAt <= windowMs) {
        const [observer, peer] = key.split("|");
        out.push(
          make(
            id,
            peer ? { peer, vantage: observer } : { vantage: observer },
            indices.slice(start, end + 1),
            { count: minCount, windowMs: endAt - startAt }
          )
        );
        break;
      }
    }
  }
  return out;
}

/** A fail-kind streak per observer, reset by an ok-kind. Fires once per streak. */
function failStreakFindings(
  timeline: MergedEvent[],
  okKind: DiagKind,
  failKind: DiagKind,
  threshold: number,
  id: FindingId
): Finding[] {
  const streaks = new Map<string, number[]>();
  const fired = new Set<string>();
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind === okKind) {
      streaks.set(e.observer, []);
      return;
    }
    if (e.kind !== failKind) return;
    const list = streaks.get(e.observer) ?? [];
    list.push(i);
    streaks.set(e.observer, list);
    if (list.length >= threshold && !fired.has(e.observer)) {
      fired.add(e.observer);
      out.push(make(id, { vantage: e.observer }, list.slice(-threshold), { count: list.length }));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Bespoke detectors.
// ---------------------------------------------------------------------------

function turnMissingAndNeeded(timeline: MergedEvent[]): Finding[] {
  const turnFailIdx: number[] = [];
  timeline.forEach((e, i) => {
    if (e.kind === "ice.turn.unavailable" || e.kind === "ice.turn.fail") turnFailIdx.push(i);
  });
  if (turnFailIdx.length === 0) return [];

  const relayedFirstIdx = new Map<string, number>();
  timeline.forEach((e, i) => {
    if (e.kind !== "peer.relayed" || !e.peer) return;
    const key = `${e.observer}|${e.peer}`;
    if (!relayedFirstIdx.has(key)) relayedFirstIdx.set(key, i);
  });

  const proven = new Set<string>();
  timeline.forEach((e) => {
    if (e.kind === "stream.proven" && e.peer) proven.add(`${e.observer}|${e.peer}`);
  });

  const out: Finding[] = [];
  for (const [key, idx] of relayedFirstIdx) {
    if (proven.has(key)) continue;
    const [observer, peer] = key.split("|");
    out.push(
      make("turn-missing-and-needed", { peer, vantage: observer }, [...turnFailIdx, idx], {
        turnFailures: turnFailIdx.length,
      })
    );
  }
  return out;
}

function asymmetricLink(c: Capture): Finding[] {
  const clientObservers = new Set(
    c.vantages.filter((v) => v.kind === "client").map((v) => v.observer)
  );
  if (clientObservers.size < 2) return [];

  const timeline = c.timeline;
  const connectsByObserver = new Map<string, Array<{ peer: string; at: number; idx: number }>>();
  timeline.forEach((e, i) => {
    if (e.kind !== "peer.connect" || !e.peer) return;
    const list = connectsByObserver.get(e.observer) ?? [];
    list.push({ peer: e.peer, at: e.at, idx: i });
    connectsByObserver.set(e.observer, list);
  });

  const out: Finding[] = [];
  const firedPairs = new Set<string>();
  for (const [observer, list] of connectsByObserver) {
    if (!clientObservers.has(observer)) continue;
    for (const { peer, at, idx } of list) {
      if (!clientObservers.has(peer)) continue;
      const pairKey = [observer, peer].sort().join("|");
      if (firedPairs.has(pairKey)) continue;
      const reverse = connectsByObserver.get(peer) ?? [];
      const hasReciprocal = reverse.some(
        (x) => x.peer === observer && Math.abs(x.at - at) <= ASYMMETRIC_WINDOW_MS
      );
      if (!hasReciprocal) {
        firedPairs.add(pairKey);
        out.push(
          make("asymmetric-link", { pair: [observer, peer] }, [idx], {
            windowMs: ASYMMETRIC_WINDOW_MS,
          })
        );
      }
    }
  }
  return out;
}

function rendezvousWedged(timeline: MergedEvent[]): Finding[] {
  // The register -> peers deadline is a CLIENT observation. A relay vantage
  // records `rv.register` and never records `rv.peers` at all - the PEERS
  // reply is something the relay sends, not something it logs - so running
  // this clause over a relay vantage fires on every healthy registration.
  // Captured fixtures made that false positive obvious: four findings for a
  // session where rendezvous worked.
  // Evidence indices must keep pointing into the FULL timeline, so the filter
  // carries an index map rather than renumbering the events.
  const keep: number[] = [];
  const clientOnly: MergedEvent[] = [];
  timeline.forEach((e, i) => {
    if (e.vantage !== "client") return;
    keep.push(i);
    clientOnly.push(e);
  });
  const out: Finding[] = unmatchedDeadlineFindings(
    clientOnly,
    "rv.register",
    ["rv.peers"],
    REGISTER_PEERS_DEADLINE_MS,
    "observer+room",
    "rendezvous-wedged"
  ).map((f): Finding => ({
    ...f,
    evidence: f.evidence.map((idx) => keep[idx] ?? idx),
    detail: { ...f.detail, reason: "register-timeout" },
  }));

  timeline.forEach((e, i) => {
    if (e.kind !== "rv.close" || e.vantage !== "relay") return;
    if (str(e.d, "reason") === "liveness-timeout") {
      out.push(
        make("rendezvous-wedged", { vantage: e.observer }, [i], { reason: "liveness-timeout" })
      );
    }
  });
  return out;
}

function roomViewSplit(timeline: MergedEvent[]): Finding[] {
  interface State {
    rv: number | null;
    app: number | null;
    mismatchStart: number | null;
    startIdx: number;
    fired: boolean;
  }
  const state = new Map<string, State>();
  const out: Finding[] = [];

  timeline.forEach((e, i) => {
    if (e.kind !== "rv.peers" && e.kind !== "app.roomusers") return;
    const s: State = state.get(e.observer) ?? {
      rv: null,
      app: null,
      mismatchStart: null,
      startIdx: -1,
      fired: false,
    };
    const count = num(e.d, "count");
    if (e.kind === "rv.peers") s.rv = count;
    else s.app = count;

    if (s.rv !== null && s.app !== null) {
      if (s.rv !== s.app) {
        if (s.mismatchStart === null) {
          s.mismatchStart = e.at;
          s.startIdx = i;
        } else if (!s.fired && e.at - s.mismatchStart > ROOM_VIEW_SPLIT_MS) {
          s.fired = true;
          out.push(
            make("room-view-split", { vantage: e.observer }, [s.startIdx, i], {
              rv: s.rv,
              app: s.app,
              sinceMs: e.at - s.mismatchStart,
            })
          );
        }
      } else {
        s.mismatchStart = null;
        s.fired = false;
      }
    }
    state.set(e.observer, s);
  });
  return out;
}

function messageRejected(timeline: MergedEvent[]): Finding[] {
  const groups = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    if (e.kind !== "app.msg.reject") return;
    const reason = str(e.d, "reason") ?? "unknown";
    const list = groups.get(reason);
    if (list) list.push(i);
    else groups.set(reason, [i]);
  });
  const out: Finding[] = [];
  for (const [reason, indices] of groups) {
    out.push(make("message-rejected", {}, indices, { reason, count: indices.length }));
  }
  return out;
}

/**
 * The gauge climbed past anything a real call needs.
 *
 * A call holds a few connections per peer: one for voice, one or two for
 * libp2p, two for the SFU. Fifty is far above every legitimate shape and far
 * below the 500 at which the browser starts to refuse them, so this fires
 * while the session can still be explained rather than after voice, the SFU
 * and libp2p have all failed on the same line.
 */
function peerConnectionLeak(timeline: MergedEvent[]): Finding[] {
  const seen = new Map<
    string,
    { evidence: number[]; peak: number; created: number }
  >();
  timeline.forEach((e, i) => {
    if (e.kind !== "runtime.resources") return;
    const live = num(e.d, "pcLive");
    if (live === null) return;
    const hit = seen.get(e.observer) ?? { evidence: [], peak: 0, created: 0 };
    if (live >= PC_LIVE_ALARM) hit.evidence.push(i);
    hit.peak = Math.max(hit.peak, live);
    hit.created = Math.max(hit.created, num(e.d, "pcCreated") ?? 0);
    seen.set(e.observer, hit);
  });
  const out: Finding[] = [];
  for (const [observer, hit] of seen) {
    if (hit.evidence.length === 0) continue;
    out.push(
      make("peerconnection-leak", { vantage: observer }, hit.evidence, {
        peakLive: hit.peak,
        created: hit.created,
      })
    );
  }
  return out;
}

/**
 * A camera producer was announced and no consumer ever followed.
 *
 * Camera is consumed automatically, so the announcement is a promise the
 * client makes to itself. Screen share is deliberately NOT covered here: it
 * is opt-in, and a share nobody clicks is the normal case, not a fault.
 *
 * This is the shape a wedged receive transport takes from the outside. Every
 * other signal stays healthy - the socket is open, the transport reads
 * connected, the roster is right - and the only visible fact is that a stream
 * everyone else can see never arrives.
 */
function producerNeverConsumed(c: Capture, timeline: MergedEvent[]): Finding[] {
  const announced = new Map<
    string,
    { at: number; index: number; peer: string | null; observer: string }
  >();
  const satisfied = new Set<string>();

  timeline.forEach((e, i) => {
    if (e.kind !== "sfu.consume") return;
    const producer = str(e.d, "producer");
    if (!producer) return;
    const key = `${e.observer}|${producer}`;
    const phase = str(e.d, "phase");
    if (phase === "announced") {
      if (str(e.d, "source") === "screen") return;
      if (!announced.has(key)) {
        announced.set(key, { at: e.at, index: i, peer: e.peer, observer: e.observer });
      }
      return;
    }
    // "ok" is a consumer that exists; "dedup" means another consume for the
    // same producer was already in flight and will report its own outcome.
    if (phase === "ok" || phase === "dedup") satisfied.add(key);
  });

  const out: Finding[] = [];
  for (const [key, hit] of announced) {
    if (satisfied.has(key)) continue;
    // A capture that ends inside the deadline proves nothing: the consume
    // may have been seconds away when the recording stopped.
    if (c.window.to - hit.at < PRODUCER_CONSUME_DEADLINE_MS) continue;
    out.push(
      make(
        "producer-never-consumed",
        { vantage: hit.observer, peer: hit.peer ?? undefined },
        [hit.index],
        { producer: key.split("|")[1] ?? "", waitedMs: c.window.to - hit.at }
      )
    );
  }
  return out;
}

/** Per-`(observer, peer)` proof transitions, in time order. */
function provenTransitions(timeline: MergedEvent[]): Map<string, Array<{ at: number; proven: boolean }>> {
  const map = new Map<string, Array<{ at: number; proven: boolean }>>();
  for (const e of timeline) {
    if (!e.peer) continue;
    let next: boolean | null = null;
    if (e.kind === "stream.proven") next = true;
    else if (e.kind === "stream.lost" || e.kind === "peer.disconnect" || e.kind === "peer.drop.liveness") {
      next = false;
    }
    if (next === null) continue;
    const key = `${e.observer}|${e.peer}`;
    const list = map.get(key);
    if (list) list.push({ at: e.at, proven: next });
    else map.set(key, [{ at: e.at, proven: next }]);
  }
  return map;
}

function anyPeerProvenAt(
  transitions: Map<string, Array<{ at: number; proven: boolean }>>,
  observer: string,
  at: number
): boolean {
  for (const [key, list] of transitions) {
    if (!key.startsWith(`${observer}|`)) continue;
    let proven = false;
    for (const t of list) {
      if (t.at > at) break;
      proven = t.proven;
    }
    if (proven) return true;
  }
  return false;
}

function syncStalled(timeline: MergedEvent[]): Finding[] {
  const transitions = provenTransitions(timeline);
  const insByObserver = new Map<string, number[]>();
  timeline.forEach((e, i) => {
    if (e.kind !== "app.digest.in") return;
    const list = insByObserver.get(e.observer) ?? [];
    list.push(i);
    insByObserver.set(e.observer, list);
  });

  // ONE finding per observer, not one per unanswered digest. A stalled sync
  // sends a digest every few seconds, so a per-event finding buried every
  // other rule under thirty copies of the same fact in a captured fixture.
  const stalls = new Map<string, { evidence: number[]; firstAt: number }>();
  timeline.forEach((e, i) => {
    if (e.kind !== "app.digest.out") return;
    if (!anyPeerProvenAt(transitions, e.observer, e.at)) return;
    const ins = insByObserver.get(e.observer) ?? [];
    const matched = ins.some((idx) => {
      const inE = timeline[idx];
      return inE.at >= e.at && inE.at - e.at <= SYNC_STALL_MS;
    });
    if (matched) return;
    const hit = stalls.get(e.observer);
    if (hit) hit.evidence.push(i);
    else stalls.set(e.observer, { evidence: [i], firstAt: e.at });
  });

  const out: Finding[] = [];
  for (const [observer, { evidence, firstAt }] of stalls) {
    out.push(
      make("sync-stalled", { vantage: observer }, evidence, {
        deadlineMs: SYNC_STALL_MS,
        unansweredDigests: evidence.length,
        firstAt,
      })
    );
  }
  return out;
}

function voiceRelayedOnly(timeline: MergedEvent[]): Finding[] {
  const indices: number[] = [];
  let allRelayed = true;
  timeline.forEach((e, i) => {
    if (e.kind !== "voice.ice.connected") return;
    indices.push(i);
    if (bool(e.d, "relayed") !== true) allRelayed = false;
  });
  if (indices.length === 0 || !allRelayed) return [];
  return [make("voice-relayed-only", {}, indices, { count: indices.length })];
}

function sfuSessionLatched(timeline: MergedEvent[]): Finding[] {
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind !== "sfu.error") return;
    const reason = str(e.d, "reason");
    if (reason && SFU_LATCHING_REASONS.includes(reason)) {
      out.push(make("sfu-session-latched", { vantage: e.observer }, [i], { reason }));
    }
  });
  return out;
}

function sfuTransportTimeout(timeline: MergedEvent[]): Finding[] {
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind !== "sfu.transport.timeout") return;
    out.push(
      make("sfu-transport-timeout", { vantage: e.observer }, [i], {
        direction: str(e.d, "direction"),
      })
    );
  });
  return out;
}

function sfuRoomSplit(timeline: MergedEvent[]): Finding[] {
  interface State {
    mismatchStart: number | null;
    startIdx: number;
    fired: boolean;
  }
  const voiceActive = new Map<string, Set<string>>();
  const state = new Map<string, State>();
  const out: Finding[] = [];

  timeline.forEach((e, i) => {
    if (e.peer && (e.kind === "voice.join" || e.kind === "voice.pc.new")) {
      const set = voiceActive.get(e.observer) ?? new Set<string>();
      set.add(e.peer);
      voiceActive.set(e.observer, set);
    } else if (e.peer && (e.kind === "voice.leave" || e.kind === "voice.teardown")) {
      voiceActive.get(e.observer)?.delete(e.peer);
    }

    if (e.kind !== "sfu.diag") return;
    const roomPeers = num(e.d, "roomPeers");
    if (roomPeers === null) return;
    // The observer's own voice roster, plus itself, is the call's peer count
    // as libp2p sees it - the SFU's room count should agree with it.
    const roster = (voiceActive.get(e.observer)?.size ?? 0) + 1;

    const s: State = state.get(e.observer) ?? { mismatchStart: null, startIdx: -1, fired: false };
    if (roster !== roomPeers) {
      if (s.mismatchStart === null) {
        s.mismatchStart = e.at;
        s.startIdx = i;
      } else if (!s.fired && e.at - s.mismatchStart > SFU_ROOM_SPLIT_MS) {
        s.fired = true;
        out.push(
          make("sfu-room-split", { vantage: e.observer }, [s.startIdx, i], {
            roster,
            roomPeers,
            sinceMs: e.at - s.mismatchStart,
          })
        );
      }
    } else {
      s.mismatchStart = null;
      s.fired = false;
    }
    state.set(e.observer, s);
  });
  return out;
}

function sfuPlacementDisagreement(c: Capture): Finding[] {
  const clientObservers = new Set(
    c.vantages.filter((v) => v.kind === "client").map((v) => v.observer)
  );
  const lastHost = new Map<string, { host: string; idx: number }>();
  c.timeline.forEach((e, i) => {
    if (e.kind !== "sfu.pick" || !clientObservers.has(e.observer)) return;
    const host = str(e.d, "host");
    if (host) lastHost.set(e.observer, { host, idx: i });
  });

  const entries = [...lastHost.entries()];
  const out: Finding[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [obsA, a] = entries[i];
      const [obsB, b] = entries[j];
      if (a.host !== b.host) {
        out.push(
          make("sfu-placement-disagreement", { pair: [obsA, obsB] }, [a.idx, b.idx], {
            hostA: a.host,
            hostB: b.host,
          })
        );
      }
    }
  }
  return out;
}

function clockSkew(c: Capture): Finding[] {
  if (c.maxSkewResidualMs <= MAX_ACCEPTABLE_SKEW_MS) return [];
  return [
    make("clock-skew", {}, [], {
      residualMs: Math.round(c.maxSkewResidualMs),
      thresholdMs: MAX_ACCEPTABLE_SKEW_MS,
    }),
  ];
}

function faultInjectionActive(c: Capture): Finding[] {
  const evidence: number[] = [];
  c.timeline.forEach((e, i) => {
    if (e.kind === "fault.injected") evidence.push(i);
  });
  const activeSources = c.vantages
    .filter((v) => v.bundle?.meta.faultsActive === true)
    .map((v) => v.source);
  if (evidence.length === 0 && activeSources.length === 0) return [];
  return [
    make("fault-injection-active", {}, evidence, {
      activeSources: activeSources.length > 0 ? activeSources.join(",") : null,
      injectedEvents: evidence.length,
    }),
  ];
}

function unconfiguredInstance(timeline: MergedEvent[]): Finding[] {
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind !== "session.config") return;
    if (bool(e.d, "configured") === false) {
      out.push(make("unconfigured-instance", { vantage: e.observer }, [i], {}));
    }
  });
  return out;
}

function storageLockedWrites(timeline: MergedEvent[]): Finding[] {
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind !== "storage.locked") return;
    out.push(make("storage-locked-writes", { vantage: e.observer }, [i], { what: str(e.d, "what") }));
  });
  return out;
}

function captureIncomplete(c: Capture): Finding[] {
  const evidence: number[] = [];
  c.timeline.forEach((e, i) => {
    if (e.kind === "meta.suppressed") evidence.push(i);
  });
  let droppedTotal = 0;
  let suppressedKinds = 0;
  for (const v of c.vantages) {
    if (!v.bundle) continue;
    droppedTotal += v.bundle.meta.dropped;
    suppressedKinds += Object.keys(v.bundle.meta.suppressed).length;
  }
  if (evidence.length === 0 && droppedTotal === 0 && suppressedKinds === 0) return [];
  return [make("capture-incomplete", {}, evidence, { droppedTotal, suppressedKinds })];
}

function relayCloseUnclean(timeline: MergedEvent[]): Finding[] {
  const out: Finding[] = [];
  timeline.forEach((e, i) => {
    if (e.kind !== "rv.close" || e.vantage !== "relay") return;
    const reason = str(e.d, "reason");
    if (reason && reason !== "graceful") {
      out.push(make("relay-close-unclean", { vantage: e.observer }, [i], { reason }));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Rule["severity"], number> = { block: 0, warn: 1, info: 2 };

export function runFindings(c: Capture): Finding[] {
  const timeline = c.timeline;
  if (timeline.length === 0) return [];

  const findings: Finding[] = [
    ...unmatchedDeadlineFindings(
      timeline,
      "relay.reservation.request",
      ["relay.reservation.ok"],
      RESERVATION_COMPLETE_DEADLINE_MS,
      "observer",
      "relay-reservation-never-completed"
    ),
    ...failStreakFindings(
      timeline,
      "relay.dial.ok",
      "relay.dial.fail",
      DIAL_FAIL_STREAK_THRESHOLD,
      "relay-unreachable"
    ),
    ...windowedThreshold(
      timeline,
      "relay.disconnect",
      RELAY_FLAP_MIN_COUNT,
      FLAP_WINDOW_MS,
      "relay-flapping",
      "observer"
    ),
    ...rendezvousWedged(timeline),
    ...turnMissingAndNeeded(timeline),
    ...unmatchedDeadlineFindings(
      timeline,
      "peer.connect",
      ["stream.proven"],
      PROOF_DEADLINE_MS,
      "observer+peer",
      "connected-not-proven"
    ),
    ...asymmetricLink(c),
    ...thresholdByPeerObserver(timeline, "peer.upgrade.fail", UPGRADE_FAIL_THRESHOLD, "upgrade-starved"),
    ...windowedThreshold(
      timeline,
      "peer.drop.liveness",
      LIVENESS_FLAP_MIN_COUNT,
      FLAP_WINDOW_MS,
      "liveness-flap",
      "observer+peer"
    ),
    ...thresholdByPeerObserver(
      timeline,
      "stream.confirm.fail",
      CONFIRM_FAIL_THRESHOLD,
      "stream-confirm-starved"
    ),
    ...roomViewSplit(timeline),
    ...messageRejected(timeline),
    ...syncStalled(timeline),
    ...unmatchedDeadlineFindings(
      timeline,
      "voice.pc.new",
      ["voice.ice.connected"],
      VOICE_SETUP_DEADLINE_MS,
      "observer+peer",
      "voice-never-connected"
    ),
    ...unmatchedDeadlineFindings(
      timeline,
      "voice.media.stall",
      ["voice.media.resume"],
      Infinity,
      "observer+peer",
      "voice-media-stalled"
    ),
    ...voiceRelayedOnly(timeline),
    ...thresholdByPeerObserver(
      timeline,
      "voice.restart",
      VOICE_RESTART_LOOP_THRESHOLD,
      "voice-restart-loop"
    ),
    ...sfuSessionLatched(timeline),
    ...sfuTransportTimeout(timeline),
    ...thresholdByObserver(timeline, "sfu.rejoin", SFU_REJOIN_LOOP_THRESHOLD, "sfu-rejoin-loop"),
    ...thresholdByPeerObserver(
      timeline,
      "sfu.track.stalled",
      SFU_CONSUMER_STALL_THRESHOLD,
      "sfu-consumer-stalled"
    ),
    ...sfuRoomSplit(timeline),
    ...sfuPlacementDisagreement(c),
    ...clockSkew(c),
    ...faultInjectionActive(c),
    ...unconfiguredInstance(timeline),
    ...storageLockedWrites(timeline),
    ...captureIncomplete(c),
    ...relayCloseUnclean(timeline),
    ...peerConnectionLeak(timeline),
    ...producerNeverConsumed(c, timeline),
    ...thresholdByObserver(timeline, "runtime.error", 1, "uncaught-error"),
  ];

  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}
