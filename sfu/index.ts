import * as mediasoup from "mediasoup";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";

// ── Types mirrored from client mediasoup.ts ───────────────────────────────────

interface MSGetCapabilities {
  type: "ms:get-capabilities";
}
interface MSCapabilities {
  type: "ms:capabilities";
  rtpCapabilities: mediasoup.types.RtpCapabilities;
}
interface MSCreateTransport {
  type: "ms:create-transport";
  direction: "send" | "recv";
}

// The options object sent to the browser client (matches mediasoup-client TransportOptions)
interface ClientTransportOptions {
  id: string;
  iceParameters: mediasoup.types.IceParameters;
  iceCandidates: mediasoup.types.IceCandidate[];
  dtlsParameters: mediasoup.types.DtlsParameters;
}

interface MSTransportOptions {
  type: "ms:transport-options";
  direction: "send" | "recv";
  options: ClientTransportOptions;
}
interface MSConnectTransport {
  type: "ms:connect-transport";
  direction: "send" | "recv";
  dtlsParameters: mediasoup.types.DtlsParameters;
}
interface MSProduce {
  type: "ms:produce";
  kind: mediasoup.types.MediaKind;
  rtpParameters: mediasoup.types.RtpParameters;
  source: "camera" | "screen";
}
interface MSProduced {
  type: "ms:produced";
  producerId: string;
}
interface MSConsume {
  type: "ms:consume";
  producerId: string;
  rtpCapabilities: mediasoup.types.RtpCapabilities;
}

// The options object sent to the browser client (matches mediasoup-client ConsumerOptions)
interface ClientConsumerOptions {
  id: string;
  producerId: string;
  kind: mediasoup.types.MediaKind;
  rtpParameters: mediasoup.types.RtpParameters;
}

interface MSConsumerOptions {
  type: "ms:consumer-options";
  options: ClientConsumerOptions;
  peerId: string;
  source: "camera" | "screen";
}
interface MSNewProducer {
  type: "ms:new-producer";
  peerId: string;
  producerId: string;
  source: "camera" | "screen";
}
interface MSProducerClosed {
  type: "ms:producer-closed";
  peerId: string;
  producerId: string;
  source: "camera" | "screen";
}
interface MSProducerConsumed {
  type: "ms:producer-consumed";
  peerId: string;
  producerId: string;
}
interface MSProducerConsumerClosed {
  type: "ms:producer-consumer-closed";
  peerId: string;
  producerId: string;
}
interface MSCloseConsumer {
  type: "ms:close-consumer";
  producerId: string;
}
interface MSCloseProducer {
  type: "ms:close-producer";
  producerId: string;
}
interface MSPeerLeft {
  type: "ms:peer-left";
  peerId: string;
}

// Envelope sent by the client over this WebSocket connection.
// All messages from client arrive as: { type: "join" } or { type: "ms:*", ... }
type ClientJoin = { type: "join"; roomCode: string; peerId: string };
type ClientMsg =
  | ClientJoin
  | MSGetCapabilities
  | MSCreateTransport
  | MSConnectTransport
  | MSProduce
  | MSConsume
  | MSCloseConsumer
  | MSCloseProducer;

// ── Per-peer state ────────────────────────────────────────────────────────────

interface PeerState {
  peerId: string;
  roomCode: string;
  ws: WebSocket;
  sendTransport: mediasoup.types.WebRtcTransport | null;
  recvTransport: mediasoup.types.WebRtcTransport | null;
  // producerId → { producer, source, consumers Set }
  producers: Map<
    string,
    {
      producer: mediasoup.types.Producer;
      source: "camera" | "screen";
      consumers: Set<string>;
    }
  >;
  // consumerId → { consumer, producerId }
  consumers: Map<
    string,
    { consumer: mediasoup.types.Consumer; producerId: string }
  >;
  // producerId → consumerId: index consumers by producerId for fast deduplication
  // and O(1) cleanup on producer close.
  consumersByProducerId: Map<string, string>;
  // Track which producers have been notified as closed to avoid duplicates
  notifiedClosedProducers: Set<string>;
  // Directions whose transport is being built right now. Two ms:create-transport
  // frames in the same batch both start a creation before either assigns, so a
  // check that only looks at sendTransport/recvTransport allocates twice.
  transportsInFlight: Set<"send" | "recv">;
  // Directions that are already connected. Prevents repeated ms:connect-transport
  // calls for the same transport from issuing duplicate worker requests.
  connectedTransports: Set<"send" | "recv">;
  // Per-direction reap timer for a transport that has been created but has not
  // yet completed ms:connect-transport - see TRANSPORT_CONNECT_TIMEOUT_MS.
  // Keyed by direction, not by transport, so replacing a transport naturally
  // replaces its timer too.
  transportReapTimers: Map<"send" | "recv", NodeJS.Timeout>;
  // produce()/consume() calls that have been started but not yet recorded in
  // the maps above. ws hands this listener the next frame without awaiting the
  // previous one, so a ceiling that only reads producers.size / consumers.size
  // admits every frame that lands before the first call resolves. Same fix as
  // transportsInFlight, for the same reason.
  producersInFlight: number;
  consumersInFlight: number;
  // Cumulative produce() calls over this session's lifetime. A join that does
  // 256 or more produce calls in a row is a flood attack, not a real call.
  cumulativeProduces: number;
  // Token budget for worker round-trips (create-transport, connect-transport,
  // produce, consume). Replenished after each operation completes; when budget
  // hits zero, new operations are rejected and the WebSocket is paused to apply
  // TCP backpressure.
  // The liveness probe outstanding against this session, if any. Shared so
  // that a flood of duplicate joins costs one ping rather than one ping each.
  livenessProbe: Promise<boolean> | null;
}

// ── Resource ceilings ─────────────────────────────────────────────────────────

// Nothing about a join is authenticated, so every allocation an anonymous
// client can trigger needs a finite ceiling. All of these are far above what a
// real call uses; they exist so that a script cannot walk this process out of
// memory or out of the RTC port range, not to shape normal usage.

// Only rooms that actually hold media resources count toward MAX_ROOMS, and
// the resource counted is the router - see getOrCreateRouter below. A bare
// join allocates nothing but a Map entry, so counting bare joins turned an
// unauthenticated endpoint into a switch for denying every new call: one host
// holding a hundred idle sockets made every user who was first into their own
// room see "server full", indefinitely. rtpCapabilities are served from a
// template router created at boot, so asking for capabilities costs nothing.
// A router is the first thing a room really costs the worker and it outlives
// every transport in the room, so only counting rooms that build one is both
// honest about the load and impossible to walk past by asking for capabilities
// without ever building a transport.
// This counts ROOMS, and it is not the capacity ceiling - the port range is.
// mediasoup keeps SEPARATE udp and tcp port pools (the protocol is folded into
// its port-range key), so an N-port range allows N WebRtcTransports, and a
// participant in a call holds two of them (send and recv). The default
// 500-port range is therefore about 250 concurrent participants, and it runs
// out before this ceiling does. Raise both together or neither.
const MAX_ROOMS = parseInt(process.env.SFU_MAX_ROOMS ?? "250", 10);
const MAX_PEERS_PER_ROOM = 32;
// A peer publishes at most camera video, screen video and screen audio. The
// headroom absorbs a client that republishes before its close frame lands.
const MAX_PRODUCERS_PER_PEER = 8;
// Cumulative produces over a session's lifetime. A real call produces ~3 times
// (camera, screen, screen audio); 256 is orders of magnitude of headroom and
// stops the flood primitive documented in the finding (produce/close cycles).
const MAX_CUMULATIVE_PRODUCES_PER_SESSION = 256;
// One consumer per remote producer: a full room needs under a hundred. Each
// one costs a forwarded stream, so an unbounded ms:consume loop is bandwidth
// amplification as well as memory.
const MAX_CONSUMERS_PER_PEER = 256;
// A WebRtcTransport binds a UDP+TCP port pair out of the 500-port RTC range
// at creation, before either side has proven it can complete a handshake -
// join + ms:create-transport on a raw websocket that only answers pings is
// enough to hold one open, and the pair is otherwise only freed when the
// peer leaves. A transport that has not connected within this window is
// reaped. Safe only because the client creates transports LAZILY - on its
// first publish or consume, which is also when mediasoup-client runs the
// connect handshake. An earlier client created both at join, and since voice
// is peer-to-peer they sat unconnected for every voice-only call; this reap
// threw those calls out of the video server 20s in. 0 disables it.
const TRANSPORT_CONNECT_TIMEOUT_MS = parseInt(
  process.env.SFU_TRANSPORT_CONNECT_TIMEOUT_MS ?? "20000",
  10,
);
// roomCode and peerId become Map keys and are echoed into the logs. Real ones
// are a 16-char hex room code (8 bytes, or "dm-" + 40 hex for DMs) and a
// base58 libp2p peer id; anything long, non-string or carrying control
// characters is junk.
const MAX_ID_LENGTH = 128;

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    // Control characters, DEL and whitespace are the only things ruled
    // out: a room code is whatever the people sharing it typed, so the
    // charset stays as wide as the rest of the app allows.
    !/[\u0000-\u001f\u007f\s]/.test(value)
  );
}

// ── Room state ────────────────────────────────────────────────────────────────

// roomCode → Map<peerId, PeerState>
const rooms = new Map<string, Map<string, PeerState>>();

function getOrCreateRoom(roomCode: string): Map<string, PeerState> {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
  return rooms.get(roomCode)!;
}

// How long an incumbent session gets to answer a liveness probe before a
// duplicate join is allowed to take its slot. Long enough that a browser on a
// working connection always answers - it replies to a ping inside its
// WebSocket stack, without waking the page - and short enough that a real
// reconnect is not left staring at dead video.
const REJOIN_PROBE_MS = parseInt(process.env.SFU_REJOIN_PROBE_MS ?? "3000", 10);

// Whether an existing session is still there. readyState answers this only for
// a socket that closed politely; the reconnect that actually matters - walking
// from wifi to cellular mid-call - sends no FIN, so the corpse still reads OPEN
// until the heartbeat sweeps it. Ping it and wait for the pong instead: a
// healthy incumbent always wins the race, so a stranger's duplicate join still
// cannot evict it, and a half-open one loses its slot in seconds rather than in
// a heartbeat interval plus the client's backoff.
// The heartbeat's isAlive flag is deliberately not consulted - it is false for
// one round trip after every ping, and a duplicate join landing in that window
// would evict a perfectly healthy peer.
function probeSessionAlive(peer: PeerState): Promise<boolean> {
  if (peer.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  // A socket with bytes still queued is BUSY, not dead, and the difference is
  // attacker-controlled: any room member can push signalling frames at a peer
  // (produce/close-producer fans out to the whole room on every call), back its
  // socket up until the pong cannot get out inside REJOIN_PROBE_MS, and have
  // the probe report a healthy peer as dead - then take its peerId. Refusing
  // to call a backlogged socket dead removes the flood's payoff; the socket
  // still dies on its own if it is genuinely gone, via close/error.
  if (peer.ws.bufferedAmount > 0) return Promise.resolve(true);
  if (peer.livenessProbe) return peer.livenessProbe;

  const ws = peer.ws;
  const probe = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("pong", onPong);
      ws.off("close", onGone);
      ws.off("error", onGone);
      resolve(alive);
    };
    const onPong = (): void => finish(true);
    const onGone = (): void => finish(false);
    const timer = setTimeout(() => finish(false), REJOIN_PROBE_MS);
    ws.on("pong", onPong);
    ws.on("close", onGone);
    ws.on("error", onGone);
    try {
      ws.ping();
    } catch {
      finish(false);
    }
  });

  peer.livenessProbe = probe;
  void probe.then(() => {
    if (peer.livenessProbe === probe) peer.livenessProbe = null;
  });
  return probe;
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── mediasoup setup ───────────────────────────────────────────────────────────

const ANNOUNCED_IP = process.env.ANNOUNCED_IP ?? "127.0.0.1";
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT ?? "40000", 10);
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT ?? "40499", 10);

const mediaCodecs: mediasoup.types.RouterOptions["mediaCodecs"] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

let worker: mediasoup.types.Worker;
// Template router created at boot for serving rtpCapabilities without allocating
// a per-room router. This prevents the room ceiling from being exhausted by calls
// to get-capabilities that never build a transport.
let templateRouter: mediasoup.types.Router;
// One router per room for now - keyed by roomCode.
// Stores promises to avoid TOCTOU race: concurrent callers await the same pending creation.
const routers = new Map<string, Promise<mediasoup.types.Router>>();

// Raised when a room that holds no router yet would push the instance past
// MAX_ROOMS. It is its own type so the frame loop can tell a refusal the
// client needs to hear about apart from an internal failure.
class RoomCeilingError extends Error {}

async function getOrCreateRouter(
  roomCode: string,
): Promise<mediasoup.types.Router> {
  const existing = routers.get(roomCode);
  if (existing) return existing;

  // The join handshake checks this ceiling too, but only against the count at
  // the instant of the join, and a join creates no router: a client could join
  // a hundred rooms while the count was still zero and only then ask each of
  // them for capabilities, which is what actually builds the routers. This is
  // the check that holds, because it sits where the resource is allocated.
  if (routers.size >= MAX_ROOMS) {
    throw new RoomCeilingError(
      `room ceiling reached (${MAX_ROOMS}); refusing a router for room ${roomCode}`,
    );
  }

  const promise = worker.createRouter({ mediaCodecs }).then((router) => {
    console.log(`[router] created for room ${roomCode}`);
    return router;
  });
  // A failed creation must not stay cached: it would poison the room for as
  // long as it lived and hold a slot under the ceiling that counts this map.
  promise.catch(() => {
    if (routers.get(roomCode) === promise) routers.delete(roomCode);
  });
  routers.set(roomCode, promise);
  return promise;
}

async function createWebRtcTransport(
  router: mediasoup.types.Router,
): Promise<mediasoup.types.WebRtcTransport> {
  return router.createWebRtcTransport({
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

// Reaps a send/recv transport that has proven it will never carry media -
// either it sat unconnected past TRANSPORT_CONNECT_TIMEOUT_MS, or mediasoup
// reported its ICE/DTLS handshake failed or its worker-side object closed out
// from under us. `transport` is the exact instance the caller is reacting to;
// if it is no longer the peer's current transport for `direction` (already
// replaced, or already reaped), this is a stale, late-firing event and must
// not touch the peer's live transport or send a second error.
function reapTransport(
  peer: PeerState,
  direction: "send" | "recv",
  transport: mediasoup.types.WebRtcTransport,
  reason: string,
): void {
  const current = direction === "send" ? peer.sendTransport : peer.recvTransport;
  if (current !== transport) return;

  clearTransportReapTimer(peer, direction);
  if (direction === "send") {
    peer.sendTransport = null;
  } else {
    peer.recvTransport = null;
  }
  peer.connectedTransports.delete(direction);
  // mediasoup may have closed the transport itself (e.g. the worker died a
  // transport-local death); close() is a no-op on an already-closed
  // transport, but check anyway so the intent - drop the reference, don't
  // reissue a worker request - reads directly.
  if (!transport.closed) transport.close();
  send(peer.ws, { type: "ms:error", reason });
}

function armTransportReapTimer(
  peer: PeerState,
  direction: "send" | "recv",
  transport: mediasoup.types.WebRtcTransport,
): void {
  if (!(TRANSPORT_CONNECT_TIMEOUT_MS > 0)) return;
  const timer = setTimeout(() => {
    peer.transportReapTimers.delete(direction);
    reapTransport(peer, direction, transport, "transport-timeout");
  }, TRANSPORT_CONNECT_TIMEOUT_MS);
  // A pending reap timer must not be the reason the process stays alive.
  timer.unref();
  peer.transportReapTimers.set(direction, timer);
}

function clearTransportReapTimer(peer: PeerState, direction: "send" | "recv"): void {
  const timer = peer.transportReapTimers.get(direction);
  if (timer) {
    clearTimeout(timer);
    peer.transportReapTimers.delete(direction);
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

async function handleGetCapabilities(peer: PeerState): Promise<void> {
  // rtpCapabilities are identical for every router, so serve them from the
  // template router created at boot. This avoids allocating a per-room router
  // and prevents the room ceiling from being exhausted by capability queries.
  send(peer.ws, {
    type: "ms:capabilities",
    rtpCapabilities: templateRouter.rtpCapabilities,
  } as MSCapabilities);
}

async function handleCreateTransport(
  peer: PeerState,
  msg: MSCreateTransport,
): Promise<void> {
  // Anything that was not "send" fell through to the recv branch, so a junk
  // direction silently allocated a transport and took over the peer's recv
  // slot. Only the two literals the client can mean are accepted.
  if (msg.direction !== "send" && msg.direction !== "recv") {
    console.warn(
      `[sfu] create-transport: bad direction from peer ${peer.peerId}`,
    );
    return;
  }

  // Every WebRtcTransport binds a UDP and a TCP port out of the RTC range,
  // which is 500 ports for the whole worker. Overwriting sendTransport /
  // recvTransport left the previous one referenced only by the router, so
  // handlePeerLeft never closed it and its ports were gone until the room
  // ended - repeating this one message walked the instance out of ports.
  // Refusing a request that races a creation already in flight is the other
  // half: concurrent frames all pass a check that only reads the assigned
  // field, because none of them has assigned anything yet.
  if (peer.transportsInFlight.has(msg.direction)) {
    console.warn(
      `[sfu] create-transport: a ${msg.direction} transport is already being created for peer ${peer.peerId}`,
    );
    return;
  }


  peer.transportsInFlight.add(msg.direction);
  let transport: mediasoup.types.WebRtcTransport;
  try {
    const router = await getOrCreateRouter(peer.roomCode);
    transport = await createWebRtcTransport(router);
  } finally {
    peer.transportsInFlight.delete(msg.direction);
  }

  // The session can end while the transport is being built - handlePeerLeft
  // has already closed everything this peer held by then, so assigning the
  // fresh transport to it would leak the ports it just bound.
  if (rooms.get(peer.roomCode)?.get(peer.peerId) !== peer) {
    transport.close();
    return;
  }

  const previous =
    msg.direction === "send" ? peer.sendTransport : peer.recvTransport;
  if (previous) {
    // A real client asks once per direction per socket (mediasoup.ts creates
    // each exactly once per join, and a rejoin opens a fresh socket), so this
    // is either a retry or an attempt to leak ports. Closing beats refusing:
    // a retry still gets a working transport, and the port budget holds.
    console.warn(
      `[sfu] duplicate ${msg.direction} transport for peer ${peer.peerId}; closing the previous one`,
    );
    previous.close();
    // The replacement has not completed a DTLS handshake, so the "already
    // connected" guard in handleConnectTransport must not still be armed for
    // this direction - otherwise the retry this branch exists to serve gets a
    // transport whose connect is silently refused, and no media ever flows.
    peer.connectedTransports.delete(msg.direction);
    // The previous transport's own reap timer is for a transport that is now
    // closed and discarded - let the fresh one below get its own.
    clearTransportReapTimer(peer, msg.direction);
  }

  if (msg.direction === "send") {
    peer.sendTransport = transport;
  } else {
    peer.recvTransport = transport;
  }

  // This transport already holds a UDP+TCP pair out of the RTC range; if
  // ms:connect-transport never lands, reap it rather than wait for the peer
  // to leave.
  armTransportReapTimer(peer, msg.direction, transport);
  // Belt and suspenders on top of the timer: a handshake that outright fails,
  // or a transport the worker closes on its own, should give the port back
  // immediately rather than ride out the rest of the timeout.
  transport.on("icestatechange", (iceState) => {
    if (iceState === "closed") {
      reapTransport(peer, msg.direction, transport, "transport-timeout");
    }
  });
  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "failed" || dtlsState === "closed") {
      reapTransport(peer, msg.direction, transport, "transport-timeout");
    }
  });

  const options: ClientTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };

  send(peer.ws, {
    type: "ms:transport-options",
    direction: msg.direction,
    options,
  } as MSTransportOptions);
}

async function handleConnectTransport(
  peer: PeerState,
  msg: MSConnectTransport,
): Promise<void> {
  // Validate direction to the two literals only; anything else is junk.
  if (msg.direction !== "send" && msg.direction !== "recv") {
    console.warn(
      `[sfu] connect-transport: bad direction from peer ${peer.peerId}`,
    );
    return;
  }

  // Reject if this direction's transport is already connected. mediasoup's
  // Transport.connect() unconditionally issues a WEBRTCTRANSPORT_CONNECT worker
  // request on every call, so calling it twice is a double worker trip and
  // a DoS vector when pipelined. The second call should never happen in a
  // real client, but an attacker can send it repeatedly.
  if (peer.connectedTransports.has(msg.direction)) {
    console.warn(
      `[sfu] connect-transport: ${msg.direction} transport is already connected for peer ${peer.peerId}`,
    );
    return;
  }

  const transport =
    msg.direction === "send" ? peer.sendTransport : peer.recvTransport;
  if (!transport) {
    console.warn(
      `[sfu] connect-transport: no ${msg.direction} transport for peer ${peer.peerId}`,
    );
    return;
  }


  await transport.connect({ dtlsParameters: msg.dtlsParameters });
  peer.connectedTransports.add(msg.direction);
  // The transport proved it can complete a handshake; it no longer needs the
  // reap timer that exists to close it if this never happened.
  clearTransportReapTimer(peer, msg.direction);
}

async function handleProduce(peer: PeerState, msg: MSProduce): Promise<void> {
  if (!peer.sendTransport) {
    console.warn(`[sfu] produce: no send transport for peer ${peer.peerId}`);
    return;
  }

  // The type declares source as "camera" | "screen", but that only binds the
  // client; nothing stops a raw socket from sending anything JSON allows. It
  // ends up in appData and echoed back to every other peer as ms:new-producer
  // / ms:producer-closed, so junk here reaches every client in the room.
  if (msg.source !== "camera" && msg.source !== "screen") {
    console.warn(
      `[sfu] produce: invalid source from peer ${peer.peerId}`,
    );
    send(peer.ws, { type: "ms:error", reason: "invalid-produce" });
    return;
  }

  // Counting the calls already running matters as much as counting the ones
  // that finished: without it every frame that arrives before the first
  // produce() resolves passes this check, and the ceiling overshoots by orders
  // of magnitude.
  if (peer.producers.size + peer.producersInFlight >= MAX_PRODUCERS_PER_PEER) {
    console.error(
      `[sfu] peer ${peer.peerId} is at the producer ceiling (${MAX_PRODUCERS_PER_PEER}); refusing produce`,
    );
    send(peer.ws, { type: "ms:error", reason: "producer-limit" });
    return;
  }

  // Cap cumulative produces over this session's lifetime to stop the flood
  // primitive (produce/close cycles at rate). A real call produces ~3 times;
  // 256 is orders of magnitude of headroom and also stops an attacker from
  // doing 8300 fan-outs per second.
  if (peer.cumulativeProduces >= MAX_CUMULATIVE_PRODUCES_PER_SESSION) {
    console.error(
      `[sfu] peer ${peer.peerId} has exceeded cumulative produce limit (${MAX_CUMULATIVE_PRODUCES_PER_SESSION}); refusing produce`,
    );
    send(peer.ws, { type: "ms:error", reason: "producer-limit" });
    return;
  }

  peer.cumulativeProduces++;
  peer.producersInFlight++;

  let producer: mediasoup.types.Producer;
  try {
    producer = await peer.sendTransport.produce({
      kind: msg.kind,
      rtpParameters: msg.rtpParameters,
      appData: { source: msg.source, peerId: peer.peerId },
    });
  } finally {
    peer.producersInFlight--;
  }

  // The session can end while produce() is in flight - handlePeerLeft has
  // already closed everything this peer held by then, so recording the fresh
  // producer against it would leak it for as long as the router lives.
  if (rooms.get(peer.roomCode)?.get(peer.peerId) !== peer) {
    producer.close();
    return;
  }

  peer.producers.set(producer.id, {
    producer,
    source: msg.source,
    consumers: new Set(),
  });

  send(peer.ws, { type: "ms:produced", producerId: producer.id } as MSProduced);

  // Notify every other peer in the room about the new producer
  const room = rooms.get(peer.roomCode);
  if (room) {
    for (const [otherPeerId, otherPeer] of room) {
      if (otherPeerId !== peer.peerId) {
        send(otherPeer.ws, {
          type: "ms:new-producer",
          peerId: peer.peerId,
          producerId: producer.id,
          source: msg.source,
        } as MSNewProducer);
      }
    }
  }

  function notifyProducerClosed(producerId: string, source: "camera" | "screen") {
    // Avoid duplicate notifications
    if (peer.notifiedClosedProducers.has(producerId)) {
      return;
    }
    peer.notifiedClosedProducers.add(producerId);

    peer.producers.delete(producerId);
    const room = rooms.get(peer.roomCode);
    if (room) {
      for (const [otherPeerId, otherPeer] of room) {
        if (otherPeerId === peer.peerId) continue;
        send(otherPeer.ws, {
          type: "ms:producer-closed",
          peerId: peer.peerId,
          producerId,
          source,
        } as MSProducerClosed);
      }
    }
  }

  producer.on("transportclose", () => {
    notifyProducerClosed(producer.id, producer.appData.source as "camera" | "screen");
  });

  console.log(
    `[sfu] peer ${peer.peerId} produced ${producer.id} (${msg.source})`,
  );
}

async function handleConsume(peer: PeerState, msg: MSConsume): Promise<void> {
  if (!peer.recvTransport) {
    console.warn(`[sfu] consume: no recv transport for peer ${peer.peerId}`);
    return;
  }

  // Check if we already have a consumer for this producerId. A duplicate consume
  // request for the same producer is either a retry or an attack - if a retry,
  // re-sending the existing consumer's options lets the client recover. If an
  // attack, this prevents building duplicate consumers that forward duplicate
  // streams, fill the socket's queue, and consume bandwidth.
  const existingConsumerId = peer.consumersByProducerId.get(msg.producerId);
  if (existingConsumerId) {
    const existingConsumer = peer.consumers.get(existingConsumerId);
    if (existingConsumer) {
      console.log(
        `[sfu] peer ${peer.peerId} already consuming producer ${msg.producerId}; resending consumer options`,
      );
      const options: ClientConsumerOptions = {
        id: existingConsumer.consumer.id,
        producerId: existingConsumer.consumer.producerId,
        kind: existingConsumer.consumer.kind,
        rtpParameters: existingConsumer.consumer.rtpParameters,
      };
      // Look up producer source
      let source: "camera" | "screen" = "camera";
      const room = rooms.get(peer.roomCode);
      if (room) {
        for (const [, p] of room) {
          const entry = p.producers.get(msg.producerId);
          if (entry) {
            source = entry.source;
            break;
          }
        }
      }
      send(peer.ws, {
        type: "ms:consumer-options",
        options,
        peerId: "", // Not needed for duplicate - client already has this
        source,
      } as MSConsumerOptions);
      return;
    }
  }

  // Nothing stops a client consuming the same producer over and over, and each
  // consumer is another copy of that stream forwarded out of here.
  // Counting the calls already running matters as much as counting the ones
  // that finished: without it every frame that arrives before the first
  // consume() resolves passes this check, and the ceiling overshoots by orders
  // of magnitude.
  if (peer.consumers.size + peer.consumersInFlight >= MAX_CONSUMERS_PER_PEER) {
    console.error(
      `[sfu] peer ${peer.peerId} is at the consumer ceiling (${MAX_CONSUMERS_PER_PEER}); refusing consume`,
    );
    send(peer.ws, { type: "ms:error", reason: "consumer-limit" });
    return;
  }

  peer.consumersInFlight++;

  let consumer: mediasoup.types.Consumer;
  try {
    const router = await getOrCreateRouter(peer.roomCode);

    if (
      !router.canConsume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
      })
    ) {
      console.warn(
        `[sfu] cannot consume producer ${msg.producerId} for peer ${peer.peerId}`,
      );
      // Deliberately no ms:error: the client treats every ms:error as a
      // session refusal (mediasoup.ts failSession), and a producer that went
      // away between ms:new-producer and this consume is a normal race, not a
      // reason to drop video for the whole call. The client's request() times
      // out on its own.
      return;
    }

    consumer = await peer.recvTransport.consume({
      producerId: msg.producerId,
      rtpCapabilities: msg.rtpCapabilities,
      paused: false,
    });
  } finally {
    peer.consumersInFlight--;
  }

  // Same window as produce(): the session can be replaced or closed while
  // consume() is in flight, and a consumer recorded against a peer nobody
  // will clean up keeps forwarding a stream to a socket that is gone.
  if (rooms.get(peer.roomCode)?.get(peer.peerId) !== peer) {
    consumer.close();
    return;
  }

  peer.consumers.set(consumer.id, { consumer, producerId: msg.producerId });
  // Index by producerId for fast deduplication and O(1) cleanup on producer close
  peer.consumersByProducerId.set(msg.producerId, consumer.id);

  // Find which peer owns this producer and what source it is
  let producerPeerId = "";
  let source: "camera" | "screen" = "camera";
  const room = rooms.get(peer.roomCode);
  if (room) {
    for (const [pid, p] of room) {
      const entry = p.producers.get(msg.producerId);
      if (entry) {
        producerPeerId = pid;
        source = entry.source;
        break;
      }
    }
  }

  // If this is a screen share, notify the producer owner that someone started watching
  if (source === "screen" && producerPeerId) {
    const producerOwner = room?.get(producerPeerId);
    if (producerOwner) {
      send(producerOwner.ws, {
        type: "ms:producer-consumed",
        peerId: peer.peerId,
        producerId: msg.producerId,
      } as MSProducerConsumed);
    }
  }

  const options: ClientConsumerOptions = {
    id: consumer.id,
    producerId: consumer.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };

  send(peer.ws, {
    type: "ms:consumer-options",
    options,
    peerId: producerPeerId,
    source,
  } as MSConsumerOptions);

  consumer.on("transportclose", () => {
    peer.consumers.delete(consumer.id);
    peer.consumersByProducerId.delete(msg.producerId);
  });
  consumer.on("producerclose", () => {
    peer.consumers.delete(consumer.id);
    peer.consumersByProducerId.delete(msg.producerId);
  });

  console.log(
    `[sfu] peer ${peer.peerId} consuming ${msg.producerId} (${source})`,
  );
}

function handleCloseConsumer(peer: PeerState, msg: MSCloseConsumer): void {
  // Look up the consumer by producerId using the index for O(1) lookup and cleanup
  const consumerId = peer.consumersByProducerId.get(msg.producerId);
  if (!consumerId) {
    return;
  }

  const entry = peer.consumers.get(consumerId);
  if (!entry) {
    // Index entry exists but consumer was already deleted; clean up index
    peer.consumersByProducerId.delete(msg.producerId);
    return;
  }

  // Notify the producer owner that this peer stopped watching
  const room = rooms.get(peer.roomCode);
  if (room) {
    for (const [, p] of room) {
      const prodEntry = p.producers.get(msg.producerId);
      if (prodEntry && prodEntry.source === "screen") {
        prodEntry.consumers.delete(peer.peerId);
        send(p.ws, {
          type: "ms:producer-consumer-closed",
          peerId: peer.peerId,
          producerId: msg.producerId,
        } as MSProducerConsumerClosed);
        break;
      }
    }
  }

  entry.consumer.close();
  peer.consumers.delete(consumerId);
  peer.consumersByProducerId.delete(msg.producerId);
}

function handleCloseProducer(peer: PeerState, msg: MSCloseProducer): void {
  const entry = peer.producers.get(msg.producerId);
  if (entry) {
    const source = entry.source;
    entry.producer.close();
    peer.producers.delete(msg.producerId);

    // Notify all other peers that this producer is closed
    const room = rooms.get(peer.roomCode);
    if (room) {
      for (const [otherPeerId, otherPeer] of room) {
        if (otherPeerId === peer.peerId) continue;
        send(otherPeer.ws, {
          type: "ms:producer-closed",
          peerId: peer.peerId,
          producerId: msg.producerId,
          source,
        } as MSProducerClosed);
      }
    }
  }
}

function handlePeerLeft(peer: PeerState): void {
  const room = rooms.get(peer.roomCode);
  if (!room) return;

  // close all producers
  for (const { producer } of peer.producers.values()) {
    producer.close();
  }
  peer.producers.clear();

  // close all consumers
  for (const { consumer } of peer.consumers.values()) {
    consumer.close();
  }
  peer.consumers.clear();

  peer.sendTransport?.close();
  peer.recvTransport?.close();
  // Both transports are gone (or were never built); their reap timers would
  // be no-ops when they fire (reapTransport checks the transport is still
  // current), but there's no reason to let them sit on the event loop.
  clearTransportReapTimer(peer, "send");
  clearTransportReapTimer(peer, "recv");

  room.delete(peer.peerId);
  console.log(
    `[sfu] peer ${peer.peerId} left room ${peer.roomCode} (${room.size} remaining)`,
  );

  // Notify remaining peers
  for (const otherPeer of room.values()) {
    send(otherPeer.ws, {
      type: "ms:peer-left",
      peerId: peer.peerId,
    } as MSPeerLeft);
  }

  // Clean up empty room
  if (room.size === 0) {
    rooms.delete(peer.roomCode);
    const routerPromise = routers.get(peer.roomCode);
    if (routerPromise) {
      routerPromise.then((router) => {
        router.close();
        routers.delete(peer.roomCode);
        console.log(`[sfu] router closed for empty room ${peer.roomCode}`);
      }).catch((err) => {
        console.error(`[sfu] error closing router for room ${peer.roomCode}:`, err);
      });
    }
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SFU_PORT ?? "3000", 10);
// Signalling frames are small JSON objects; the biggest carries SDP-ish
// rtpParameters. 256 KiB is orders of magnitude of headroom and still stops
// an anonymous client from making us buffer and parse megabytes per frame.
const MAX_FRAME_BYTES = 256 * 1024;
// Bytes of unhandled frames one connection may have queued before we stop
// reading its socket. Frames are handled one at a time through frameChain, so
// a peer that sends faster than the single mediasoup worker can answer leaves
// the raw Buffers retained in that chain, with nothing bounding it: at
// MAX_FRAME_BYTES each, a pipelining sender grows the heap as fast as its link
// allows. Pausing the socket pushes the backlog into the kernel and then into
// TCP receive window, which is where backpressure belongs. Generous against
// legitimate use: the largest honest burst is a peer joining a busy room and
// consuming every existing producer at once, a few dozen frames of ~1 KB.
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  worker.on("died", (err) => {
    console.error("[sfu] mediasoup worker died:", err);
    process.exit(1);
  });

  console.log(`[sfu] mediasoup worker started (pid ${worker.pid})`);

  // Create a template router at boot for serving rtpCapabilities. This avoids
  // allocating a per-room router just to query capabilities and prevents the
  // room ceiling from being exhausted by capability queries.
  templateRouter = await worker.createRouter({ mediaCodecs });
  console.log("[sfu] template router created for capabilities");

  // Last line of defence. Every handler is now guarded, but this process
  // serves every call on the instance: an unhandled rejection anywhere must
  // not be a remote kill switch.
  process.on("unhandledRejection", (err) => {
    console.error("[sfu] unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("[sfu] uncaught exception:", err);
  });

  const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_FRAME_BYTES });

  // ws forwards the internal http server's "error" event onto the
  // WebSocketServer, and that is where a failure to listen at all arrives -
  // EADDRINUSE, EACCES. An EventEmitter "error" with no listener used to be a
  // loud crash; the uncaughtException handler installed above would now
  // swallow it and leave this process alive with nothing listening, deaf to
  // every call on the instance. Exit non-zero instead so the supervisor
  // restarts it. Per-connection socket errors do NOT come through here: they
  // are emitted on the individual WebSocket, which has its own handler below,
  // and a client that hangs up mid-handshake reaches "wsClientError".
  wss.on("error", (err: Error) => {
    console.error("[sfu] WebSocket server error:", err);
    process.exit(1);
  });

  // Heartbeat to detect and terminate dead connections (silent disconnect, network handover, etc.)
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      // A connection paused for backpressure cannot answer: ws.pause() pauses
      // the underlying socket, so PONGS AND THE CLOSE HANDSHAKE stop arriving
      // along with the data frames. Treating that silence as death would have
      // this heartbeat terminate a peer for the crime of sending too much -
      // and it is the peers under real load that get paused. They are
      // demonstrably alive; that is why they were paused.
      if ((ws as unknown as { backpressured?: boolean }).backpressured) return;
      const isAlive = (ws as any).isAlive;
      if (isAlive === false) {
        ws.terminate();
      } else {
        (ws as any).isAlive = false;
        ws.ping();
      }
    });
  }, 30000); // 30 second interval

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    (ws as any).isAlive = true;
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });
    let peer: PeerState | null = null;

    // ws hands this listener the next frame without waiting for the previous
    // call to resolve. The join handshake now awaits - it probes the incumbent
    // session before refusing a rejoin - and the client pipelines
    // ms:get-capabilities straight behind its join, so that frame would arrive
    // while peer is still null and be rejected as "expected join as first
    // message". Running one frame at a time per connection keeps the order the
    // client sent them in, which the protocol assumed anyway, and only this
    // connection ever waits on its own backlog.
    const handleFrame = async (raw: Buffer): Promise<void> => {
      // A frame this size cannot be a legitimate signalling message, and
      // parsing it is the expensive part - reject before JSON.parse.
      if (raw.length > MAX_FRAME_BYTES) {
        console.warn("[sfu] oversized frame, closing");
        ws.close();
        return;
      }

      let msg: ClientMsg;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        // JSON.parse("null") does NOT throw - it returns null, and reading
        // .type off it threw a TypeError inside this async listener. Nothing
        // awaits an emitter's listener, so that became an unhandled rejection
        // and node (>=15, and this runs on node:22) KILLED THE PROCESS: every
        // call in every room dropped, from four anonymous bytes. Same for any
        // non-object or a missing/!string type, which also reached the catch
        // below where `msg.type` was read again with nothing to catch it.
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          typeof (parsed as { type?: unknown }).type !== "string"
        ) {
          console.warn("[sfu] malformed frame from client");
          ws.close();
          return;
        }
        msg = parsed as ClientMsg;
      } catch {
        console.warn("[sfu] invalid JSON from client");
        return;
      }

      // First message must be join
      if (!peer) {
        if (msg.type !== "join") {
          console.warn("[sfu] expected join as first message, got:", msg.type);
          ws.close();
          return;
        }
        const joinMsg = msg as ClientJoin;

        // Both of these become Map keys and both end up in the logs, and
        // neither is authenticated, so they are checked before they are used
        // for anything: a non-string key never compares equal to what the
        // other peers in the room send, and a megabyte-long one is retained
        // for as long as the room lives.
        if (!isValidId(joinMsg.roomCode) || !isValidId(joinMsg.peerId)) {
          console.warn("[sfu] join with invalid roomCode or peerId, closing");
          send(ws, { type: "ms:error", reason: "invalid-join" });
          ws.close();
          return;
        }

        const existingRoom = rooms.get(joinMsg.roomCode);
        if (!existingRoom && routers.size >= MAX_ROOMS) {
          console.error(
            `[sfu] room ceiling reached (${MAX_ROOMS}); refusing new room ${joinMsg.roomCode}`,
          );
          send(ws, { type: "ms:error", reason: "server-full" });
          ws.close();
          return;
        }
        if (
          existingRoom &&
          !existingRoom.has(joinMsg.peerId) &&
          existingRoom.size >= MAX_PEERS_PER_ROOM
        ) {
          console.error(
            `[sfu] room ${joinMsg.roomCode} is at the peer ceiling (${MAX_PEERS_PER_ROOM}); refusing peer ${joinMsg.peerId}`,
          );
          send(ws, { type: "ms:error", reason: "room-full" });
          ws.close();
          return;
        }

        let oldPeer = existingRoom?.get(joinMsg.peerId);
        if (oldPeer) {
          // Nothing proves this socket owns the peerId it claims, and the SFU
          // itself discloses every producing peerId to any joiner, so a
          // duplicate join is as likely to be an impostor as a reconnect and
          // an incumbent that is really there keeps its slot. What it does not
          // get is the benefit of the doubt: deciding that on readyState alone
          // refused every rejoin on the commonest reconnect path there is -
          // wifi to cellular sends no FIN, so the corpse still reads OPEN -
          // for a heartbeat interval plus the client's backoff, up to a minute
          // and a half of dead video. Asking the socket costs one ping and
          // answers in milliseconds when the incumbent is alive.
          const alive = await probeSessionAlive(oldPeer);

          // The joining socket can have gone away while the probe was out.
          if (ws.readyState !== WebSocket.OPEN) return;

          if (alive) {
            console.warn(
              `[sfu] duplicate peerId ${joinMsg.peerId} in room ${joinMsg.roomCode} answered a liveness probe; refusing the new connection`,
            );
            send(ws, { type: "ms:error", reason: "peer-id-in-use" });
            ws.close();
            return;
          }

          // Another connection can have taken the slot while the probe was
          // out - it is newer than this join, so it keeps it. Re-reading also
          // picks up the incumbent's own close handler having cleaned up.
          const current = rooms.get(joinMsg.roomCode)?.get(joinMsg.peerId);
          if (current && current !== oldPeer) {
            console.warn(
              `[sfu] peerId ${joinMsg.peerId} in room ${joinMsg.roomCode} was claimed while probing; refusing the new connection`,
            );
            send(ws, { type: "ms:error", reason: "peer-id-in-use" });
            ws.close();
            return;
          }
          oldPeer = current;
        }

        peer = {
          peerId: joinMsg.peerId,
          roomCode: joinMsg.roomCode,
          ws,
          sendTransport: null,
          recvTransport: null,
          producers: new Map(),
          consumers: new Map(),
          consumersByProducerId: new Map(),
          notifiedClosedProducers: new Set(),
          transportsInFlight: new Set(),
          connectedTransports: new Set(),
          transportReapTimers: new Map(),
          producersInFlight: 0,
          consumersInFlight: 0,
          cumulativeProduces: 0,
          livenessProbe: null,
        };
        const room = getOrCreateRoom(joinMsg.roomCode);
        if (oldPeer) {
          // The previous session failed a liveness probe, so its media is
          // closed directly - do NOT call handlePeerLeft(), which would delete
          // the room and close the router this new session needs (and its
          // async ws-close would otherwise evict the new peer).
          console.log(
            `[sfu] duplicate peerId ${peer.peerId} in room ${peer.roomCode}; the previous session is dead, replacing it`,
          );
          // Closing a producer server-side tells nobody, and this is now the
          // ordinary reconnect path rather than a rarity: without this the
          // other peers keep consuming the dead session's producers and their
          // tiles for it sit frozen on its last frame.
          for (const [otherPeerId, otherPeer] of room) {
            if (otherPeerId === joinMsg.peerId) continue;
            for (const [producerId, { source }] of oldPeer.producers) {
              send(otherPeer.ws, {
                type: "ms:producer-closed",
                peerId: joinMsg.peerId,
                producerId,
                source,
              } as MSProducerClosed);
            }
          }
          for (const { producer } of oldPeer.producers.values()) {
            producer.close();
          }
          for (const { consumer } of oldPeer.consumers.values()) {
            consumer.close();
          }
          oldPeer.sendTransport?.close();
          oldPeer.recvTransport?.close();
          clearTransportReapTimer(oldPeer, "send");
          clearTransportReapTimer(oldPeer, "recv");
          oldPeer.ws.terminate();
        }
        room.set(peer.peerId, peer);

        // Send existing producers to the newly joined peer so it can consume them
        for (const [existingPeerId, existingPeer] of room) {
          if (existingPeerId === peer.peerId) continue;
          for (const [producerId, { source }] of existingPeer.producers) {
            send(peer.ws, {
              type: "ms:new-producer",
              peerId: existingPeerId,
              producerId,
              source,
            } as MSNewProducer);
          }
        }

        console.log(`[sfu] peer ${peer.peerId} joined room ${peer.roomCode}`);
        return;
      }

      // Route ms:* messages
      try {
        switch (msg.type) {
          case "ms:get-capabilities":
            await handleGetCapabilities(peer);
            break;
          case "ms:create-transport":
            await handleCreateTransport(peer, msg as MSCreateTransport);
            break;
          case "ms:connect-transport":
            await handleConnectTransport(peer, msg as MSConnectTransport);
            break;
          case "ms:produce":
            await handleProduce(peer, msg as MSProduce);
            break;
          case "ms:consume":
            await handleConsume(peer, msg as MSConsume);
            break;
          case "ms:close-consumer":
            handleCloseConsumer(peer, msg as MSCloseConsumer);
            break;
          case "ms:close-producer":
            handleCloseProducer(peer, msg as MSCloseProducer);
            break;
          default:
            console.warn("[sfu] unknown message type:", (msg as any).type);
        }
      } catch (err) {
        console.error(`[sfu] error handling ${msg.type}:`, err);
        // Out of routers, or out of media ports - mediasoup throws a plain
        // Error ("no more available ports") for the latter, which is the
        // ceiling operators are told to size against, so it must reach the
        // user too. Either way nothing else this session asks for can
        // succeed, and saying so lets the client show a reason instead of
        // waiting out its own request timeout on a call that never starts.
        const atCapacity =
          err instanceof RoomCeilingError ||
          (err instanceof Error && /no more available ports/i.test(err.message));
        if (atCapacity) {
          send(ws, { type: "ms:error", reason: "server-full" });
          ws.close();
        }
      }
    };

    let frameChain: Promise<void> = Promise.resolve();
    let queuedBytes = 0;
    ws.on("message", (raw: Buffer) => {
      queuedBytes += raw.length;
      // Stop reading rather than buffering without limit. ws re-emits nothing
      // until resume(), so the sender feels the stall through TCP instead of
      // this process growing on its behalf.
      if (queuedBytes >= MAX_QUEUED_FRAME_BYTES) {
        (ws as unknown as { backpressured?: boolean }).backpressured = true;
        ws.pause();
      }
      frameChain = frameChain
        .then(() =>
          handleFrame(raw).catch((err) => {
            console.error("[sfu] frame handling failed:", err);
          }),
        )
        .then(() => {
          const wasOver = queuedBytes >= MAX_QUEUED_FRAME_BYTES;
          queuedBytes -= raw.length;
          if (wasOver && queuedBytes < MAX_QUEUED_FRAME_BYTES) {
            (ws as unknown as { backpressured?: boolean }).backpressured = false;
            ws.resume();
          }
        });
    });

    ws.on("close", () => {
      if (peer) {
        // Only clean up if THIS peer is still the room's current session for
        // its peerId. After a duplicate-join replacement the map holds the new
        // peer, so the old ws closing here must not evict it.
        const room = rooms.get(peer.roomCode);
        if (room && room.get(peer.peerId) === peer) {
          handlePeerLeft(peer);
        }
        peer = null;
      }
    });

    ws.on("error", (err: Error) => {
      console.warn("[sfu] ws error:", err.message);
    });
  });

  console.log(`[sfu] WebSocket server listening on ws://0.0.0.0:${PORT}`);
}

main().catch((err) => {
  console.error("[sfu] fatal:", err);
  process.exit(1);
});
