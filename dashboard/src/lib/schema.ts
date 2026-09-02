/**
 * Diagnostic wire schema - the flight recorder's only contract.
 *
 * MIRRORED, byte-for-byte, FROM `frontend/src/lib/telemetry/schema.ts`, as the
 * `ms:*` protocol is mirrored between `sfu/index.ts` and
 * `frontend/src/lib/transport/mediasoup.ts`. The SFU-side view types below are
 * mirrored a THIRD time, in `sfu/telemetry.ts`.
 *
 * A change here MUST be made in every copy, in the same commit. There is no
 * negotiation step and no version handshake: a bundle carries
 * `schemaVersion`, and a reader that sees an unknown version refuses the
 * bundle rather than guessing.
 *
 * PRIVACY - this file defines what CAN be transmitted, so it is the first
 * place a leak would appear. A room code, a `did:key:`, message content, file
 * content, a nickname, an avatar and an ICE candidate ADDRESS have no field
 * here and must never be given one. See `docs/spec.md` "Server Privacy".
 */

export const DIAG_SCHEMA_VERSION = 1;

export type DiagSeverity = "debug" | "info" | "warn" | "error";

export interface DiagEvent {
  /** 1-based, per session. A gap means the ring or the throttle dropped events. */
  seq: number;
  /** Milliseconds since the session's `startedAt`, integer. */
  t: number;
  kind: DiagKind;
  sev: DiagSeverity;
  /** FULL peerId when the event is about a peer, else null. */
  peer: string | null;
  /** Bundle-local room ordinal ("r1"). NEVER a room code. */
  room: string | null;
  /** Flat detail bag: JSON primitives only, <=12 keys, strings <=200 chars. */
  d?: Record<string, string | number | boolean | null>;
}

/**
 * The exhaustive event vocabulary. Each literal is a wire contract: the
 * dashboard's rule engine matches on these strings, so renaming one is a
 * breaking change that needs a `DIAG_SCHEMA_VERSION` bump.
 */
export type DiagKind =
  // session
  | "session.start"
  | "session.config"
  | "session.unlock"
  | "session.visibility"
  | "session.online"
  | "session.end"
  // relay
  | "relay.dial.attempt"
  | "relay.dial.ok"
  | "relay.dial.fail"
  | "relay.reservation.request"
  | "relay.reservation.ok"
  | "relay.reservation.timeout"
  | "relay.disconnect"
  | "relay.reconnect.schedule"
  | "relay.reconnect.fail"
  // rendezvous
  | "rv.open"
  | "rv.open.fail"
  | "rv.register"
  | "rv.unregister"
  | "rv.peers"
  | "rv.peer.joined"
  | "rv.peer.left"
  | "rv.send.fail"
  | "rv.frame.oversize"
  | "rv.close"
  // peer
  | "peer.dial.start"
  | "peer.dial.ok"
  | "peer.dial.fail"
  | "peer.connect"
  | "peer.disconnect"
  | "peer.relayed"
  | "peer.direct"
  | "peer.upgrade.attempt"
  | "peer.upgrade.ok"
  | "peer.upgrade.fail"
  | "peer.drop.liveness"
  | "peer.redial"
  | "peer.rtt"
  | "peer.clock"
  // direct stream
  | "stream.open"
  | "stream.open.fail"
  | "stream.proven"
  | "stream.lost"
  | "stream.confirm.fail"
  | "stream.reset"
  | "stream.write.fail"
  // app layer
  | "app.join"
  | "app.leave"
  | "app.roomusers"
  | "app.msg.in"
  | "app.msg.out"
  | "app.msg.reject"
  | "app.profile.in"
  | "app.profile.reject"
  | "app.digest.out"
  | "app.digest.in"
  | "app.sync.drop"
  // dm + mailbox
  | "dm.send"
  | "dm.queue"
  | "dm.flush"
  | "dm.mailbox.deposit"
  | "dm.mailbox.collect"
  | "dm.mailbox.drop"
  // ice / turn
  | "ice.turn.ok"
  | "ice.turn.unavailable"
  | "ice.turn.fail"
  | "ice.servers.changed"
  // voice (p2p mesh)
  | "voice.join"
  | "voice.leave"
  | "voice.pc.new"
  | "voice.offer.out"
  | "voice.offer.in"
  | "voice.answer.in"
  | "voice.signal.invalid"
  | "voice.ice.state"
  | "voice.pc.state"
  | "voice.ice.connected"
  | "voice.degraded"
  | "voice.failed"
  | "voice.restart"
  | "voice.teardown"
  | "voice.redial.ask"
  | "voice.redial.serve"
  | "voice.media.sample"
  | "voice.media.stall"
  | "voice.media.resume"
  // sfu
  | "sfu.pick"
  | "sfu.ws.open"
  | "sfu.ws.close"
  | "sfu.ws.error"
  | "sfu.join"
  | "sfu.caps"
  | "sfu.transport.create"
  | "sfu.transport.state"
  | "sfu.transport.timeout"
  | "sfu.produce"
  | "sfu.consume"
  | "sfu.consume.failed"
  | "sfu.error"
  | "sfu.rejoin"
  | "sfu.misplaced"
  | "sfu.track.added"
  | "sfu.track.stalled"
  | "sfu.diag"
  // files
  | "file.announce"
  | "file.request"
  | "file.progress"
  | "file.fail"
  // local infrastructure
  | "storage.locked"
  | "storage.quota"
  | "storage.drop"
  | "runtime.error"
  | "runtime.resources"
  | "counters"
  | "fault.injected"
  | "meta.suppressed";

/**
 * The number of members of `DiagKind`. `KIND_SEV` is asserted against it at
 * test time, so a kind added without a severity is a test failure rather than
 * an `undefined` severity on the wire.
 */
export const DIAG_KIND_COUNT = 116;

/**
 * Default severity per kind. Classes, in the order they were decided:
 *
 * - "error": a named failure - `*.fail`, `*.failed`, `*.timeout`, `*.reject`,
 *   `*.drop*`, `*.invalid`, `*.oversize`, plus `storage.locked` (an offline
 *   queue write was silently lost), `sfu.error` and `sfu.ws.error` (both are
 *   failures whose names predate this table), and `ice.turn.unavailable` (no
 *   TURN is a hard failure for a peer behind a symmetric NAT), and
 *   `runtime.error` (an exception nothing in the app caught).
 * - "warn": a degradation that still works - `*.degraded`, `*.stall*`,
 *   `*.retry`, `rv.close`, `peer.disconnect`, `storage.quota`.
 * - "debug": high-rate sampling - `peer.rtt`, `peer.clock`, `counters`,
 *   `sfu.diag`, `voice.ice.state`, `runtime.resources`,
 *   `voice.media.sample`.
 * - "info": everything else.
 *
 * `sev` decides the order `trimBundleForUpload` sacrifices events in, and it
 * is what the dashboard's severity filter reads. It is deliberately NOT what
 * the rule engine keys on - a finding's severity comes from `RULES`.
 */
export const KIND_SEV = {
  // session
  "session.start": "info",
  "session.config": "info",
  "session.unlock": "info",
  "session.visibility": "info",
  "session.online": "info",
  "session.end": "info",
  // relay
  "relay.dial.attempt": "info",
  "relay.dial.ok": "info",
  "relay.dial.fail": "error",
  "relay.reservation.request": "info",
  "relay.reservation.ok": "info",
  "relay.reservation.timeout": "error",
  "relay.disconnect": "info",
  "relay.reconnect.schedule": "info",
  "relay.reconnect.fail": "error",
  // rendezvous
  "rv.open": "info",
  "rv.open.fail": "error",
  "rv.register": "info",
  "rv.unregister": "info",
  "rv.peers": "info",
  "rv.peer.joined": "info",
  "rv.peer.left": "info",
  "rv.send.fail": "error",
  "rv.frame.oversize": "error",
  "rv.close": "warn",
  // peer
  "peer.dial.start": "info",
  "peer.dial.ok": "info",
  "peer.dial.fail": "error",
  "peer.connect": "info",
  "peer.disconnect": "warn",
  "peer.relayed": "info",
  "peer.direct": "info",
  "peer.upgrade.attempt": "info",
  "peer.upgrade.ok": "info",
  "peer.upgrade.fail": "error",
  "peer.drop.liveness": "error",
  "peer.redial": "info",
  "peer.rtt": "debug",
  "peer.clock": "debug",
  // direct stream
  "stream.open": "info",
  "stream.open.fail": "error",
  "stream.proven": "info",
  "stream.lost": "info",
  "stream.confirm.fail": "error",
  "stream.reset": "info",
  "stream.write.fail": "error",
  // app layer
  "app.join": "info",
  "app.leave": "info",
  "app.roomusers": "info",
  "app.msg.in": "info",
  "app.msg.out": "info",
  "app.msg.reject": "error",
  "app.profile.in": "info",
  "app.profile.reject": "error",
  "app.digest.out": "info",
  "app.digest.in": "info",
  "app.sync.drop": "error",
  // dm + mailbox
  "dm.send": "info",
  "dm.queue": "info",
  "dm.flush": "info",
  "dm.mailbox.deposit": "info",
  "dm.mailbox.collect": "info",
  "dm.mailbox.drop": "error",
  // ice / turn
  "ice.turn.ok": "info",
  "ice.turn.unavailable": "error",
  "ice.turn.fail": "error",
  "ice.servers.changed": "info",
  // voice
  "voice.join": "info",
  "voice.leave": "info",
  "voice.pc.new": "info",
  "voice.offer.out": "info",
  "voice.offer.in": "info",
  "voice.answer.in": "info",
  "voice.signal.invalid": "error",
  "voice.ice.state": "debug",
  "voice.pc.state": "info",
  "voice.ice.connected": "info",
  "voice.degraded": "warn",
  "voice.failed": "error",
  "voice.restart": "info",
  "voice.teardown": "info",
  "voice.redial.ask": "info",
  "voice.redial.serve": "info",
  "voice.media.sample": "debug",
  "voice.media.stall": "warn",
  "voice.media.resume": "info",
  // sfu
  "sfu.pick": "info",
  "sfu.ws.open": "info",
  "sfu.ws.close": "info",
  "sfu.ws.error": "error",
  "sfu.join": "info",
  "sfu.caps": "info",
  "sfu.transport.create": "info",
  "sfu.transport.state": "info",
  "sfu.transport.timeout": "error",
  "sfu.produce": "info",
  "sfu.consume": "info",
  "sfu.consume.failed": "error",
  "sfu.error": "error",
  "sfu.rejoin": "info",
  "sfu.misplaced": "error",
  "sfu.track.added": "info",
  "sfu.track.stalled": "warn",
  "sfu.diag": "debug",
  // files
  "file.announce": "info",
  "file.request": "info",
  "file.progress": "info",
  "file.fail": "error",
  // local infrastructure
  "storage.locked": "error",
  "storage.quota": "warn",
  "storage.drop": "error",
  "runtime.error": "error",
  "runtime.resources": "debug",
  counters: "debug",
  "fault.injected": "info",
  "meta.suppressed": "info",
} as const satisfies Record<DiagKind, DiagSeverity>;

/** Events per second, per kind, before the ring's throttle suppresses. */
export const DEFAULT_BUDGET = 20;
/** A failure is worth more than a sample, so it gets a bigger allowance. */
export const ERROR_BUDGET = 60;

/**
 * Per-kind overrides for kinds that can arrive in a storm. Without these one
 * hot kind evicts the whole ring, which is the failure mode the throttle
 * exists to prevent.
 */
export const KIND_BUDGET: Readonly<Partial<Record<DiagKind, number>>> = {
  "app.msg.in": 5,
  "app.msg.out": 5,
  "file.progress": 2,
  "voice.ice.state": 5,
  "peer.rtt": 2,
  // One broken frame can throw on every animation tick. A storm of the same
  // error says nothing the first five did not, and it would evict the ring
  // that explains WHY it started.
  "voice.media.sample": 4,
  "runtime.error": 5,
  "runtime.resources": 2,
};

// ---------------------------------------------------------------------------
// Bundle envelope
// ---------------------------------------------------------------------------

export interface DiagBundleHead {
  schemaVersion: typeof DIAG_SCHEMA_VERSION;
  /** 16 random bytes, hex, minted at export. */
  bundleId: string;
  /** 16 random bytes, hex, minted in `LibP2PTransport.connect()`. */
  sessionId: string;
  /** Wall clock ms at export. */
  createdAt: number;
  /** Wall clock ms of `session.start`. */
  startedAt: number;
}

export interface DiagRoomRef {
  /** Bundle-local ordinal, "r1". NEVER a room code. */
  ref: string;
  kind: "text" | "dm" | "sync";
  joinedAt: number;
}

export interface DiagPeerRef {
  /** FULL peerId. The relay and the SFU already have it. */
  peerId: string;
  /**
   * Bundle-local ordinal shared by peerIds that PROVED the same DID. It
   * preserves "these are one person's devices" without naming the person.
   */
  identityRef: string | null;
  firstSeen: number;
  lastSeen: number;
}

/**
 * What this build was configured to talk to. HOSTS only: a full URL can carry
 * a path or a query, and `isConfigured()` is the flag that tells a reader the
 * instance was never set up at all.
 */
export interface DiagRuntimeConfig {
  apiHost: string;
  relayPeerId: string;
  sfuHosts: string[];
  configured: boolean;
}

export interface ClientBundle extends DiagBundleHead {
  vantage: "client";
  app: { version: string; commit: string };
  /** `ua` truncated to 200 chars. */
  env: { ua: string };
  config: DiagRuntimeConfig;
  /** NO `did`, not even the uploader's own. */
  self: { peerId: string };
  rooms: DiagRoomRef[];
  peers: DiagPeerRef[];
  counters: Record<string, number>;
  events: DiagEvent[];
  /** The last 8 SFU snapshots, which are too large for a `d` bag. */
  sfuSnapshots: SfuSnapshot[];
  meta: {
    ringCapacity: number;
    /** Evicted by wraparound. */
    dropped: number;
    /** Per kind, by the throttle. */
    suppressed: Record<string, number>;
    faultsActive: boolean;
    /** Trimmed to fit an upload. */
    truncated: boolean;
  };
  /** Stapled by the relay at ingest; absent in a file export. */
  relayView?: RelayVantage;
}

export interface RelayVantage {
  vantage: "relay";
  relayPeerId: string;
  observedPeerId: string;
  registry: {
    totalRegistrations: number;
    streamsForPeer: number;
    atTotalCap: boolean;
  };
  rooms: Array<{ ref: string; size: number; members: string[] }>;
  streams: Array<{
    ref: string;
    openedAt: number;
    closedAt: number | null;
    closeReason: RelayCloseReason | null;
    rooms: number;
    registers: number;
    unregisters: number;
    capped: number;
    oracleSilenced: number;
  }>;
  events: DiagEvent[];
}

/**
 * Why a rendezvous stream ended. Today the relay collapses all of these into
 * one log line, which is the difference between "a peer left" and "a peer
 * wedged". See `relay/telemetry.go`.
 */
export type RelayCloseReason =
  | "graceful"
  | "liveness-timeout"
  | "idle-timeout"
  | "read-error"
  | "frame-oversize"
  | "frame-invalid"
  | "outbox-full"
  | "stream-cap"
  | "peer-disconnect"
  | "evicted";

/**
 * Anything the dashboard can load from a file. Only a client bundle is ever
 * exported; a relay vantage always arrives stapled inside one.
 */
export type DiagBundle = ClientBundle;

// ---------------------------------------------------------------------------
// SFU vantage - mirrored a third time in `sfu/telemetry.ts`
// ---------------------------------------------------------------------------

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
