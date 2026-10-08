// Integration tests against a real spawned SFU process (real mediasoup
// worker, real WebSocket server). No fake WebRTC client is involved - these
// tests only exercise paths that do not require a completed ICE/DTLS
// handshake, which is everything covered here:
//   - the unconnected-transport reaper (Task 1)
//   - ms:produce source validation (Task 3)
//   - the dead-socket and stuck-backpressured producer reap (finding 6)
//   - the per-socket worker-op budget under an ms:resume-consumer flood
//   - ms:diag (SFU telemetry vantage) enabled/rate-limited/disabled
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { joinPayload, verifyJoin } from "./auth";
import { envInteger } from "./config";
import { describeClose, holdsForResume, sweepHeartbeatConnection, type HeartbeatSocket } from "./heartbeat";

// The SFU's port for this file, chosen in test.before by freePort().
let PORT = 0;

/**
 * A port nothing is listening on, below the kernel's ephemeral range.
 *
 * The old 34000 + pid % 1000 sat INSIDE that range (32768-60999 on Linux),
 * where the OS hands ports to outgoing connections: on a busy CI runner some
 * other process's socket already held the number, the SFU died on
 * EADDRINUSE, and every test in the file failed as "never started
 * listening". Below 32768 only a listener can take a port, so a successful
 * probe bind is a promise that holds until the SFU binds it. The pid still
 * picks the starting point, so concurrent runs on one machine walk
 * different ranges.
 */
async function freePort(avoid: readonly number[] = []): Promise<number> {
  const start = 20_000 + ((process.pid * 7) % 10_000);
  for (let i = 0; i < 2_000; i++) {
    const port = 20_000 + ((start - 20_000 + i) % 12_000);
    if (avoid.includes(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      // No host: the SFU listens on every interface, so the probe must too.
      probe.listen(port, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port for the test SFU");
}
// Short enough that the "never connects" test doesn't sit around, long
// enough that the assertions below (which each take a real websocket round
// trip) aren't racing the reaper.
const TRANSPORT_CONNECT_TIMEOUT_MS = 300;
// Short enough that the dead-socket and backpressure-deadline tests below
// do not sit around - deadline is twice this (see sfu/index.ts).
const HEARTBEAT_INTERVAL_MS = 100;
// Small enough that a short burst of frames crosses it well within one
// heartbeat tick, without tripping on the other tests' ordinary traffic.
const MAX_QUEUED_FRAME_BYTES = 2000;
// Small enough that one burst of frames crosses it inside a single test, and
// far above what any other test in this file spends.
const MAX_WORKER_OPS = 40;
// The socket pause a budget overrun applies. Kept under the (short) test
// heartbeat interval: a paused socket answers no ping either.
const WORKER_OP_PAUSE_MS = 20;
// How long a dropped session waits for its client to resume. Short, so the
// tests that wait it out do not sit around; long enough for a resume join's
// handshake to land well inside it.
const RESUME_GRACE_MS = 600;

let child: ChildProcess;

function wsUrl(port: number = PORT): string {
  return `ws://127.0.0.1:${port}`;
}

async function waitForServer(port: number = PORT): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port));
        ws.once("open", () => {
          ws.close();
          resolve();
        });
        ws.once("error", reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("sfu process never started listening");
      }
      // Polling a real subprocess's real listening socket, not a guessed
      // test delay - there is no event to await here until it exists.
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

interface SpawnedSfu {
  proc: ChildProcess;
  stop(): Promise<void>;
}

// Spawns a real SFU process on `port` with `extraEnv` layered on top of the
// baseline test env, and returns a handle to stop it. Shared by the
// module's main child (below) and the SFU_TELEMETRY-disabled describe
// block, which needs its own process because SFU_TELEMETRY is read once at
// module load and cannot be toggled on a running server.
function spawnSfu(port: number, extraEnv: Record<string, string>): SpawnedSfu {
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, "node_modules", ".bin", "tsx"), path.join(__dirname, "index.ts")],
    {
      env: {
        ...process.env,
        SFU_PORT: String(port),
        SFU_TRANSPORT_CONNECT_TIMEOUT_MS: String(TRANSPORT_CONNECT_TIMEOUT_MS),
        SFU_HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
        SFU_MAX_QUEUED_FRAME_BYTES: String(MAX_QUEUED_FRAME_BYTES),
        SFU_MAX_WORKER_OPS: String(MAX_WORKER_OPS),
        SFU_WORKER_OP_PAUSE_MS: String(WORKER_OP_PAUSE_MS),
        SFU_RESUME_GRACE_MS: String(RESUME_GRACE_MS),
        ANNOUNCED_IP: "127.0.0.1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let stopping = false;
  proc.stdout?.on("data", (d) => (output += d.toString()));
  proc.stderr?.on("data", (d) => (output += d.toString()));
  proc.on("exit", (code) => {
    if (!stopping && code !== null && code !== 0) {
      console.error(`[sfu test] server on port ${port} exited early (${code}):\n${output}`);
    }
  });
  return {
    proc,
    async stop() {
      if (proc.exitCode !== null) return;
      stopping = true;
      const { promise, resolve } = Promise.withResolvers<void>();
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
      // A real child process against the real OS scheduler, not something a
      // fake clock drives - the genuine-delay exception for a hung exit.
      setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
      await promise;
    },
  };
}

let sfu: SpawnedSfu;

test.before(async () => {
  PORT = await freePort();
  sfu = spawnSfu(PORT, { SFU_TELEMETRY: "1" });
  child = sfu.proc;
  await waitForServer(PORT);
});

test.after(async () => {
  await sfu.stop();
});

// Waits for the next message matching `filter` (or any message, if omitted).
function nextMessage(
  ws: WebSocket,
  filter?: (msg: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for a message"));
    }, timeoutMs);
    function onMessage(raw: Buffer): void {
      const msg = JSON.parse(raw.toString());
      if (filter && !filter(msg)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

async function connectAndJoin(
  roomCode: string,
  label: string,
  port: number = PORT,
): Promise<WebSocket> {
  roomCode = testRoom(roomCode).room;
  const ws = new WebSocket(wsUrl(port));
  const challenge = nextMessage(ws, (m) => m.type === "auth:challenge");
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const { nonce } = await challenge;
  const peerId = testPeer(label).peerId;
  const signature = sign(null, Buffer.from(joinPayload(nonce, roomCode, peerId)), testPeer(label).privateKey).toString("base64");
  const joined = nextMessage(ws, (m) => m.type === "auth:joined");
  ws.send(JSON.stringify({ type: "join", roomCode, peerId, signature,
    capability: roomProof(nonce, roomCode, peerId) }));
  await joined;
  return ws;
}

const identities = new Map<string, ReturnType<typeof makeTestPeer>>();
const rooms = new Map<string, { room: string; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] }>();
function testRoom(label: string) {
  if (!rooms.has(label)) {
    const key = generateKeyPairSync("ed25519");
    const entry = { room: `rs2_${key.publicKey.export({ format: "jwk" }).x}`, privateKey: key.privateKey };
    rooms.set(label, entry);
    rooms.set(entry.room, entry);
  }
  return rooms.get(label)!;
}
function roomProof(nonce: string, room: string, peer: string) {
  return sign(null, Buffer.from(JSON.stringify(["awful:sfu:room:v2", nonce, room, peer])),
    testRoom(room).privateKey).toString("base64url");
}
function makeTestPeer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { privateKey, peerId: bs58.encode(Buffer.concat([Buffer.from([0, 36, 8, 1, 18, 32]), raw])) };
}
function testPeer(label: string) {
  if (!identities.has(label)) identities.set(label, makeTestPeer());
  return identities.get(label)!;
}

test("join signature binds nonce, room and peer identity", () => {
  const a = testPeer("auth-a"), b = testPeer("auth-b");
  const signature = sign(null, Buffer.from(joinPayload("nonce-a", "room-a", a.peerId)), a.privateKey).toString("base64");
  assert.ok(verifyJoin("nonce-a", "room-a", a.peerId, signature));
  assert.equal(verifyJoin("nonce-b", "room-a", a.peerId, signature), false);
  assert.equal(verifyJoin("nonce-a", "room-b", a.peerId, signature), false);
  assert.equal(verifyJoin("nonce-a", "room-a", b.peerId, signature), false);
  assert.equal(verifyJoin("nonce-a", "room-a", a.peerId, null), false);
});

test("SFU rejects unsigned joins, forged identities and cross-socket replay", async () => {
  const room = testRoom("auth-room").room;
  const a = testPeer("auth-wire-a"), b = testPeer("auth-wire-b");
  let captured = "";
  for (const mode of ["unsigned", "forged", "capture", "replay"]) {
    const ws = new WebSocket(wsUrl());
    try {
      const { nonce } = await nextMessage(ws, m => m.type === "auth:challenge");
      const signature = mode === "replay" ? captured : sign(null, Buffer.from(joinPayload(nonce, room, a.peerId)), mode === "forged" ? b.privateKey : a.privateKey).toString("base64");
      if (mode === "capture") captured = signature;
      const reply = nextMessage(ws, m => m.type === "auth:joined" || m.type === "ms:error");
      ws.send(JSON.stringify({ type: "join", roomCode: room, peerId: a.peerId, signature: mode === "unsigned" ? undefined : signature,
        capability: roomProof(nonce, room, a.peerId) }));
      assert.equal((await reply).type, mode === "capture" ? "auth:joined" : "ms:error");
    } finally { ws.close(); }
  }
});

test("v2 admission requires a fresh room capability as well as peer identity", async () => {
  const roomKey = generateKeyPairSync("ed25519");
  const otherKey = generateKeyPairSync("ed25519");
  const room = `rs2_${roomKey.publicKey.export({ format: "jwk" }).x}`;
  const peer = testPeer("v2-admission");
  let captured = "";
  for (const mode of ["missing", "wrong-key", "capture", "replay", "wrong-peer", "root", "discovery", "legacy"]) {
    const ws = new WebSocket(wsUrl());
    try {
      const { nonce } = await nextMessage(ws, m => m.type === "auth:challenge");
      const roomCode = mode === "legacy" ? "legacy-room" : mode === "root" ? `r2_${"a".repeat(43)}` : mode === "discovery" ? `rd2_${"a".repeat(43)}` : room;
      let capability = sign(null, Buffer.from(JSON.stringify([
        "awful:sfu:room:v2", nonce, roomCode,
        mode === "wrong-peer" ? testPeer("other-member").peerId : peer.peerId,
      ])), mode === "wrong-key" ? otherKey.privateKey : roomKey.privateKey).toString("base64url");
      if (mode === "capture") captured = capability;
      if (mode === "replay") capability = captured;
      const signature = sign(null, Buffer.from(joinPayload(nonce, roomCode, peer.peerId)), peer.privateKey).toString("base64");
      const reply = nextMessage(ws, m => m.type === "auth:joined" || m.type === "ms:error");
      ws.send(JSON.stringify({ type: "join", roomCode, peerId: peer.peerId, signature,
        capability: mode === "missing" ? undefined : capability }));
      assert.equal((await reply).type, mode === "capture" ? "auth:joined" : "ms:error", mode);
    } finally {
      const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
      ws.close();
      await closed;
    }
  }
});

test("authenticated identity reconnects after disconnect and cannot evict its live session", async () => {
  const label = "auth-reconnect";
  const first = await connectAndJoin("auth-reconnect-room", label);
  const duplicate = new WebSocket(wsUrl());
  try {
    const { nonce } = await nextMessage(duplicate, m => m.type === "auth:challenge");
    const { peerId, privateKey } = testPeer(label);
    const reply = nextMessage(duplicate, m => m.type === "ms:error");
    const roomCode = testRoom("auth-reconnect-room").room;
    const signature = sign(null, Buffer.from(joinPayload(nonce, roomCode, peerId)), privateKey).toString("base64");
    duplicate.send(JSON.stringify({ type: "join", roomCode, peerId, signature,
      capability: roomProof(nonce, roomCode, peerId) }));
    assert.equal((await reply).reason, "peer-id-in-use");
    assert.equal(first.readyState, WebSocket.OPEN);
  } finally {
    duplicate.close();
    await new Promise<void>(resolve => { first.once("close", () => resolve()); first.close(); });
  }
  const next = await connectAndJoin("auth-reconnect-room", label);
  next.close();
});

test("blank numeric settings use defaults and malformed limits fail closed", () => {
  const key = "AWFUL_TEST_INTEGER";
  try {
    for (const raw of ["", "  "]) {
      process.env[key] = raw;
      assert.equal(envInteger(key, 3000), 3000);
    }
    for (const raw of ["no", "0", "-1", "3ms", "1.5", "Infinity", "2147483648"]) {
      process.env[key] = raw;
      assert.throws(() => envInteger(key, 3000));
    }
    process.env[key] = "25";
    assert.equal(envInteger(key, 3000), 25);
  } finally { delete process.env[key]; }
});

test("reaps a send transport that never completes ms:connect-transport", async () => {
  const ws = await connectAndJoin("room-reap", "peer-reap");
  try {
    ws.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
    const options = await nextMessage(ws, (m) => m.type === "ms:transport-options");
    assert.equal(options.direction, "send");

    // Never send ms:connect-transport. The reaper should fire on its own.
    const start = Date.now();
    const error = await nextMessage(
      ws,
      (m) => m.type === "ms:error",
      TRANSPORT_CONNECT_TIMEOUT_MS + 4000,
    );
    assert.equal(error.reason, "transport-timeout");
    // Sanity: it actually waited for something close to the configured
    // timeout rather than firing immediately for an unrelated reason.
    assert.ok(Date.now() - start >= TRANSPORT_CONNECT_TIMEOUT_MS - 50);

    // The port pair should be free again: a fresh create-transport for the
    // same direction succeeds instead of hitting the "already in flight" /
    // duplicate-transport path.
    ws.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
    const retry = await nextMessage(ws, (m) => m.type === "ms:transport-options");
    assert.equal(retry.direction, "send");
  } finally {
    ws.close();
  }
});

test("ms:restart-ice hands a connected transport fresh ICE credentials", async () => {
  const ws = await connectAndJoin("room-restart-ice", "peer-restart-ice");
  try {
    // Asked before the transport has connected: nothing to repair, no answer.
    // Frames are handled in order, so if r0 were answered its reply would
    // arrive before r1's. (No waiting here: this file's reaper closes an
    // unconnected transport after 300ms.)
    ws.send(JSON.stringify({ type: "ms:create-transport", requestId: "t1", direction: "recv" }));
    const options = await nextMessage(ws, (m) => m.type === "ms:transport-options");
    ws.send(JSON.stringify({ type: "ms:restart-ice", requestId: "r0", direction: "recv" }));

    // connect() only records the remote DTLS parameters; no handshake is
    // needed for the restart to be answered.
    ws.send(JSON.stringify({
      type: "ms:connect-transport",
      direction: "recv",
      dtlsParameters: {
        role: "client",
        fingerprints: [{ algorithm: "sha-256", value: Array(32).fill("AB").join(":") }],
      },
    }));
    ws.send(JSON.stringify({ type: "ms:restart-ice", requestId: "r1", direction: "recv" }));
    const restarted = await nextMessage(ws, (m) => m.type === "ms:ice-restarted");
    assert.equal(restarted.requestId, "r1");
    assert.equal(restarted.direction, "recv");
    assert.notEqual(
      restarted.iceParameters.usernameFragment,
      options.options.iceParameters.usernameFragment,
    );
  } finally {
    ws.close();
  }
});

test("rejects ms:produce with an invalid source", async () => {
  const ws = await connectAndJoin("room-produce", "peer-produce");
  try {
    ws.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
    await nextMessage(ws, (m) => m.type === "ms:transport-options");

    ws.send(
      JSON.stringify({
        type: "ms:produce",
        kind: "video",
        rtpParameters: {},
        source: "not-a-real-source",
      }),
    );
    const error = await nextMessage(ws, (m) => m.type === "ms:error");
    assert.equal(error.reason, "invalid-produce");
  } finally {
    ws.close();
  }
});

// Minimal but structurally valid RtpParameters for a single-codec Opus
// audio producer. mediasoup validates shape, not identity with anything the
// router announced, so this is enough to get a REAL producer (real worker
// round trip, real room fan-out) without a full mediasoup-client SDK.
function fakeAudioRtpParameters(ssrc: number): unknown {
  return {
    mid: "0",
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: {},
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: `probe-${ssrc}`, reducedSize: true },
  };
}

async function produceRealAudio(ws: WebSocket, ssrc: number): Promise<string> {
  ws.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
  await nextMessage(ws, (m) => m.type === "ms:transport-options" && m.direction === "send");
  ws.send(
    JSON.stringify({
      type: "ms:produce",
      kind: "audio",
      rtpParameters: fakeAudioRtpParameters(ssrc),
      source: "camera",
    }),
  );
  const produced = await nextMessage(ws, (m) => m.type === "ms:produced");
  return produced.producerId;
}

test("reaps a peer whose socket goes silently dead, freeing its producer", async () => {
  const roomCode = "room-dead-peer";
  const wsA = await connectAndJoin(roomCode, "peer-dead-a");
  const wsB = await connectAndJoin(roomCode, "peer-dead-b");
  try {
    const producerId = await produceRealAudio(wsA, 22222222);
    // B sees A's producer before A dies - proves it was really live, not
    // merely created and immediately orphaned.
    const newProducer = await nextMessage(
      wsB,
      (m) => m.type === "ms:new-producer" && m.producerId === producerId,
    );
    assert.equal(newProducer.peerId, testPeer("peer-dead-a").peerId);

    // Simulate the wifi-to-cellular handover the heartbeat exists for: the
    // socket sends no FIN and answers no ping, but nothing here calls
    // close() or terminate() - from the server's point of view it just goes
    // quiet. Pausing the client's own raw socket reads means an incoming
    // ping from the server is never read off the wire, so no pong is ever
    // returned - indistinguishable from a real silent network loss.
    (wsA as unknown as { _socket: { pause: () => void } })._socket.pause();

    const start = Date.now();
    const peerLeft = await nextMessage(
      wsB,
      (m) => m.type === "ms:peer-left" && m.peerId === testPeer("peer-dead-a").peerId,
      HEARTBEAT_INTERVAL_MS * 2 + 4000,
    );
    assert.equal(peerLeft.peerId, testPeer("peer-dead-a").peerId);
    // Reaped within roughly two heartbeat ticks (isAlive goes false on the
    // first unanswered ping, terminated on the second) plus the time it is
    // held for a resume, not the old 30s-tick heartbeat's up-to-60s window.
    assert.ok(Date.now() - start < HEARTBEAT_INTERVAL_MS * 2 + RESUME_GRACE_MS + 3000);

    // A fresh joiner must not be handed the dead peer's producer: the room
    // replay only offers what is still in the room map, and the dead peer
    // was removed by handlePeerLeft.
    const wsC = await connectAndJoin(roomCode, "peer-dead-c");
    try {
      let sawStaleProducer = false;
      wsC.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "ms:new-producer" && m.producerId === producerId) {
          sawStaleProducer = true;
        }
      });
      // ms:capabilities always follows a join's producer replay in order on
      // one connection, so receiving it proves the replay already happened.
      wsC.send(JSON.stringify({ type: "ms:get-capabilities" }));
      await nextMessage(wsC, (m) => m.type === "ms:capabilities");
      assert.equal(sawStaleProducer, false);
    } finally {
      wsC.close();
    }
  } finally {
    wsA.close();
    wsB.close();
  }
});

// Joins `label` to `roomLabel` on a new socket, offering `resume` if given,
// and returns the socket with the SFU's answer to the join.
async function joinWith(
  roomLabel: string,
  label: string,
  resume?: string,
): Promise<{ ws: WebSocket; reply: any }> {
  const roomCode = testRoom(roomLabel).room;
  const ws = new WebSocket(wsUrl());
  const { nonce } = await nextMessage(ws, (m) => m.type === "auth:challenge");
  const { peerId, privateKey } = testPeer(label);
  const signature = sign(null, Buffer.from(joinPayload(nonce, roomCode, peerId)), privateKey).toString("base64");
  const reply = nextMessage(
    ws,
    (m) => m.type === "auth:joined" || m.type === "auth:resumed" || m.type === "ms:error",
  );
  ws.send(JSON.stringify({ type: "join", roomCode, peerId, signature,
    capability: roomProof(nonce, roomCode, peerId), resume }));
  return { ws, reply: await reply };
}

// Every message `ws` receives from now on, in order.
function record(ws: WebSocket): any[] {
  const seen: any[] = [];
  ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
  return seen;
}

// A round trip on `ws`: everything the SFU queued for it before is in by then.
async function settle(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify({ type: "ms:get-capabilities", requestId: "settle" }));
  await nextMessage(ws, (m) => m.type === "ms:capabilities");
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve();
    else ws.once("close", () => resolve());
  });
}

test("a session whose socket dropped resumes on a new socket with its media intact", async () => {
  const a = await joinWith("resume-room", "resume-a");
  assert.equal(a.reply.type, "auth:joined");
  assert.ok(a.reply.resumeToken);
  const b = await joinWith("resume-room", "resume-b");
  const seenByB = record(b.ws);
  try {
    const producerId = await produceRealAudio(a.ws, 33333333);
    await nextMessage(b.ws, (m) => m.type === "ms:new-producer" && m.producerId === producerId);

    // No close frame: the server sees 1006, as from a dropped connection.
    a.ws.terminate();
    await closed(a.ws);

    const back = await joinWith("resume-room", "resume-a", a.reply.resumeToken);
    try {
      assert.equal(back.reply.type, "auth:resumed");
      // The session it left: its own producer is still there...
      assert.deepEqual(back.reply.own, [producerId]);
      // ...and the room as it is now.
      assert.deepEqual(back.reply.peers, [testPeer("resume-b").peerId]);
      assert.deepEqual(back.reply.producers, []);
      // A token resumes once: the next one is new.
      assert.ok(back.reply.resumeToken);
      assert.notEqual(back.reply.resumeToken, a.reply.resumeToken);

      // Nobody else saw it go.
      await settle(b.ws);
      assert.equal(seenByB.some((m) => m.type === "ms:peer-left" || m.type === "ms:producer-closed"), false);

      // And the resumed socket drives that session: closing its producer
      // reaches the room.
      back.ws.send(JSON.stringify({ type: "ms:close-producer", producerId }));
      await nextMessage(b.ws, (m) => m.type === "ms:producer-closed" && m.producerId === producerId);
    } finally {
      back.ws.close();
    }
  } finally {
    b.ws.close();
  }
});

test("a resume takes over a socket the SFU still thinks is open", async () => {
  const a = await joinWith("resume-half-open", "half-open-a");
  // Half-open: the client stopped reading and the server was told nothing.
  (a.ws as unknown as { _socket: { pause: () => void } })._socket.pause();
  const back = await joinWith("resume-half-open", "half-open-a", a.reply.resumeToken);
  try {
    // No liveness probe to sit out, and not refused as a duplicate.
    assert.equal(back.reply.type, "auth:resumed");
    // The old socket is cut, so the session has one socket again.
    (a.ws as unknown as { _socket: { resume: () => void } })._socket.resume();
    await closed(a.ws);
    await settle(back.ws);
  } finally {
    back.ws.close();
  }
});

test("a dropped session nobody resumes ends after the grace period", async () => {
  const a = await joinWith("resume-expire", "expire-a");
  const b = await joinWith("resume-expire", "expire-b");
  try {
    const dropped = Date.now();
    a.ws.terminate();
    await nextMessage(
      b.ws,
      (m) => m.type === "ms:peer-left" && m.peerId === testPeer("expire-a").peerId,
      RESUME_GRACE_MS + 4000,
    );
    assert.ok(Date.now() - dropped >= RESUME_GRACE_MS - 50);
    // Too late now: the token names a session that is gone, so this is a
    // new one.
    const late = await joinWith("resume-expire", "expire-a", a.reply.resumeToken);
    assert.equal(late.reply.type, "auth:joined");
    late.ws.close();
  } finally {
    b.ws.close();
  }
});

test("a client that closes its socket leaves at once, with nothing to resume", async () => {
  const a = await joinWith("resume-clean", "clean-a");
  const b = await joinWith("resume-clean", "clean-b");
  try {
    const left = Date.now();
    a.ws.close();
    await nextMessage(b.ws, (m) => m.type === "ms:peer-left" && m.peerId === testPeer("clean-a").peerId);
    assert.ok(Date.now() - left < RESUME_GRACE_MS);
    const again = await joinWith("resume-clean", "clean-a", a.reply.resumeToken);
    assert.equal(again.reply.type, "auth:joined");
    again.ws.close();
  } finally {
    b.ws.close();
  }
});

test("a wrong resume token is an ordinary join", async () => {
  const a = await joinWith("resume-wrong", "wrong-a");
  try {
    // A second tab of the same identity cannot take the live session over...
    const tab = await joinWith("resume-wrong", "wrong-a", "not-the-token");
    assert.equal(tab.reply.type, "ms:error");
    assert.equal(tab.reply.reason, "peer-id-in-use");
    tab.ws.close();
    // ...nor a dropped one: it replaces it, as a join without a token does.
    a.ws.terminate();
    await closed(a.ws);
    const other = await joinWith("resume-wrong", "wrong-a", "x".repeat(a.reply.resumeToken.length));
    assert.equal(other.reply.type, "auth:joined");
    other.ws.close();
  } finally {
    a.ws.close();
  }
});

test("holdsForResume: only a socket that went without a close frame is held", () => {
  assert.equal(holdsForResume(1006, undefined), true);
  assert.equal(holdsForResume(1006, "heartbeat"), true);
  assert.equal(holdsForResume(1006, "backpressure"), true);
  assert.equal(holdsForResume(1000, undefined), false);
  assert.equal(holdsForResume(1001, undefined), false);
  assert.equal(holdsForResume(1005, undefined), false);
  assert.equal(holdsForResume(1006, "replaced"), false);
  assert.equal(holdsForResume(1006, "resumed"), false);
  assert.equal(holdsForResume(1006, "join-timeout"), false);
});

test("sweepHeartbeatConnection: a socket stuck backpressured past the deadline is terminated", () => {
  // The real bug (finding 6): the heartbeat used to skip a backpressured
  // socket unconditionally, so one that was ALSO gone never got reaped -
  // its PeerState, and every producer it held, lived until the kernel
  // eventually gave up on the TCP connection. This drives the exact
  // production decision function against a fake socket and a controlled
  // clock, because sustaining real backpressure for a specific wall-clock
  // duration is not a reliable thing to race against in a test.
  let terminated = 0;
  let pinged = 0;
  const w: HeartbeatSocket = {
    backpressured: true,
    backpressuredSince: 1_000,
    ping: () => pinged++,
    terminate: () => terminated++,
  };
  const deadlineMs = 200;

  // Backpressured for less than the deadline: left alone, not even pinged -
  // a paused socket cannot answer one anyway.
  sweepHeartbeatConnection(w, 1_000 + deadlineMs - 1, deadlineMs);
  assert.equal(terminated, 0);
  assert.equal(pinged, 0);

  // Still backpressured, now past the deadline: terminated outright.
  sweepHeartbeatConnection(w, 1_000 + deadlineMs + 1, deadlineMs);
  assert.equal(terminated, 1);
  assert.equal(pinged, 0);
});

test("sweepHeartbeatConnection: a non-backpressured socket still uses the ordinary ping/isAlive path", () => {
  let terminated = 0;
  let pinged = 0;
  const w: HeartbeatSocket = {
    backpressured: false,
    isAlive: true,
    ping: () => pinged++,
    terminate: () => terminated++,
  };

  // First tick: alive, so it is pinged and marked not-yet-answered.
  sweepHeartbeatConnection(w, 1_000, 200);
  assert.equal(pinged, 1);
  assert.equal(w.isAlive, false);
  assert.equal(terminated, 0);

  // Second tick with no pong in between: terminated, exactly as the
  // pre-existing isAlive contract always has.
  sweepHeartbeatConnection(w, 2_000, 200);
  assert.equal(terminated, 1);
});

test("an ms:resume-consumer flood is refused by the worker-op budget, not forwarded to the worker", async () => {
  const roomCode = "room-resume-flood";
  const wsA = await connectAndJoin(roomCode, "peer-resume-a");
  const wsB = await connectAndJoin(roomCode, "peer-resume-b");
  try {
    const producerId = await produceRealAudio(wsA, 66666666);

    // A real consumer for B, so the flood below names a consumer that exists
    // and is already resumed - the exact frame a retrying client repeats.
    wsB.send(JSON.stringify({ type: "ms:get-capabilities", requestId: "caps" }));
    const caps = await nextMessage(wsB, (m) => m.type === "ms:capabilities");
    wsB.send(JSON.stringify({ type: "ms:create-transport", direction: "recv" }));
    await nextMessage(
      wsB,
      (m) => m.type === "ms:transport-options" && m.direction === "recv",
    );
    wsB.send(
      JSON.stringify({
        type: "ms:consume",
        requestId: "consume-1",
        producerId,
        rtpCapabilities: caps.rtpCapabilities,
      }),
    );
    await nextMessage(wsB, (m) => m.type === "ms:consumer-options");
    wsB.send(JSON.stringify({ type: "ms:resume-consumer", producerId }));

    // Every frame from here asks to resume a consumer that is already
    // resumed. Before the fix each one was a worker round-trip, dispatched
    // without await so the per-socket frame chain never throttled it.
    const flood = 500;
    // Whatever slips under the budget costs nothing (the handler returns
    // before resume() when the consumer is not paused); the rest never
    // reaches the worker at all.
    const wantedRefusals = flood - MAX_WORKER_OPS;
    let refusals = 0;
    const refused = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wsB.off("message", onMessage);
        reject(new Error(`only ${refusals} refusals of ${wantedRefusals}`));
      }, 10000);
      function onMessage(raw: Buffer): void {
        const m = JSON.parse(raw.toString());
        if (m.type !== "ms:error") return;
        assert.equal(m.reason, "rate-limited");
        if (++refusals < wantedRefusals) return;
        clearTimeout(timer);
        wsB.off("message", onMessage);
        resolve();
      }
      wsB.on("message", onMessage);
    });
    for (let i = 0; i < flood; i++) {
      wsB.send(JSON.stringify({ type: "ms:resume-consumer", producerId }));
    }
    await refused;
    assert.ok(refusals >= wantedRefusals);

    // The consumer is resumed and stayed that way, which is why the frames
    // that did slip under the budget cost the worker nothing: the handler
    // returns before resume() for a consumer that is not paused.
    wsB.send(JSON.stringify({ type: "ms:diag", requestId: "flood-diag" }));
    const diag = await nextMessage(
      wsB,
      (m) => m.type === "ms:diag" && m.requestId === "flood-diag",
    );
    const consumer = diag.snapshot.self.consumers.find(
      (c: { producerId: string }) => c.producerId === producerId,
    );
    assert.ok(consumer, "expected the consumer to still be in the snapshot");
    assert.equal(consumer.paused, false);

    // The instance is still serving other rooms, which is what the flood was
    // costing before: a fresh peer elsewhere still gets a transport.
    const wsC = await connectAndJoin("room-resume-bystander", "peer-resume-c");
    try {
      wsC.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
      const options = await nextMessage(
        wsC,
        (m) => m.type === "ms:transport-options",
      );
      assert.equal(options.direction, "send");
    } finally {
      wsC.close();
    }
  } finally {
    wsA.close();
    wsB.close();
  }
});

test("ms:diag returns a snapshot naming this peer's own transport and producer", async () => {
  const ws = await connectAndJoin("room-diag", "peer-diag-a");
  try {
    const producerId = await produceRealAudio(ws, 44444444);

    ws.send(JSON.stringify({ type: "ms:diag", requestId: "diag-1" }));
    const reply = await nextMessage(
      ws,
      (m) => m.type === "ms:diag" && m.requestId === "diag-1",
    );

    assert.equal(reply.snapshot.self.peerId, testPeer("peer-diag-a").peerId);
    const sendTransport = reply.snapshot.self.transports.find(
      (t: { dir: string }) => t.dir === "send",
    );
    assert.ok(sendTransport, "expected the send transport to be in the snapshot");
    // PRIVACY: never a remote ICE candidate address anywhere in the reply.
    assert.ok(!JSON.stringify(reply).includes("remoteIp"));
    const producer = reply.snapshot.self.producers.find(
      (p: { id: string }) => p.id === producerId,
    );
    assert.ok(producer, "expected the produced audio track to be in the snapshot");
    assert.equal(producer.source, "camera");
    // Instance-wide counts are the operator's, not a room member's.
    assert.equal(reply.snapshot.ceilings.rooms, undefined);
    assert.equal(reply.snapshot.ceilings.maxRooms, undefined);
  } finally {
    ws.close();
  }
});

test("a second immediate ms:diag is refused as rate-limited, not answered again", async () => {
  const ws = await connectAndJoin("room-diag-rate", "peer-diag-rate");
  try {
    ws.send(JSON.stringify({ type: "ms:diag", requestId: "diag-a" }));
    const first = await nextMessage(
      ws,
      (m) => m.requestId === "diag-a",
    );
    assert.equal(first.type, "ms:diag");

    ws.send(JSON.stringify({ type: "ms:diag", requestId: "diag-b" }));
    const second = await nextMessage(
      ws,
      (m) => m.requestId === "diag-b",
    );
    assert.equal(second.type, "ms:diag-unavailable");
    assert.equal(second.reason, "rate-limited");
  } finally {
    ws.close();
  }
});

// SFU_TELEMETRY is read once at module load (DIAG_ENABLED, sfu/index.ts), so
// the "disabled" behaviour needs a SEPARATE process from the one above,
// which runs with SFU_TELEMETRY=1 for the whole file.
describe("ms:diag with SFU_TELEMETRY unset", () => {
  let DISABLED_PORT = 0;
  let disabledSfu: SpawnedSfu;

  before(async () => {
    // Not the main SFU's port, which is still bound while this block runs.
    DISABLED_PORT = await freePort([PORT]);
    disabledSfu = spawnSfu(DISABLED_PORT, {});
    await waitForServer(DISABLED_PORT);
  });

  after(async () => {
    await disabledSfu.stop();
  });

  test("ms:diag answers disabled, and the session is not latched by it", async () => {
    const ws = await connectAndJoin("room-diag-disabled", "peer-diag-disabled", DISABLED_PORT);
    try {
      ws.send(JSON.stringify({ type: "ms:diag", requestId: "diag-1" }));
      const reply = await nextMessage(
        ws,
        (m) => m.requestId === "diag-1",
      );
      assert.equal(reply.type, "ms:diag-unavailable");
      assert.equal(reply.reason, "disabled");

      // The regression this guards: ms:diag must answer with
      // ms:diag-unavailable, NEVER ms:error - the client treats a bare
      // ms:error as a whole-session refusal and latches it permanently. A
      // still-working ms:get-capabilities after the "disabled" reply proves
      // this session was not latched.
      ws.send(JSON.stringify({ type: "ms:get-capabilities" }));
      const caps = await nextMessage(ws, (m) => m.type === "ms:capabilities");
      assert.ok(caps.rtpCapabilities);
    } finally {
      ws.close();
    }
  });
});

// The upgrade's Origin check and the cap on sockets that have not joined
// yet (sfu/admission.ts). Its own process: both are read once at boot.
describe("admission: origin allowlist and unjoined-socket cap", () => {
  let ADMIT_PORT = 0;
  let admitSfu: SpawnedSfu;

  before(async () => {
    ADMIT_PORT = await freePort([PORT]);
    admitSfu = spawnSfu(ADMIT_PORT, {
      DOMAIN: "chat.example",
      SFU_MAX_PENDING_PER_PROXY: "3",
      SFU_MAX_PENDING_PER_IP: "2",
    });
    await waitForServer(ADMIT_PORT);
  });

  after(async () => {
    await admitSfu.stop();
  });

  type Attempt = { ws: WebSocket; status?: number; closeCode?: number; opened: boolean };

  // Opens a socket and reports how it ended up: refused at the upgrade
  // (status), accepted and then closed by the server (closeCode), or open.
  function attempt(opts: { origin?: string; forwardedFor?: string } = {}): Promise<Attempt> {
    const headers: Record<string, string> = {};
    if (opts.forwardedFor) headers["X-Forwarded-For"] = opts.forwardedFor;
    const ws = new WebSocket(wsUrl(ADMIT_PORT), { origin: opts.origin, headers });
    return new Promise((resolve) => {
      const a: Attempt = { ws, opened: false };
      ws.once("unexpected-response", (req, res) => {
        a.status = res.statusCode;
        req.destroy();
        resolve(a);
      });
      ws.once("error", () => resolve(a));
      ws.once("open", () => {
        a.opened = true;
        // A refused-for-capacity socket is closed straight after opening;
        // one that is admitted hears its join challenge first.
        ws.once("close", (code) => {
          a.closeCode = code;
          resolve(a);
        });
        ws.once("message", () => resolve(a));
      });
    });
  }

  async function closeAll(list: Attempt[]): Promise<void> {
    await Promise.all(
      list.map(
        (a) =>
          new Promise<void>((resolve) => {
            if (a.ws.readyState === WebSocket.CLOSED) return resolve();
            a.ws.once("close", () => resolve());
            a.ws.close();
          }),
      ),
    );
    // The server releases a slot on ITS close event, which can land just
    // after the client's.
    await new Promise((r) => setTimeout(r, 100));
  }

  test("a browser on another site is refused at the upgrade; the app's own origin is not", async () => {
    const evil = await attempt({ origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.opened, false);
    const app = await attempt({ origin: "https://chat.example" });
    assert.equal(app.opened, true);
    assert.equal(app.closeCode, undefined);
    const noOrigin = await attempt();
    assert.equal(noOrigin.opened, true);
    await closeAll([app, noOrigin]);
  });

  test("unjoined sockets are capped per client and per proxy", async () => {
    // From 127.0.0.1 with no X-Forwarded-For: a trusted proxy naming nobody.
    const viaProxy: Attempt[] = [];
    for (let i = 0; i < 3; i++) viaProxy.push(await attempt());
    assert.ok(viaProxy.every((a) => a.opened && a.closeCode === undefined));
    const overProxy = await attempt();
    assert.equal(overProxy.closeCode, 1013);
    await closeAll(viaProxy);

    // Named clients each get their own, smaller, allowance.
    const client: Attempt[] = [];
    for (let i = 0; i < 2; i++) client.push(await attempt({ forwardedFor: "203.0.113.5" }));
    assert.ok(client.every((a) => a.opened && a.closeCode === undefined));
    const over = await attempt({ forwardedFor: "203.0.113.5" });
    assert.equal(over.closeCode, 1013);
    const other = await attempt({ forwardedFor: "203.0.113.6" });
    assert.equal(other.closeCode, undefined);
    await closeAll([...client, other]);

    // And the slots come back once those sockets are gone.
    const again = await attempt({ forwardedFor: "203.0.113.5" });
    assert.equal(again.closeCode, undefined);
    await closeAll([again]);
  });
});

test("describeClose: names the SFU's own cuts, and a drop the SFU did not make", () => {
  assert.match(describeClose(1006, "heartbeat", 2640.4), /cut by the SFU: no answer to a heartbeat ping.*after 2640s/);
  assert.match(describeClose(1006, "backpressure", 30), /send queue stayed full/);
  assert.match(describeClose(1006, "join-timeout", 10), /never finished joining/);
  assert.match(describeClose(1006, "replaced", 5), /joined again/);
  assert.match(describeClose(1006, undefined, 44), /without a close frame - the network or a proxy/);
  assert.match(describeClose(1001, undefined, 3), /closed by the client \(code 1001/);
  assert.match(describeClose(4000, undefined, 3), /^closed \(code 4000/);
});

test("sweepHeartbeatConnection: says why it terminated", () => {
  const w = { isAlive: false, ping() {}, terminate() {} };
  assert.equal(sweepHeartbeatConnection(w, 0, 20_000), "heartbeat");
  const alive = { isAlive: true, ping() {}, terminate() {} };
  assert.equal(sweepHeartbeatConnection(alive, 0, 20_000), null);
  const stuck = { backpressured: true, backpressuredSince: 0, ping() {}, terminate() {} };
  assert.equal(sweepHeartbeatConnection(stuck, 30_001, 20_000), "backpressure");
});
