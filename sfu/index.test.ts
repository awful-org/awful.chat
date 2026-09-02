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
import { WebSocket } from "ws";
import { sweepHeartbeatConnection, type HeartbeatSocket } from "./heartbeat";

// Picking a port off the pid keeps concurrent test runs on the same machine
// from colliding on a fixed number.
const PORT = 34000 + (process.pid % 1000);
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
  peerId: string,
  port: number = PORT,
): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(port));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "join", roomCode, peerId }));
  return ws;
}

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
    assert.equal(newProducer.peerId, "peer-dead-a");

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
      (m) => m.type === "ms:peer-left" && m.peerId === "peer-dead-a",
      HEARTBEAT_INTERVAL_MS * 2 + 4000,
    );
    assert.equal(peerLeft.peerId, "peer-dead-a");
    // Reaped within roughly two heartbeat ticks (isAlive goes false on the
    // first unanswered ping, terminated on the second), not the old 30s-tick
    // heartbeat's up-to-60s window.
    assert.ok(Date.now() - start < HEARTBEAT_INTERVAL_MS * 2 + 3000);

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

    assert.equal(reply.snapshot.self.peerId, "peer-diag-a");
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
  const DISABLED_PORT = PORT + 500;
  let disabledSfu: SpawnedSfu;

  before(async () => {
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
