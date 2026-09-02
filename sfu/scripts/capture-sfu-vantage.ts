/**
 * Capture a real SFU vantage for the analysis dashboard's fixtures.
 *
 * The dashboard's `parseSfuTelemetry` must be validated against lines a real
 * SFU printed, and its `SfuSnapshot` reader against a snapshot a real
 * mediasoup router produced. A hand-written fixture would only prove the
 * parser agrees with itself.
 *
 * Two peers join one room, one produces audio, then this script asks for a
 * snapshot over `ms:diag`. Run it against an SFU started with
 * `SFU_TELEMETRY=1`, and capture that SFU's stdout separately - the
 * `[sfu-telemetry]` sweep prints there, once per room per 10 s.
 *
 *   cd sfu
 *   SFU_TELEMETRY=1 npx tsx index.ts > /tmp/sfu.log 2>&1 &
 *   npx tsx scripts/capture-sfu-vantage.ts
 *
 * It writes the snapshot next to the bundle fixtures. See
 * dashboard/src/lib/analysis/fixtures/README.md.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../dashboard/src/lib/analysis/fixtures");
const PORT = Number(process.env.SFU_PORT ?? 3000);
const ROOM = process.env.ROOM ?? "fixturecapture01";

interface Msg {
  type: string;
  [key: string]: unknown;
}

function nextMessage(
  ws: WebSocket,
  filter: (m: Msg) => boolean,
  timeoutMs = 8000
): Promise<Msg> {
  const { promise, resolve, reject } = Promise.withResolvers<Msg>();
  const timer = setTimeout(() => {
    ws.off("message", onMessage);
    reject(new Error("timed out waiting for a message"));
  }, timeoutMs);
  function onMessage(raw: Buffer): void {
    const msg = JSON.parse(raw.toString()) as Msg;
    if (!filter(msg)) return;
    clearTimeout(timer);
    ws.off("message", onMessage);
    resolve(msg);
  }
  ws.on("message", onMessage);
  return promise;
}

async function joinRoom(roomCode: string, peerId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sfu`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.once("open", () => resolve());
  ws.once("error", reject);
  await promise;
  ws.send(JSON.stringify({ type: "join", roomCode, peerId }));
  return ws;
}

/** The same shape `sfu/index.test.ts` uses, so the SFU accepts a real produce. */
function audioRtpParameters(ssrc: number): unknown {
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
    rtcp: { cname: `capture-${ssrc}`, reducedSize: true },
  };
}

async function produce(ws: WebSocket, ssrc: number): Promise<string> {
  ws.send(JSON.stringify({ type: "ms:create-transport", direction: "send" }));
  await nextMessage(
    ws,
    (m) => m.type === "ms:transport-options" && m.direction === "send"
  );
  ws.send(
    JSON.stringify({
      type: "ms:produce",
      kind: "audio",
      rtpParameters: audioRtpParameters(ssrc),
      source: "camera",
    })
  );
  const produced = await nextMessage(ws, (m) => m.type === "ms:produced");
  return String(produced.producerId);
}

async function main(): Promise<void> {
  const a = await joinRoom(ROOM, "capture-peer-a");
  const b = await joinRoom(ROOM, "capture-peer-b");

  const producerId = await produce(a, 44444444);
  console.log(`produced ${producerId}`);
  await nextMessage(b, (m) => m.type === "ms:new-producer");

  // Give the 10 s heartbeat sweep time to print at least one line.
  await new Promise((r) => setTimeout(r, 12_000));

  a.send(JSON.stringify({ type: "ms:diag", requestId: "capture-1" }));
  const reply = await nextMessage(
    a,
    (m) => m.type === "ms:diag" || m.type === "ms:diag-unavailable"
  );
  if (reply.type !== "ms:diag") {
    console.error(`refused: ${JSON.stringify(reply)}`);
    process.exit(1);
  }

  writeFileSync(
    join(OUT, "sfu-snapshot.json"),
    JSON.stringify(reply.snapshot, null, 1)
  );
  console.log("wrote sfu-snapshot.json");

  a.close();
  b.close();
  process.exit(0);
}

void main();
