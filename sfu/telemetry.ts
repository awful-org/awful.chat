// The SFU-side telemetry vantage. Types below are mirrored TWICE elsewhere:
//   - frontend/src/lib/telemetry/schema.ts (the wire contract - DiagEvent and
//     the "sfu" DiagKind literals live there; the DiagTransportView /
//     DiagProducerView / DiagConsumerView / SfuSnapshot types below are
//     copied from that file byte-for-byte)
//   - dashboard/src/lib/schema.ts (the analysis app's own copy of the same
//     types)
// A change to any type in this file MUST be made in all three, in the same
// commit. There is no version handshake: SfuSnapshot carries schemaVersion,
// and a reader that sees an unknown version refuses it rather than guessing.
//
// Split out of index.ts for the same reason heartbeat.ts is: index.ts boots
// a real mediasoup worker and opens a listening socket at import time, so it
// cannot be loaded by a test. This module has no side effects on import -
// every input is duck-typed (StatsSource, plain report objects) and every
// clock value is passed in, so a test can exercise it with fakes.
//
// PRIVACY: `DiagTransportView.tuple` carries the protocol and the LOCAL port
// only. A remote ICE candidate address must never appear in a produced view -
// see deploy/README.md on why coturn's own verbose logging is off for
// exactly this reason.

/** Must equal DIAG_SCHEMA_VERSION in frontend/src/lib/telemetry/schema.ts. */
export const SFU_DIAG_SCHEMA_VERSION = 1;

export interface DiagTransportView {
  dir: "send" | "recv";
  iceState: string;
  dtlsState: string;
  /** Protocol and LOCAL port only. NEVER a remote address. */
  tuple: { protocol: string; localPort: number } | null;
  bytesSent: number;
  bytesReceived: number;
  rtt: number | null;
}

export interface DiagProducerView {
  id: string;
  kind: string;
  source: string;
  score: number;
  consumers: number;
  bitrate: number;
  packetsLost: number;
}

export interface DiagConsumerView {
  id: string;
  producerId: string;
  kind: string;
  score: number;
  paused: boolean;
  producerPaused: boolean;
  bitrate: number;
  packetsLost: number;
}

export interface SfuSnapshot {
  schemaVersion: number;
  takenAt: number;
  roomPeerCount: number;
  self: {
    peerId: string;
    transports: DiagTransportView[];
    producers: DiagProducerView[];
    consumers: DiagConsumerView[];
    cumulativeProduces: number;
    backpressured: boolean;
  };
  room: Array<{
    peerId: string;
    producers: Array<{
      id: string;
      source: string;
      kind: string;
      consumers: number;
    }>;
  }>;
  ceilings: {
    peersPerRoom: number;
    producersPerPeer: number;
    consumersPerPeer: number;
    rooms: number;
    maxRooms: number;
  };
}

/** Duck-typed so a test needs no real mediasoup Transport/Producer/Consumer. */
export interface StatsSource {
  getStats(): Promise<unknown[]>;
}

// Safely reads one field off a value that might not even be an object - a
// mediasoup stat report is `unknown` at this boundary, and a version that
// renames or drops a field must degrade gracefully. ms:diag runs inside the
// same per-frame try/catch as every other handler, and a throw here would
// answer the request with nothing instead of a partial snapshot.
function pickField(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

// Coerces a field read via pickField to a finite number, or `fallback` when
// it is absent, `NaN`, `Infinity`, or the wrong type. Every numeric field
// pulled from an untrusted report goes through this one contract so a
// malformed report degrades the same way everywhere.
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Picks the transport-level fields telemetry needs out of a real
 * `WebRtcTransport.getStats()` report array. `reports[0]` is the transport's
 * own report; there is exactly one per WebRtcTransport.
 */
export function pickTransportStats(
  reports: unknown[],
): Pick<DiagTransportView, "tuple" | "bytesSent" | "bytesReceived" | "rtt"> {
  const report = Array.isArray(reports) ? reports[0] : undefined;

  const rawTuple = pickField(report, "iceSelectedTuple");
  const protocol = pickField(rawTuple, "protocol");
  const localPort = pickField(rawTuple, "localPort");
  // NEVER copy localIp/localAddress/remoteIp/remotePort onto `tuple` - see
  // the file header. Only the two fields named on DiagTransportView cross
  // this boundary.
  const tuple =
    typeof protocol === "string" && typeof localPort === "number"
      ? { protocol, localPort }
      : null;
  // mediasoup's WebRtcTransportStat carries no round-trip-time field today;
  // `rtt` is read defensively in case a future version adds one, and stays
  // null otherwise rather than fabricating a number.
  const rawRtt = pickField(report, "rtt");
  const rtt = typeof rawRtt === "number" && Number.isFinite(rawRtt) ? rawRtt : null;

  return {
    tuple,
    bytesSent: finiteNumber(pickField(report, "bytesSent"), 0),
    bytesReceived: finiteNumber(pickField(report, "bytesReceived"), 0),
    rtt,
  };
}

/**
 * Picks the RTP-stream fields out of a real `Producer.getStats()` /
 * `Consumer.getStats()` report array. `reports[0]` is the primary encoding's
 * report, which is what a single-line diagnostic summary needs.
 */
export function pickRtpStats(
  reports: unknown[],
): { bitrate: number; packetsLost: number } {
  const report = Array.isArray(reports) ? reports[0] : undefined;
  return {
    bitrate: finiteNumber(pickField(report, "bitrate"), 0),
    packetsLost: finiteNumber(pickField(report, "packetsLost"), 0),
  };
}

/**
 * Bounds a snapshot so an `ms:diag` reply can never approach MAX_FRAME_BYTES
 * (256 KiB, index.ts) even in a room at the peer ceiling. Truncates the
 * `room` array to `maxRoomPeers` entries and each entry's `producers` list to
 * `maxProducersPerPeer`, oldest-kept-first (array order, unchanged) - the
 * entries that remain stay a complete, undistorted view of the peers and
 * producers they describe, rather than every entry being trimmed a little.
 * `self.*` is never truncated: at most 2 transports and at most
 * MAX_PRODUCERS_PER_PEER/MAX_CONSUMERS_PER_PEER entries, already bounded by
 * index.ts's own ceilings.
 */
export function serializeSnapshot(
  s: SfuSnapshot,
  maxRoomPeers: number,
  maxProducersPerPeer: number,
): SfuSnapshot {
  return {
    ...s,
    room: s.room.slice(0, maxRoomPeers).map((entry) => ({
      ...entry,
      producers: entry.producers.slice(0, maxProducersPerPeer),
    })),
  };
}
