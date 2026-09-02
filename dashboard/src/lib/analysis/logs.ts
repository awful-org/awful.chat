/**
 * Log parsers: turn raw container/browser output into `MergedEvent[]` that
 * merge into the same timeline as a bundle, via `mergeSources`'s `logEvents`
 * parameter (see `merge.ts`).
 *
 * `mergeSources` always forces every log-sourced vantage's `kind` to `"log"`
 * - distinguishing an SFU log from a relay log from a console paste is by
 * `source` (the file name each parser is called with), never by `vantage`.
 * That is why every event below carries `vantage: "log"` regardless of which
 * parser produced it: the tag that matters downstream is `source`.
 *
 * PRIVACY: `sfu/index.ts` and `relay/main.go` log FULL peer ids and room
 * codes in clear - that is the established precedent for the operator's own
 * container log, not a client-facing surface (see `docs/spec.md`). This file
 * is the ONE place in the dashboard a room code can enter memory. A room
 * code found in a log line goes into `d.roomRaw` ONLY, NEVER into the frozen
 * `room` field (`room` is reserved for a bundle-local ordinal ref like "r1"
 * and must never carry a real code - `findings.ts` and `topology.ts` both
 * treat it that way). It stays in memory for this session; an exporter
 * (prompt pack, saved workspace) MUST strip every `d.roomRaw` key before
 * anything leaves the process. That stripping is a downstream obligation on
 * the exporter, not something this file can enforce.
 *
 * PEER SUFFIXES: the relay (`short()`) and some frontend console lines
 * truncate a peerId to its last 8 characters before logging it. Neither
 * `parseRelayLog` nor `parseConsoleLog` receives a known-peer-id list (their
 * contract is exactly `(text, source)`), so they cannot resolve a suffix to
 * a full id themselves - they record it as `d.peerSuffix` and leave `peer`
 * `null`. `resolveSuffix` is exported for whatever loads both the bundles
 * and the logs (and therefore knows the capture's full peer ids) to do that
 * resolution afterwards, additively, without ever guessing wrong.
 */

import type { DiagKind, DiagSeverity } from "../schema";
import { LOG_RAW_KIND, type MergedEvent } from "./merge";

export interface ParsedLog {
  events: MergedEvent[];
  warnings: string[];
  unmatched: number;
}

// ---------------------------------------------------------------------------
// The raw-line sentinel
// ---------------------------------------------------------------------------

/**
 * `DiagKind` is a closed, frozen 112-literal WIRE contract, deliberately with
 * no generic "unknown" member: every kind on the wire is a choice made by code
 * that knows what it records. Log parsing faces the opposite problem - an
 * operator's container output is open-world text this dashboard did not write,
 * and an unrecognised line must still surface rather than be forced into a
 * kind that misrepresents it.
 *
 * `LOG_RAW_KIND` is therefore NOT a member of `DiagKind`. `MergedEvent.kind` is
 * `MergedKind`, which is `DiagKind` plus this one marker, so the widening is in
 * the type and not in a cast.
 */
const RAW_LOG_KIND = LOG_RAW_KIND;

const MAX_DETAIL_STRING = 200;

function truncate(s: string): string {
  return s.length > MAX_DETAIL_STRING ? s.slice(0, MAX_DETAIL_STRING) : s;
}

function inferSeverity(body: string): DiagSeverity {
  if (/fatal|panic|uncaught|unhandled/i.test(body)) return "error";
  if (/\berror\b|failed|refus(?:ed|ing)|bug:/i.test(body)) return "error";
  if (/\bwarn|drop|duplicate|ceiling|exhausted|\bcap\b/i.test(body)) return "warn";
  return "info";
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** `docker logs -t`'s prefix: RFC3339Nano, ending `Z` or a numeric offset. */
const DOCKER_TS_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s(.*)$/;

const DOCKER_TS_PARTS_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Go's std `log` package default flags (`Ldate|Ltime`) stamp a second
 * precision, process-local date/time ahead of every relay line - stripped
 * here for TEMPLATE MATCHING ONLY. It is never used as a clock: docker's own
 * `-t` wrapper is the one authoritative source per this file's contract, so
 * a relay line with no docker timestamp falls all the way through to
 * relative anchoring rather than using this coarser embedded one.
 */
const GO_LOG_PREFIX_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /;

function parseDockerTimestamp(iso: string): number | null {
  const m = iso.match(DOCKER_TS_PARTS_RE);
  if (!m) return null;
  // JS `Date` only resolves millisecond precision; docker emits nanoseconds.
  const millis = m[2] ? `.${m[2].slice(1, 4).padEnd(3, "0")}` : "";
  const t = Date.parse(`${m[1]}${millis}${m[3]}`);
  return Number.isFinite(t) ? t : null;
}

function stripPrefixes(line: string): { ts: number | null; body: string } {
  const dockerMatch = line.match(DOCKER_TS_RE);
  const ts = dockerMatch ? parseDockerTimestamp(dockerMatch[1]) : null;
  const rest = dockerMatch ? dockerMatch[2] : line;
  return { ts, body: rest.replace(GO_LOG_PREFIX_RE, "") };
}

// ---------------------------------------------------------------------------
// The templated-line engine, shared by parseSfuLog / parseRelayLog / parseConsoleLog
// ---------------------------------------------------------------------------

interface TemplateResult {
  peer?: string | null;
  d?: Record<string, string | number | boolean | null>;
}

interface LineTemplate {
  re: RegExp;
  kind: DiagKind;
  sev: DiagSeverity;
  build?: (m: RegExpMatchArray) => TemplateResult;
}

function rawEvent(
  seq: number,
  at: number,
  source: string,
  observer: string,
  body: string
): MergedEvent {
  return {
    seq,
    t: at,
    kind: RAW_LOG_KIND,
    sev: inferSeverity(body),
    peer: null,
    room: null,
    d: { raw: truncate(body) },
    at,
    vantage: "log",
    source,
    observer,
  };
}

/**
 * Shared per-line engine for the three text-template parsers. Every non-empty
 * line becomes exactly one event: a templated one when a template matches,
 * else a `rawEvent` - so a mis-parse is visible in the Logs view rather than
 * silently missing.
 *
 * @param skip lines this parser does not own (e.g. a `[sfu-telemetry]` line
 *   inside `parseSfuLog`) - skipped entirely: no event, no `unmatched` count.
 */
function parseTemplatedLog(
  text: string,
  source: string,
  observer: string,
  templates: readonly LineTemplate[],
  skip?: (body: string) => boolean
): ParsedLog {
  const warnings: string[] = [];
  const events: MergedEvent[] = [];
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(stripPrefixes);

  const hasAnyTs = stripped.some((line) => line.ts !== null);
  if (!hasAnyTs && stripped.length > 0) {
    warnings.push(
      `${source}: no "docker logs -t" timestamps found; times are relative to line order.`
    );
  }

  let seq = 0;
  let unmatched = 0;
  let lastTs: number | null = null;
  let relCounter = 0;

  for (const { ts, body } of stripped) {
    if (skip?.(body)) continue;
    seq++;

    let at: number;
    if (ts !== null) {
      at = ts;
      lastTs = ts;
    } else if (lastTs !== null) {
      at = lastTs;
    } else {
      at = relCounter++;
    }

    let matched = false;
    for (const tpl of templates) {
      const m = body.match(tpl.re);
      if (!m) continue;
      matched = true;
      const extra = tpl.build?.(m) ?? {};
      events.push({
        seq,
        t: at,
        kind: tpl.kind,
        sev: tpl.sev,
        peer: extra.peer ?? null,
        room: null,
        d: extra.d,
        at,
        vantage: "log",
        source,
        observer,
      });
      break;
    }
    if (!matched) {
      unmatched++;
      events.push(rawEvent(seq, at, source, observer, body));
    }
  }

  return { events, warnings, unmatched };
}

// ---------------------------------------------------------------------------
// parseSfuTelemetry - the structured `[sfu-telemetry] {json}` sweep line
// ---------------------------------------------------------------------------

const SFU_TELEMETRY_TAG_RE = /^\[sfu-telemetry\]/;
const SFU_TELEMETRY_LINE_RE = /^\[sfu-telemetry\]\s+(\{.*\})\s*$/;

interface SfuTelemetryPeer {
  peerId: string;
  producers: Array<{ id: string; source: string; kind: string; consumers: number }>;
}

function isSfuTelemetryPeer(v: unknown): v is SfuTelemetryPeer {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.peerId === "string" && Array.isArray(p.producers);
}

interface SfuTelemetryLine {
  v: number;
  t: number;
  room: string;
  peers: SfuTelemetryPeer[];
}

function isSfuTelemetryLine(v: unknown): v is SfuTelemetryLine {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.t === "number" &&
    Number.isFinite(o.t) &&
    typeof o.room === "string" &&
    Array.isArray(o.peers) &&
    o.peers.every(isSfuTelemetryPeer)
  );
}

/**
 * `[sfu-telemetry] {"v":1,"t":<unix ms>,"room":"<roomCode>","peers":[...]}` -
 * one line per room per heartbeat sweep, emitted only when `SFU_TELEMETRY=1`
 * (see `sfu/index.ts`'s `emitSfuTelemetrySweep`). Already structured and
 * self-timestamped (the `t` field is real unix ms from the SFU's own clock),
 * so no template matching and no docker `-t` dependency - the highest
 * fidelity of the three SFU-adjacent sources.
 *
 * Produces one `sfu.diag` event per line: a room-level summary, not a
 * per-peer one, so `peer` is always `null`; the room code goes into
 * `d.roomRaw` only (see the module doc comment).
 */
export function parseSfuTelemetry(text: string, source: string): ParsedLog {
  const warnings: string[] = [];
  const events: MergedEvent[] = [];
  let seq = 0;
  let unmatched = 0;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    const { body } = stripPrefixes(raw);
    if (!SFU_TELEMETRY_TAG_RE.test(body)) continue; // not our line - parseSfuLog's job
    seq++;

    const lineMatch = body.match(SFU_TELEMETRY_LINE_RE);
    let parsed: unknown;
    try {
      parsed = lineMatch ? JSON.parse(lineMatch[1]) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!isSfuTelemetryLine(parsed)) {
      unmatched++;
      events.push(rawEvent(seq, seq, source, "sfu", body));
      continue;
    }

    let producers = 0;
    let consumers = 0;
    for (const peer of parsed.peers) {
      producers += peer.producers.length;
      for (const p of peer.producers) consumers += p.consumers;
    }

    events.push({
      seq,
      t: parsed.t,
      kind: "sfu.diag",
      sev: "debug",
      peer: null,
      room: null,
      d: {
        roomRaw: truncate(parsed.room),
        roomPeers: parsed.peers.length,
        producers,
        consumers,
      },
      at: parsed.t,
      vantage: "log",
      source,
      observer: "sfu",
    });
  }

  return { events, warnings, unmatched };
}

// ---------------------------------------------------------------------------
// parseSfuLog - the free-form `[sfu]` / `[router]` lines
// ---------------------------------------------------------------------------

const SFU_LOG_TEMPLATES: readonly LineTemplate[] = [
  {
    re: /^\[sfu\] join with invalid roomCode or peerId, closing$/,
    kind: "sfu.join",
    sev: "warn",
    build: () => ({ d: { reason: "invalid-ids" } }),
  },
  {
    re: /^\[sfu\] room ceiling reached \((\d+)\); refusing new room (\S+)$/,
    kind: "sfu.join",
    sev: "error",
    build: (m) => ({ d: { reason: "server-full", maxRooms: Number(m[1]), roomRaw: truncate(m[2]) } }),
  },
  {
    re: /^\[sfu\] room (\S+) is at the peer ceiling \((\d+)\); refusing peer (\S+)$/,
    kind: "sfu.join",
    sev: "error",
    build: (m) => ({
      peer: m[3],
      d: { reason: "room-full", roomRaw: truncate(m[1]), maxPeers: Number(m[2]) },
    }),
  },
  {
    re: /^\[sfu\] duplicate peerId (\S+) in room (\S+) answered a liveness probe; refusing the new connection$/,
    kind: "sfu.join",
    sev: "warn",
    build: (m) => ({
      peer: m[1],
      d: { reason: "peer-id-in-use", phase: "liveness-probe", roomRaw: truncate(m[2]) },
    }),
  },
  {
    re: /^\[sfu\] peerId (\S+) in room (\S+) was claimed while probing; refusing the new connection$/,
    kind: "sfu.join",
    sev: "warn",
    build: (m) => ({
      peer: m[1],
      d: { reason: "peer-id-in-use", phase: "claimed-while-probing", roomRaw: truncate(m[2]) },
    }),
  },
  {
    re: /^\[sfu\] duplicate peerId (\S+) in room (\S+); the previous session is dead, replacing it$/,
    kind: "sfu.join",
    sev: "info",
    build: (m) => ({ peer: m[1], d: { reason: "replaced-dead-session", roomRaw: truncate(m[2]) } }),
  },
  {
    re: /^\[sfu\] peer (\S+) joined room (\S+)$/,
    kind: "sfu.join",
    sev: "info",
    build: (m) => ({ peer: m[1], d: { roomRaw: truncate(m[2]) } }),
  },
  {
    re: /^\[sfu\] create-transport: bad direction from peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "bad-direction", op: "create-transport" } }),
  },
  {
    re: /^\[sfu\] create-transport: a (\S+) transport is already being created for peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[2], d: { reason: "duplicate-transport-creating", direction: m[1] } }),
  },
  {
    re: /^\[sfu\] duplicate (\S+) transport for peer (\S+); closing the previous one$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[2], d: { reason: "duplicate-transport", direction: m[1] } }),
  },
  {
    re: /^\[sfu\] connect-transport: bad direction from peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "bad-direction", op: "connect-transport" } }),
  },
  {
    re: /^\[sfu\] connect-transport: (\S+) transport is already connected for peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[2], d: { reason: "already-connected", direction: m[1] } }),
  },
  {
    re: /^\[sfu\] connect-transport: no (\S+) transport for peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({
      peer: m[2],
      d: { reason: "no-transport", op: "connect-transport", direction: m[1] },
    }),
  },
  {
    re: /^\[sfu\] produce: no send transport for peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "no-send-transport", op: "produce" } }),
  },
  {
    // `reason: "invalid-produce"` matches the `ms:error` the SFU sends for
    // this exact rejection (`send(peer.ws, { type: "ms:error", reason:
    // "invalid-produce" })`), and the rule `sfu-session-latched` keys off
    // that literal string - so this parser reuses it rather than inventing
    // a differently-spelled reason for the same event.
    re: /^\[sfu\] produce: invalid source from peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "invalid-produce", op: "produce" } }),
  },
  {
    re: /^\[sfu\] peer (\S+) is at the producer ceiling \((\d+)\); refusing produce$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "producer-limit", ceiling: Number(m[2]) } }),
  },
  {
    re: /^\[sfu\] peer (\S+) has exceeded cumulative produce limit \((\d+)\); refusing produce$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({
      peer: m[1],
      d: { reason: "producer-limit", cumulative: true, ceiling: Number(m[2]) },
    }),
  },
  {
    re: /^\[sfu\] peer (\S+) produced (\S+) \((\S+)\)$/,
    kind: "sfu.produce",
    sev: "info",
    build: (m) => ({ peer: m[1], d: { producerId: m[2], source: m[3] } }),
  },
  {
    re: /^\[sfu\] consume: no recv transport for peer (\S+)$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "no-recv-transport", op: "consume" } }),
  },
  {
    re: /^\[sfu\] peer (\S+) already consuming producer (\S+); resending consumer options$/,
    kind: "sfu.consume",
    sev: "info",
    build: (m) => ({ peer: m[1], d: { producerId: m[2], resent: true } }),
  },
  {
    re: /^\[sfu\] peer (\S+) is at the consumer ceiling \((\d+)\); refusing consume$/,
    kind: "sfu.error",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "consumer-limit", ceiling: Number(m[2]) } }),
  },
  {
    re: /^\[sfu\] cannot consume producer (\S+) for peer (\S+)$/,
    kind: "sfu.consume.failed",
    sev: "error",
    build: (m) => ({ peer: m[2], d: { producerId: m[1] } }),
  },
  {
    re: /^\[sfu\] peer (\S+) consuming (\S+) \((\S+)\)$/,
    kind: "sfu.consume",
    sev: "info",
    build: (m) => ({ peer: m[1], d: { producerId: m[2], source: m[3] } }),
  },
  {
    re: /^\[sfu\] resume-consumer failed for peer (\S+):/,
    kind: "sfu.consume.failed",
    sev: "error",
    build: (m) => ({ peer: m[1], d: { reason: "resume-failed" } }),
  },
  {
    re: /^\[sfu\] oversized frame, closing$/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "oversized-frame" } }),
  },
  {
    re: /^\[sfu\] malformed frame from client$/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "malformed-frame" } }),
  },
  {
    re: /^\[sfu\] invalid JSON from client$/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "invalid-json" } }),
  },
  {
    re: /^\[sfu\] expected join as first message, got:/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "expected-join-first" } }),
  },
  {
    re: /^\[sfu\] unknown message type:/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "unknown-type" } }),
  },
  {
    re: /^\[sfu\] ws error:/,
    kind: "sfu.ws.error",
    sev: "error",
    build: () => ({ d: { reason: "ws-error" } }),
  },
];

/**
 * The free-form `[sfu]` / `[router]` lines from `sfu/index.ts`. Skips a
 * `[sfu-telemetry]` line entirely (no event, not counted in `unmatched`) -
 * that structured line is `parseSfuTelemetry`'s job. Call both on the same
 * text and concatenate their `events` for full coverage of one log file.
 */
export function parseSfuLog(text: string, source: string): ParsedLog {
  return parseTemplatedLog(text, source, "sfu", SFU_LOG_TEMPLATES, (body) =>
    SFU_TELEMETRY_TAG_RE.test(body)
  );
}

// ---------------------------------------------------------------------------
// parseRelayLog - the `[rv]` / `[relay]` / `[http]` / `[peer]` lines
// ---------------------------------------------------------------------------

const RELAY_LOG_TEMPLATES: readonly LineTemplate[] = [
  {
    re: /^\[rv\] (\S+) left room \[(.*)\] \((\d+) peers\)$/,
    kind: "rv.unregister",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1], roomRaw: truncate(m[2]), remaining: Number(m[3]) } }),
  },
  {
    re: /^\[rv\] BUG: outbound (\S+) frame to (\S+) is (\d+) bytes \(> (\d+)\), dropping$/,
    kind: "rv.send.fail",
    sev: "error",
    build: (m) => ({
      d: {
        peerSuffix: m[2],
        reason: "oversize-outbound",
        msgType: m[1],
        bytes: Number(m[3]),
        maxBytes: Number(m[4]),
      },
    }),
  },
  {
    re: /^\[rv\] (\S+) is not reading its stream, dropping it$/,
    kind: "rv.close",
    sev: "warn",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "outbox-full" } }),
  },
  {
    re: /^\[rv\] registry is at its (\d+)-registration ceiling, ignoring further REGISTERs$/,
    kind: "rv.register",
    sev: "warn",
    build: (m) => ({ d: { refused: "capped", scope: "global", ceiling: Number(m[1]) } }),
  },
  {
    re: /^\[rv\] (\S+) hit the (\d+)-room cap, ignoring further REGISTERs$/,
    kind: "rv.register",
    sev: "warn",
    build: (m) => ({
      d: { peerSuffix: m[1], refused: "capped", scope: "peer", ceiling: Number(m[2]) },
    }),
  },
  {
    re: /^\[rv\] (\S+) joined room \[(.*)\] \((\d+) peers\)$/,
    kind: "rv.register",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1], roomRaw: truncate(m[2]), peers: Number(m[3]) } }),
  },
  {
    re: /^\[rv\] (\S+) disconnected$/,
    kind: "peer.disconnect",
    sev: "warn",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[rv\] (\S+) opened rendezvous stream$/,
    kind: "rv.open",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[rv\] (\S+) already holds (\d+) rendezvous streams, refusing another$/,
    kind: "rv.open.fail",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "stream-cap", maxStreams: Number(m[2]) } }),
  },
  {
    // The relay's CURRENT text log has no failure reason on this line: an
    // idle timeout, a liveness timeout and a graceful close all read
    // identically (that ambiguity is exactly why the plan has
    // `relay/telemetry.go` add a structured `rv.close` with a real
    // `RelayCloseReason` - once that lands, prefer it over this parser for
    // the same session). `reason: "unknown"` documents the gap rather than
    // guessing "graceful" and hiding a wedge.
    re: /^\[rv\] (\S+) stream closed \((\d+) still open\)$/,
    kind: "rv.close",
    sev: "warn",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "unknown", remainingStreams: Number(m[2]) } }),
  },
  {
    re: /^\[rv\] message too large from (\S+): (\d+) bytes, closing stream$/,
    kind: "rv.frame.oversize",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1], bytes: Number(m[2]) } }),
  },
  {
    re: /^\[rv\] bad message from (\S+): /,
    kind: "rv.send.fail",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "bad-message", phase: "inbound" } }),
  },
  {
    re: /^\[rv\] (\S+) sent an unusable room id \((\d+) bytes\), ignoring$/,
    kind: "rv.send.fail",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "invalid-room-id", bytes: Number(m[2]) } }),
  },
  {
    re: /^\[rv\] unknown type from (\S+): (\S+)$/,
    kind: "rv.send.fail",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1], reason: "unknown-type", msgType: m[2] } }),
  },
  {
    re: /^\[rv\] (\S+) is changing rooms faster than (\d+)\/(\S+), ignoring$/,
    kind: "rv.send.fail",
    sev: "error",
    build: (m) => ({
      d: { peerSuffix: m[1], reason: "membership-rate-limited", limit: Number(m[2]), window: m[3] },
    }),
  },
  {
    re: /^\[rv\] (\S+) exhausted its empty-room register budget \((\d+)\/(\S+)\), ignoring$/,
    kind: "rv.register",
    sev: "warn",
    build: (m) => ({
      d: { peerSuffix: m[1], refused: "oracle", limit: Number(m[2]), window: m[3] },
    }),
  },
  {
    re: /^\[peer\] connect (\S+)$/,
    kind: "peer.connect",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[peer\] disconnect (\S+)$/,
    kind: "peer.disconnect",
    sev: "warn",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
];

/** The `[rv]` / `[relay]` / `[http]` / `[peer]` lines from `relay/main.go`. */
export function parseRelayLog(text: string, source: string): ParsedLog {
  return parseTemplatedLog(text, source, "relay", RELAY_LOG_TEMPLATES);
}

// ---------------------------------------------------------------------------
// parseConsoleLog - pasted browser console output, house `[tag] message` shape
// ---------------------------------------------------------------------------

const CONSOLE_LOG_TEMPLATES: readonly LineTemplate[] = [
  {
    re: /^\[storage\] dropped (\d+) undecryptable row\(s\)$/,
    kind: "storage.drop",
    sev: "error",
    build: (m) => ({ d: { count: Number(m[1]) } }),
  },
  {
    re: /^\[storage\] dropped undecryptable (\S+) row:/,
    kind: "storage.drop",
    sev: "error",
    build: (m) => ({ d: { store: m[1], count: 1 } }),
  },
  {
    re: /^\[dm\] storage locked: offline queue not persisted$/,
    kind: "storage.locked",
    sev: "error",
    build: () => ({ d: { what: "dm-queue" } }),
  },
  {
    re: /^\[mailbox\] collected (\d+) offline DM\(s\)$/,
    kind: "dm.mailbox.collect",
    sev: "info",
    build: (m) => ({ d: { count: Number(m[1]) } }),
  },
  { re: /^\[mailbox\] dropped blob:/, kind: "dm.mailbox.drop", sev: "error" },
  {
    re: /^\[mailbox\] delivery failed, keeping blob:/,
    kind: "dm.mailbox.collect",
    sev: "warn",
    build: () => ({ d: { delivered: false } }),
  },
  {
    re: /^\[Transport\] peer stopped answering: (\S+)$/,
    kind: "peer.drop.liveness",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[Transport\] reconciled missed peer: (\S+)$/,
    kind: "peer.connect",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[Transport\] upgraded to direct: (\S+)$/,
    kind: "peer.upgrade.ok",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[Transport\] re-dialing peer: (\S+)$/,
    kind: "peer.redial",
    sev: "info",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  {
    re: /^\[Transport\] stream never confirmed for (\S+)$/,
    kind: "stream.confirm.fail",
    sev: "error",
    build: (m) => ({ d: { peerSuffix: m[1] } }),
  },
  { re: /^\[Transport\] relay connected$/, kind: "relay.dial.ok", sev: "info" },
  { re: /^\[Transport\] relay dial failed:/, kind: "relay.dial.fail", sev: "error" },
  {
    re: /^\[Transport\] relay disconnected, scheduling reconnect$/,
    kind: "relay.reconnect.schedule",
    sev: "info",
  },
  { re: /^\[Rendezvous\] stream closed, reconnecting$/, kind: "rv.close", sev: "warn" },
  { re: /^\[Rendezvous\] send failed:/, kind: "rv.send.fail", sev: "error" },
  {
    re: /^\[MediasoupVideo\] rejoin attempt (\d+) failed:/,
    kind: "sfu.rejoin",
    sev: "warn",
    build: (m) => ({ d: { attempt: Number(m[1]) } }),
  },
];

/**
 * Pasted browser console output in the house `[tag] message` shape. The
 * observer is unknown from text alone (unlike the relay/SFU logs, which are
 * each exactly one server), so it is `""` - `mergeSources` treats a falsy
 * observer as "do not touch a peer for this".
 */
export function parseConsoleLog(text: string, source: string): ParsedLog {
  return parseTemplatedLog(text, source, "", CONSOLE_LOG_TEMPLATES);
}

// ---------------------------------------------------------------------------
// resolveSuffix
// ---------------------------------------------------------------------------

/**
 * Maps an 8-character peerId suffix (the relay's `short()`, and some
 * frontend console lines' `.slice(-8)`) to a full peerId, given the set of
 * full ids already known for a capture (from its loaded client bundles).
 *
 * Two known ids sharing the same last 8 characters are indistinguishable
 * from the suffix alone: returning a wrong attribution would be worse than
 * returning none, so that case reports `ambiguous: true` and no `peerId`,
 * for the caller to surface as a warning rather than a (possibly wrong)
 * link in the topology.
 */
export function resolveSuffix(
  suffix: string,
  knownPeerIds: string[]
): { peerId: string | null; ambiguous: boolean } {
  if (suffix.length === 0) return { peerId: null, ambiguous: false };
  const matches = knownPeerIds.filter((id) => id.endsWith(suffix));
  if (matches.length === 0) return { peerId: null, ambiguous: false };
  if (matches.length > 1) return { peerId: null, ambiguous: true };
  return { peerId: matches[0], ambiguous: false };
}
