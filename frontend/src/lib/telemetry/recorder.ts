/**
 * The flight recorder. A module singleton, deliberately NOT a `$state` rune:
 * it is written from inside `emit`, from `catch` blocks and from a `finally`,
 * thousands of times per session, and a reactive proxy there would both cost
 * per-write work and invalidate components on every event.
 *
 * Recording is ALWAYS ON, in memory, from boot. A bug is over by the time
 * anyone thinks to flip a switch, so the switch cannot be on the recording -
 * it is on every EXIT: disk (`store.ts`), network (`upload.ts`) and file
 * (`bundle.ts` + the Diagnostics pane). Nothing here leaves the tab.
 */

import { ev } from "./event";
import { RefTable } from "./redact";
import { DiagRing, RING_CAPACITY } from "./ring";
import type {
  DiagEvent,
  DiagPeerRef,
  DiagRoomRef,
  DiagRuntimeConfig,
  SfuSnapshot,
} from "./schema";

/** The last N SFU snapshots kept for a bundle. They are large. */
const MAX_SFU_SNAPSHOTS = 8;

export interface RecorderContext {
  selfPeerId(): string;
  runtime(): DiagRuntimeConfig;
  faultsActive(): boolean;
}

export interface RecorderSnapshot {
  sessionId: string;
  /** Wall clock ms of `session.start`, or 0 before a session began. */
  startedAt: number;
  events: DiagEvent[];
  dropped: number;
  suppressed: Record<string, number>;
  nextSeq: number;
  ringCapacity: number;
  rooms: DiagRoomRef[];
  peers: DiagPeerRef[];
  /** Latest ABSOLUTE counter values, prefixed by bag. */
  counters: Record<string, number>;
  sfuSnapshots: SfuSnapshot[];
  selfPeerId: string;
  runtime: DiagRuntimeConfig;
  faultsActive: boolean;
}

const NO_CONTEXT: RecorderContext = {
  selfPeerId: () => "",
  runtime: () => ({
    apiHost: "",
    relayPeerId: "",
    sfuHosts: [],
    configured: false,
  }),
  faultsActive: () => false,
};

let ctx: RecorderContext = NO_CONTEXT;
let ring = new DiagRing();
let refTable = new RefTable();
let peers = new Map<string, DiagPeerRef>();
let counters: Record<string, number> = {};
let sfuSnapshots: SfuSnapshot[] = [];
let sessionId = "";
let startedAt = 0;
/** `performance.now()` at `session.start`, so `t` is monotonic. */
let perfBase = 0;

export function initRecorder(context: RecorderContext): void {
  ctx = context;
}

/**
 * Start a session. Called once from `LibP2PTransport.connect()`, which is also
 * where `sessionId` is minted - a reconnect inside one tab keeps the session,
 * so a bundle covers the whole story rather than the last attempt.
 */
export function beginSession(id: string, startedAtMs: number): void {
  sessionId = id;
  startedAt = startedAtMs;
  perfBase = now();
  ring.reset();
  refTable = new RefTable();
  peers = new Map();
  counters = {};
  sfuSnapshots = [];
}

/** Always true today. The seam exists so a future kill switch has one place. */
export function isRecording(): boolean {
  return true;
}

export function refs(): RefTable {
  return refTable;
}

/**
 * Record one event. NEVER throws, for any input, in any state - including
 * before `initRecorder` and before `beginSession`.
 */
export function rec(e: Omit<DiagEvent, "seq" | "t">): void {
  try {
    const nowMs = now();
    if (e.peer) {
      const hit = peers.get(e.peer);
      if (hit) hit.lastSeen = nowMs - perfBase;
      else
        peers.set(e.peer, {
          peerId: e.peer,
          identityRef: null,
          firstSeen: nowMs - perfBase,
          lastSeen: nowMs - perfBase,
        });
    }
    ring.push(e, nowMs - perfBase, nowMs);
  } catch {
    // The recorder never breaks the app.
  }
}

/**
 * Bind a peerId to an identity ordinal. ONLY a proven binding may call this -
 * see the `app.profile.in` probe. A forged binding would group two different
 * people's devices under one `identityRef`.
 */
export function noteIdentity(peerId: string, did: string): void {
  try {
    const ref = refTable.identityRef(did);
    const hit = peers.get(peerId);
    if (hit) hit.identityRef = ref;
    else {
      const t = now() - perfBase;
      peers.set(peerId, {
        peerId,
        identityRef: ref,
        firstSeen: t,
        lastSeen: t,
      });
    }
  } catch {
    // The recorder never breaks the app.
  }
}

/** Replace the absolute counter snapshot. The delta rides a `counters` event. */
export function recordCounters(absolute: Record<string, number>): void {
  counters = { ...absolute };
}

/** Keep the newest snapshots only; each one is far too large for a `d` bag. */
export function recordSfuSnapshot(snapshot: SfuSnapshot): void {
  sfuSnapshots.push(snapshot);
  if (sfuSnapshots.length > MAX_SFU_SNAPSHOTS) sfuSnapshots.shift();
}

/**
 * A plain-object view for `bundle.ts` and for the Diagnostics pane. Plain on
 * purpose: a `$state` proxy cannot be structured-cloned into IndexedDB.
 */
export function recorderSnapshot(): RecorderSnapshot {
  const snap = ring.snapshot();
  return {
    sessionId,
    startedAt,
    events: snap.events,
    dropped: snap.dropped,
    suppressed: snap.suppressed,
    nextSeq: snap.nextSeq,
    ringCapacity: RING_CAPACITY,
    rooms: refTable.rooms(),
    peers: [...peers.values()].map((p) => ({ ...p })),
    counters: { ...counters },
    sfuSnapshots: sfuSnapshots.map((s) => s),
    selfPeerId: safeSelfPeerId(),
    runtime: safeRuntime(),
    faultsActive: safeFaultsActive(),
  };
}

export function resetRecorderForTest(): void {
  ctx = NO_CONTEXT;
  ring = new DiagRing();
  refTable = new RefTable();
  peers = new Map();
  counters = {};
  sfuSnapshots = [];
  sessionId = "";
  startedAt = 0;
  perfBase = 0;
}

/** A synthetic event announcing that persistence could not start earlier. */
export function recUnlocked(): void {
  rec(ev("session.unlock"));
}

function now(): number {
  // Monotonic: immune to a wall-clock jump, which is exactly what a laptop
  // does when it wakes from sleep - the case this recorder exists to explain.
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function safeSelfPeerId(): string {
  try {
    return ctx.selfPeerId();
  } catch {
    return "";
  }
}

function safeRuntime(): RecorderSnapshot["runtime"] {
  try {
    return ctx.runtime();
  } catch {
    return NO_CONTEXT.runtime();
  }
}

function safeFaultsActive(): boolean {
  try {
    return ctx.faultsActive();
  } catch {
    return false;
  }
}
