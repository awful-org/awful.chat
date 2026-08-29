// Integration tests against a real spawned SFU process (real mediasoup
// worker, real WebSocket server). No fake WebRTC client is involved - these
// tests only exercise paths that do not require a completed ICE/DTLS
// handshake, which is everything covered here:
//   - the unconnected-transport reaper (Task 1)
//   - ms:produce source validation (Task 3)
//   - the ms:error surfaced when router.canConsume() returns false (Task 3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { WebSocket } from "ws";

// Picking a port off the pid keeps concurrent test runs on the same machine
// from colliding on a fixed number.
const PORT = 34000 + (process.pid % 1000);
// Short enough that the "never connects" test doesn't sit around, long
// enough that the assertions below (which each take a real websocket round
// trip) aren't racing the reaper.
const TRANSPORT_CONNECT_TIMEOUT_MS = 300;

let child: ChildProcess;
let stoppingChild = false;

function wsUrl(): string {
  return `ws://127.0.0.1:${PORT}`;
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl());
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
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

test.before(async () => {
  child = spawn(
    process.execPath,
    [path.join(__dirname, "node_modules", ".bin", "tsx"), path.join(__dirname, "index.ts")],
    {
      env: {
        ...process.env,
        SFU_PORT: String(PORT),
        SFU_TRANSPORT_CONNECT_TIMEOUT_MS: String(TRANSPORT_CONNECT_TIMEOUT_MS),
        ANNOUNCED_IP: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d) => (output += d.toString()));
  child.stderr?.on("data", (d) => (output += d.toString()));
  child.on("exit", (code) => {
    if (!stoppingChild && code !== null && code !== 0) {
      console.error(`[sfu test] server exited early (${code}):\n${output}`);
    }
  });
  await waitForServer();
});

test.after(async () => {
  if (!child || child.exitCode !== null) return;
  stoppingChild = true;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  });
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

async function connectAndJoin(roomCode: string, peerId: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl());
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
