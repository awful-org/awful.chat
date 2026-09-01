/**
 * Bus taps and samplers - the pure translation layer between the three event
 * buses and `DiagKind`.
 *
 * Every function that maps an event name plus its arguments to an event body
 * is pure and exported, so it can be tested without a transport. That matters
 * more than it looks: `transport.svelte.ts` builds a libp2p node at import
 * time and cannot load under vitest (see `transport/call-error.ts`), so a
 * translator living next to the emitter would be untestable.
 *
 * REDACTION: a translator receives room CODES and message BYTES. It must
 * convert a code through `refs().roomRef()` and reduce a payload to a length.
 * `taps.test.ts` asserts that no translator ever copies either into `d`.
 */

import { errText, ev, MAX_DETAIL_KEYS } from "./event";
import { installPcCensus, pcCensus } from "./pc-census";
import { probeTurnAllocation } from "./net-probe";
import {
  initRecorder,
  rec,
  recordCounters,
  recordSfuSnapshot,
  refs,
  type RecorderContext,
} from "./recorder";
import type { DiagEvent, DiagKind, SfuSnapshot } from "./schema";
import type { TransportStatus } from "../transport/types";

/** How often the counter bags are diffed. */
export const COUNTER_SAMPLE_MS = 5000;
/** How often an SFU snapshot is requested while in a call. */
export const SFU_DIAG_SAMPLE_MS = 30_000;

type Body = Omit<DiagEvent, "seq" | "t">;

// ---------------------------------------------------------------------------
// TransportStatus - all 17 variants
// ---------------------------------------------------------------------------

/**
 * Nine of these variants are emitted today and read by NOTHING:
 * `TransportStatus.svelte` deletes each toast on a 10 s timer and
 * `transport.svelte.ts` switches on five. This table is where they stop being
 * discarded.
 */
export function statusEvent(status: TransportStatus): Body {
  const peer = "peerId" in status ? status.peerId : null;
  switch (status.type) {
    case "app-warning":
      return ev("session.config", { sev: "warn", d: { warning: true } });
    case "relay-connected":
      return ev("relay.dial.ok");
    case "relay-disconnected":
      return ev("relay.disconnect");
    case "relay-dial-retry":
      return ev("relay.dial.attempt");
    case "relay-dial-failed":
      return ev("relay.dial.fail");
    case "relay-reconnecting":
      return ev("relay.reconnect.schedule");
    case "relay-reconnect-failed":
      return ev("relay.reconnect.fail");
    case "reservation-timeout":
      return ev("relay.reservation.timeout");
    case "rendezvous-failed":
      return ev("rv.open.fail");
    case "rendezvous-reconnecting":
      return ev("rv.open", { sev: "warn", d: { reconnecting: true } });
    case "stream-open-failed":
      return ev("stream.open.fail", { peer });
    case "peer-dial-failed":
      return ev("peer.dial.fail", { peer });
    case "voice-dial-failed":
      return ev("voice.pc.new", { peer, sev: "error", d: { failed: true } });
    case "voice-peer-left":
      return ev("voice.teardown", { peer });
    case "voice-connection-failed":
      return ev("voice.failed", { peer });
    case "voice-ice-connected":
      return ev("voice.ice.connected", {
        peer,
        d: { relayed: status.relayed },
      });
    case "voice-degraded":
      return ev("voice.degraded", { peer });
  }
}

// ---------------------------------------------------------------------------
// Bus translators
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * `TransportEvents` -> an event body, or null for an event with no diagnostic
 * content.
 *
 * @param bus "sync" for the SECOND `LibP2PTransport` that device sync builds.
 *   Without the label its events are indistinguishable from the chat bus's.
 */
export function transportEvent(
  event: string,
  args: unknown[],
  bus?: string
): Body | null {
  const body = translateTransport(event, args);
  if (!body) return null;
  if (bus && bus !== "main") {
    body.d = { ...(body.d ?? {}), bus };
  }
  return body;
}

function translateTransport(event: string, args: unknown[]): Body | null {
  const peer = asString(args[0]);
  switch (event) {
    case "connect":
      return ev("peer.connect", { peer });
    case "disconnect":
      return ev("peer.disconnect", { peer });
    case "streamProven":
      return ev("stream.proven", { peer });
    case "streamLost":
      return ev("stream.lost", { peer });
    case "relayChanged":
      return args[1] === true
        ? ev("peer.relayed", { peer })
        : ev("peer.direct", { peer });
    case "roomPeers": {
      const room = asString(args[0]);
      const list = Array.isArray(args[1]) ? args[1] : [];
      return ev("rv.peers", {
        room: room ? refs().roomRef(room) : null,
        d: { count: list.length },
      });
    }
    case "message": {
      // The payload NEVER enters an event. Its length is the diagnostic fact.
      const data = args[1] as { byteLength?: number } | undefined;
      const room = asString(args[2]);
      return ev("app.msg.in", {
        peer,
        room: room ? refs().roomRef(room) : null,
        d: { bytes: typeof data?.byteLength === "number" ? data.byteLength : 0 },
      });
    }
    case "status":
      return args[0] ? statusEvent(args[0] as TransportStatus) : null;
    default:
      return null;
  }
}

/** Record one chat-bus event. Called from inside `LibP2PTransport.emit`. */
export function recTransportEvent(
  event: string,
  args: unknown[],
  suppressed: boolean,
  bus?: string
): void {
  const body = transportEvent(event, args, bus);
  if (body) rec(body);
  // Recorded AFTER the translated event and BEFORE the early return, so a
  // reader sees both what was emitted and that it was then swallowed.
  if (suppressed) rec(ev("fault.injected", { d: { event } }));
}

/**
 * `VoiceEvents` -> an event body.
 *
 * `deviceChanged` records only the device CLASS, never the deviceId: a
 * deviceId is a stable per-browser fingerprint.
 */
export function voiceEvent(event: string, args: unknown[]): Body | null {
  const peer = asString(args[0]);
  switch (event) {
    case "peerJoined":
      return ev("voice.join", { peer });
    case "peerLeft":
      return ev("voice.leave", { peer });
    case "trackAdded":
      // A remote track arriving IS media starting to flow, which is what
      // `voice.media.resume` means to the rule engine.
      return ev("voice.media.resume", { peer, d: { via: "trackAdded" } });
    case "trackRemoved":
      return ev("voice.teardown", { peer, d: { via: "trackRemoved" } });
    case "deviceChanged":
      return ev("session.config", { d: { audioDevice: asString(args[0]) } });
    case "error":
      return ev("voice.failed", { d: { message: errText(args[0]) } });
    case "status":
      return args[0] ? statusEvent(args[0] as TransportStatus) : null;
    default:
      return null;
  }
}

export function recVoiceEvent(event: string, args: unknown[]): void {
  const body = voiceEvent(event, args);
  if (body) rec(body);
}

/**
 * `VideoEvents` -> an event body.
 *
 * `peerJoined`, `peerLeft` and `outputVolumeChanged` are deliberately NOT
 * translated. The first two duplicate the voice roster, and the SFU's own view
 * of the roster is captured authoritatively by an `sfu.diag` snapshot
 * (`roomPeerCount` plus `room[]`) - which is what the `sfu-room-split` rule
 * reads, and is better evidence than an event pair that can be missed.
 */
export function videoEvent(event: string, args: unknown[]): Body | null {
  const peer = asString(args[0]);
  switch (event) {
    case "trackAdded":
      return ev("sfu.track.added", { peer, d: { source: asString(args[2]) } });
    case "trackRemoved":
      return ev("sfu.consume", {
        peer,
        d: {
          phase: "track-removed",
          source: asString(args[1]),
          mediaKind: asString(args[2]),
        },
      });
    case "trackStalled":
      return ev("sfu.track.stalled", { peer, d: { source: asString(args[1]) } });
    case "error":
      return ev("sfu.error", { d: { message: errText(args[0]) } });
    case "healed":
      return ev("sfu.join", { d: { phase: "healed" } });
    case "transmissionAvailable":
      return ev("sfu.consume", { peer, d: { phase: "available" } });
    case "transmissionEnded":
      return ev("sfu.consume", { peer, d: { phase: "ended" } });
    case "transmissionWatched":
      return ev("sfu.consume", { peer, d: { phase: "watched" } });
    case "transmissionWatchEnded":
      return ev("sfu.consume", { peer, d: { phase: "watch-ended" } });
    default:
      return null;
  }
}

export function recVideoEvent(event: string, args: unknown[]): void {
  const body = videoEvent(event, args);
  if (body) rec(body);
}

// ---------------------------------------------------------------------------
// Counter sampler
// ---------------------------------------------------------------------------

/**
 * Diff two flat counter snapshots.
 *
 * Keys are already bag-prefixed (`t.connects`, `a.profilesRejected`,
 * `f.droppedFrames`) so three bags with a `connects` each cannot collide.
 */
export function diffCounters(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in after) {
    const delta = after[key] - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

/** Flatten `{ t: {a: 1}, f: {b: 2} }` to `{ "t.a": 1, "f.b": 2 }`. */
export function flattenBags(
  bags: Record<string, Record<string, number>>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const prefix in bags) {
    const bag = bags[prefix];
    for (const key in bag) {
      const value = bag[key];
      if (typeof value === "number") out[`${prefix}.${key}`] = value;
    }
  }
  return out;
}

/**
 * Split a delta into `counters` events. A `d` bag holds 12 keys, and three
 * bags carry 24 counters, so a busy tick needs more than one event - dropping
 * the overflow would silently lose exactly the counter that moved.
 */
export function counterEvents(delta: Record<string, number>): Body[] {
  const keys = Object.keys(delta);
  const out: Body[] = [];
  for (let i = 0; i < keys.length; i += MAX_DETAIL_KEYS) {
    const d: Record<string, number> = {};
    for (const key of keys.slice(i, i + MAX_DETAIL_KEYS)) d[key] = delta[key];
    out.push(ev("counters", { d }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uncaught failures and the resource gauge
// ---------------------------------------------------------------------------

/**
 * An exception nothing in the app caught.
 *
 * Every other probe here records a decision the code made ON PURPOSE. This one
 * records the ones it did not: a `DOMException` from `setRemoteDescription`, a
 * constructor refusing because a browser budget is spent, a rejection in a
 * `void`-ed promise. Those are exactly the failures with no handler to tap,
 * which is why they are also the ones that reach a user with nothing written
 * down anywhere.
 *
 * The message is SCRUBBED, not merely truncated: an error composed by the
 * platform quotes whatever the app passed it, and a failed fetch quotes its
 * URL - which is how a room code gets into text that has no field for one.
 */
export function errorEvent(source: "uncaught" | "rejection", value: unknown): Body {
  return ev("runtime.error", {
    d: { source, err: refs().scrub(errText(value)) },
  });
}

let lastCensus = "";

/**
 * The `RTCPeerConnection` gauge, on change only.
 *
 * A silent gauge means a steady one: at four connections per peer this would
 * otherwise repeat the same three numbers every tick for the whole session,
 * and the ring is the scarce thing here. What matters is the shape over time -
 * `live` that only ever climbs is a leak, and `created` climbing while `live`
 * holds is a rebuild loop.
 */
export function censusEvent(): Body | null {
  const c = pcCensus();
  if (!c.installed) return null;
  const key = `${c.live}/${c.created}`;
  if (key === lastCensus) return null;
  lastCensus = key;
  return ev("runtime.resources", {
    d: { pcLive: c.live, pcCreated: c.created, pcPeak: c.peak },
  });
}

/**
 * Not more often than this, however many links fail at once: one allocation
 * per minute is enough to date a TURN outage, and the probe builds a
 * connection of its own.
 */
export const TURN_PROBE_MIN_INTERVAL_MS = 60_000;

let lastTurnProbeAt = -Infinity;

/**
 * Ask the network directly, and record the answer next to the app's own.
 *
 * Called at the two moments the answer is worth having: when credentials
 * first land, and when a voice link gives up. The second is the one that
 * matters - a probe taken at the instant the app failed is what separates
 * "TURN was down for this user" from "the app never used it".
 */
export async function probeTurn(
  servers: readonly RTCIceServer[],
  now: number = Date.now()
): Promise<void> {
  try {
    if (now - lastTurnProbeAt < TURN_PROBE_MIN_INTERVAL_MS) return;
    lastTurnProbeAt = now;
    const res = await probeTurnAllocation(servers);
    // Nothing to ask: the credential path reports that on its own.
    if (!res) return;
    rec(
      res.ok
        ? ev("ice.turn.ok", { d: { branch: "allocate", ms: res.ms } })
        : ev("ice.turn.fail", {
            d: {
              branch: "allocate",
              ms: res.ms,
              outcome: res.outcome,
              err: res.err ?? null,
            },
          })
    );
  } catch {
    // A sampler never breaks the app.
  }
}

/** The rate limiter is module state; a test needs to clear it. */
export function resetTurnProbeForTest(): void {
  lastTurnProbeAt = -Infinity;
}

function onWindowError(e: ErrorEvent): void {
  rec(errorEvent("uncaught", e.error ?? e.message));
}

function onRejection(e: PromiseRejectionEvent): void {
  rec(errorEvent("rejection", e.reason));
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface TelemetryTapOptions extends RecorderContext {
  /**
   * Counter bags by prefix. Passed in rather than imported: `_stats` is module
   * private to `transport.svelte.ts`, and importing that module here would be
   * a cycle through a libp2p node built at import time.
   */
  counterBags(): Record<string, Record<string, number>>;
  /** True while an SFU snapshot is worth asking for. */
  inCall(): boolean;
  /** `document.hidden`, injected so a test needs no DOM. */
  hidden(): boolean;
  /** Resolves null when the SFU refuses, times out, or is not connected. */
  requestSfuDiag(): Promise<SfuSnapshot | null>;
}

let counterTimer: ReturnType<typeof setInterval> | null = null;
let sfuTimer: ReturnType<typeof setInterval> | null = null;
let lastCounters: Record<string, number> = {};

/**
 * Wire the recorder to its context and start the samplers. Called once, from
 * `transport.svelte.ts`, immediately after the three singletons exist.
 *
 * Idempotent - a second call replaces the timers rather than doubling the
 * sample rate.
 */
export function installTelemetryTaps(opts: TelemetryTapOptions): void {
  stopTelemetryTaps();
  initRecorder(opts);
  lastCounters = {};
  lastCensus = "";
  // Before the first dial: a connection built earlier than this is invisible
  // to the gauge for the rest of the session.
  installPcCensus();
  if (typeof window !== "undefined") {
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
  }

  counterTimer = setInterval(() => {
    try {
      // The same guard the presence reconcile loop uses: a hidden tab is
      // throttled to the point where a sample says more about the browser's
      // timer policy than about the app.
      if (opts.hidden()) return;
      const now = flattenBags(opts.counterBags());
      const delta = diffCounters(lastCounters, now);
      lastCounters = now;
      recordCounters(now);
      for (const body of counterEvents(delta)) rec(body);
      const census = censusEvent();
      if (census) rec(census);
    } catch {
      // A sampler never breaks the app.
    }
  }, COUNTER_SAMPLE_MS);

  sfuTimer = setInterval(() => {
    if (!opts.inCall()) return;
    void sampleSfu(opts);
  }, SFU_DIAG_SAMPLE_MS);
}

/** Take one SFU snapshot now. Also called once during an export. */
export async function sampleSfu(
  opts: Pick<TelemetryTapOptions, "requestSfuDiag">
): Promise<void> {
  try {
    const snapshot = await opts.requestSfuDiag();
    if (!snapshot) return;
    recordSfuSnapshot(snapshot);
    const send = snapshot.self.transports.find((t) => t.dir === "send");
    const recv = snapshot.self.transports.find((t) => t.dir === "recv");
    rec(
      ev("sfu.diag", {
        d: {
          producers: snapshot.self.producers.length,
          consumers: snapshot.self.consumers.length,
          roomPeers: snapshot.roomPeerCount,
          iceSend: send ? send.iceState : null,
          iceRecv: recv ? recv.iceState : null,
        },
      })
    );
  } catch {
    // A sampler never breaks the app.
  }
}

export function stopTelemetryTaps(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onRejection);
  }
  if (counterTimer !== null) clearInterval(counterTimer);
  if (sfuTimer !== null) clearInterval(sfuTimer);
  counterTimer = null;
  sfuTimer = null;
}

/** Exported for the exhaustiveness test: every kind a tap can produce. */
export const TAP_KINDS: readonly DiagKind[] = [
  "peer.connect",
  "peer.disconnect",
  "stream.proven",
  "stream.lost",
  "peer.relayed",
  "peer.direct",
  "rv.peers",
  "app.msg.in",
  "voice.join",
  "voice.leave",
  "voice.media.resume",
  "voice.teardown",
  "session.config",
  "voice.failed",
  "sfu.track.added",
  "sfu.consume",
  "sfu.track.stalled",
  "sfu.error",
  "sfu.join",
  "counters",
  "sfu.diag",
  "fault.injected",
  "runtime.error",
  "runtime.resources",
];
