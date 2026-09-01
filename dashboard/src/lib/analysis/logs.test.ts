import { describe, expect, it } from "vitest";
import {
  parseConsoleLog,
  parseRelayLog,
  parseSfuLog,
  parseSfuTelemetry,
  resolveSuffix,
} from "./logs";

const TS = "2026-09-01T02:03:04.500000000Z";
const TS_MS = Date.parse("2026-09-01T02:03:04.500Z");

function withTs(line: string): string {
  return `${TS} ${line}`;
}

// ---------------------------------------------------------------------------
// parseSfuLog - one real sample line per template, verbatim from sfu/index.ts
// ---------------------------------------------------------------------------

interface Case {
  line: string;
  kind: string;
  peer?: string | null;
  d?: Record<string, unknown>;
}

const SFU_CASES: Case[] = [
  { line: "[sfu] join with invalid roomCode or peerId, closing", kind: "sfu.join", d: { reason: "invalid-ids" } },
  {
    line: "[sfu] room ceiling reached (64); refusing new room room-9f3a",
    kind: "sfu.join",
    d: { reason: "server-full", maxRooms: 64, roomRaw: "room-9f3a" },
  },
  {
    line: "[sfu] room room-9f3a is at the peer ceiling (32); refusing peer peer-b",
    kind: "sfu.join",
    peer: "peer-b",
    d: { reason: "room-full", roomRaw: "room-9f3a", maxPeers: 32 },
  },
  {
    line: "[sfu] duplicate peerId peer-a in room room-9f3a answered a liveness probe; refusing the new connection",
    kind: "sfu.join",
    peer: "peer-a",
    d: { reason: "peer-id-in-use", phase: "liveness-probe", roomRaw: "room-9f3a" },
  },
  {
    line: "[sfu] peerId peer-a in room room-9f3a was claimed while probing; refusing the new connection",
    kind: "sfu.join",
    peer: "peer-a",
    d: { reason: "peer-id-in-use", phase: "claimed-while-probing", roomRaw: "room-9f3a" },
  },
  {
    line: "[sfu] duplicate peerId peer-a in room room-9f3a; the previous session is dead, replacing it",
    kind: "sfu.join",
    peer: "peer-a",
    d: { reason: "replaced-dead-session", roomRaw: "room-9f3a" },
  },
  {
    line: "[sfu] peer peer-a joined room room-9f3a",
    kind: "sfu.join",
    peer: "peer-a",
    d: { roomRaw: "room-9f3a" },
  },
  {
    line: "[sfu] create-transport: bad direction from peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "bad-direction", op: "create-transport" },
  },
  {
    line: "[sfu] create-transport: a send transport is already being created for peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "duplicate-transport-creating", direction: "send" },
  },
  {
    line: "[sfu] duplicate recv transport for peer peer-a; closing the previous one",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "duplicate-transport", direction: "recv" },
  },
  {
    line: "[sfu] connect-transport: bad direction from peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "bad-direction", op: "connect-transport" },
  },
  {
    line: "[sfu] connect-transport: send transport is already connected for peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "already-connected", direction: "send" },
  },
  {
    line: "[sfu] connect-transport: no recv transport for peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "no-transport", op: "connect-transport", direction: "recv" },
  },
  {
    line: "[sfu] produce: no send transport for peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "no-send-transport", op: "produce" },
  },
  {
    line: "[sfu] produce: invalid source from peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "invalid-produce", op: "produce" },
  },
  {
    line: "[sfu] peer peer-a is at the producer ceiling (16); refusing produce",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "producer-limit", ceiling: 16 },
  },
  {
    line: "[sfu] peer peer-a has exceeded cumulative produce limit (200); refusing produce",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "producer-limit", cumulative: true, ceiling: 200 },
  },
  {
    line: "[sfu] peer peer-a produced prod-1 (camera)",
    kind: "sfu.produce",
    peer: "peer-a",
    d: { producerId: "prod-1", source: "camera" },
  },
  {
    line: "[sfu] consume: no recv transport for peer peer-a",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "no-recv-transport", op: "consume" },
  },
  {
    line: "[sfu] peer peer-a already consuming producer prod-1; resending consumer options",
    kind: "sfu.consume",
    peer: "peer-a",
    d: { producerId: "prod-1", resent: true },
  },
  {
    line: "[sfu] peer peer-a is at the consumer ceiling (256); refusing consume",
    kind: "sfu.error",
    peer: "peer-a",
    d: { reason: "consumer-limit", ceiling: 256 },
  },
  {
    line: "[sfu] cannot consume producer prod-1 for peer peer-a",
    kind: "sfu.consume.failed",
    peer: "peer-a",
    d: { producerId: "prod-1" },
  },
  {
    line: "[sfu] peer peer-a consuming prod-1 (camera)",
    kind: "sfu.consume",
    peer: "peer-a",
    d: { producerId: "prod-1", source: "camera" },
  },
  {
    line: "[sfu] resume-consumer failed for peer peer-a: Error: boom",
    kind: "sfu.consume.failed",
    peer: "peer-a",
    d: { reason: "resume-failed" },
  },
  { line: "[sfu] oversized frame, closing", kind: "sfu.ws.error", d: { reason: "oversized-frame" } },
  { line: "[sfu] malformed frame from client", kind: "sfu.ws.error", d: { reason: "malformed-frame" } },
  { line: "[sfu] invalid JSON from client", kind: "sfu.ws.error", d: { reason: "invalid-json" } },
  {
    line: "[sfu] expected join as first message, got: ping",
    kind: "sfu.ws.error",
    d: { reason: "expected-join-first" },
  },
  { line: "[sfu] unknown message type: foo", kind: "sfu.ws.error", d: { reason: "unknown-type" } },
  { line: "[sfu] ws error: socket hang up", kind: "sfu.ws.error", d: { reason: "ws-error" } },
];

describe("parseSfuLog templates", () => {
  it.each(SFU_CASES)("maps: $line", ({ line, kind, peer, d }) => {
    const result = parseSfuLog(withTs(line), "sfu.log");
    expect(result.unmatched).toBe(0);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.kind).toBe(kind);
    expect(event.at).toBe(TS_MS);
    expect(event.t).toBe(TS_MS);
    expect(event.vantage).toBe("log");
    expect(event.source).toBe("sfu.log");
    expect(event.observer).toBe("sfu");
    if (peer !== undefined) expect(event.peer).toBe(peer);
    if (d) expect(event.d).toMatchObject(d);
  });

  it("skips a [sfu-telemetry] line entirely: no event, not counted as unmatched", () => {
    const text = [
      withTs('[sfu-telemetry] {"v":1,"t":1750000000000,"room":"room-9f3a","peers":[]}'),
      withTs("[sfu] peer peer-a joined room room-9f3a"),
    ].join("\n");
    const result = parseSfuLog(text, "sfu.log");
    expect(result.unmatched).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("sfu.join");
  });

  it("an unmatched line survives as a raw event and increments unmatched", () => {
    const line = "[sfu] mediasoup worker started (pid 4242)";
    const result = parseSfuLog(withTs(line), "sfu.log");
    expect(result.unmatched).toBe(1);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.d?.raw).toBe(line);
    expect(event.vantage).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// parseRelayLog - one real sample line per template, verbatim from relay/main.go
// ---------------------------------------------------------------------------

const RELAY_CASES: Case[] = [
  {
    line: "[rv] a1b2c3d4 left room [room-xyz] (2 peers)",
    kind: "rv.unregister",
    d: { peerSuffix: "a1b2c3d4", roomRaw: "room-xyz", remaining: 2 },
  },
  {
    line: "[rv] BUG: outbound PEERS frame to a1b2c3d4 is 5000 bytes (> 4096), dropping",
    kind: "rv.send.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "oversize-outbound", msgType: "PEERS", bytes: 5000, maxBytes: 4096 },
  },
  {
    line: "[rv] a1b2c3d4 is not reading its stream, dropping it",
    kind: "rv.close",
    d: { peerSuffix: "a1b2c3d4", reason: "outbox-full" },
  },
  {
    line: "[rv] registry is at its 100000-registration ceiling, ignoring further REGISTERs",
    kind: "rv.register",
    d: { refused: "capped", scope: "global", ceiling: 100000 },
  },
  {
    line: "[rv] a1b2c3d4 hit the 64-room cap, ignoring further REGISTERs",
    kind: "rv.register",
    d: { peerSuffix: "a1b2c3d4", refused: "capped", scope: "peer", ceiling: 64 },
  },
  {
    line: "[rv] a1b2c3d4 joined room [room-xyz] (3 peers)",
    kind: "rv.register",
    d: { peerSuffix: "a1b2c3d4", roomRaw: "room-xyz", peers: 3 },
  },
  { line: "[rv] a1b2c3d4 disconnected", kind: "peer.disconnect", d: { peerSuffix: "a1b2c3d4" } },
  { line: "[rv] a1b2c3d4 opened rendezvous stream", kind: "rv.open", d: { peerSuffix: "a1b2c3d4" } },
  {
    line: "[rv] a1b2c3d4 already holds 4 rendezvous streams, refusing another",
    kind: "rv.open.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "stream-cap", maxStreams: 4 },
  },
  {
    line: "[rv] a1b2c3d4 stream closed (1 still open)",
    kind: "rv.close",
    d: { peerSuffix: "a1b2c3d4", reason: "unknown", remainingStreams: 1 },
  },
  {
    line: "[rv] message too large from a1b2c3d4: 70000 bytes, closing stream",
    kind: "rv.frame.oversize",
    d: { peerSuffix: "a1b2c3d4", bytes: 70000 },
  },
  {
    line: "[rv] bad message from a1b2c3d4: invalid character",
    kind: "rv.send.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "bad-message", phase: "inbound" },
  },
  {
    line: "[rv] a1b2c3d4 sent an unusable room id (300 bytes), ignoring",
    kind: "rv.send.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "invalid-room-id", bytes: 300 },
  },
  {
    line: "[rv] unknown type from a1b2c3d4: FOO",
    kind: "rv.send.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "unknown-type", msgType: "FOO" },
  },
  {
    line: "[rv] a1b2c3d4 is changing rooms faster than 5/1s, ignoring",
    kind: "rv.send.fail",
    d: { peerSuffix: "a1b2c3d4", reason: "membership-rate-limited", limit: 5, window: "1s" },
  },
  {
    line: "[rv] a1b2c3d4 exhausted its empty-room register budget (3/1m0s), ignoring",
    kind: "rv.register",
    d: { peerSuffix: "a1b2c3d4", refused: "oracle", limit: 3, window: "1m0s" },
  },
  { line: "[peer] connect a1b2c3d4", kind: "peer.connect", d: { peerSuffix: "a1b2c3d4" } },
  { line: "[peer] disconnect a1b2c3d4", kind: "peer.disconnect", d: { peerSuffix: "a1b2c3d4" } },
];

describe("parseRelayLog templates", () => {
  it.each(RELAY_CASES)("maps: $line", ({ line, kind, d }) => {
    const result = parseRelayLog(withTs(line), "relay.log");
    expect(result.unmatched).toBe(0);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.kind).toBe(kind);
    expect(event.at).toBe(TS_MS);
    expect(event.peer).toBeNull(); // relay never resolves a suffix inline
    expect(event.observer).toBe("relay");
    if (d) expect(event.d).toMatchObject(d);
  });

  it("strips a Go std-log date/time prefix ahead of the docker timestamp for matching, but never uses it as the clock", () => {
    // Go's default log flags stamp `YYYY/MM/DD HH:MM:SS ` ahead of every
    // relay line - a second, coarser clock than docker's own `-t` wrapper.
    const line = `${TS} 2026/09/01 02:03:04 [rv] a1b2c3d4 disconnected`;
    const result = parseRelayLog(line, "relay.log");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("peer.disconnect");
    expect(result.events[0]?.at).toBe(TS_MS);
  });

  it("accepts the +00:00 numeric-offset docker timestamp form, not only Z", () => {
    const line = "2026-09-01T02:03:04+00:00 [rv] a1b2c3d4 opened rendezvous stream";
    const result = parseRelayLog(line, "relay.log");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.at).toBe(Date.parse("2026-09-01T02:03:04+00:00"));
  });

  it("anchors relative to line order and warns when no docker -t timestamp is present", () => {
    const text = ["[rv] a1b2c3d4 opened rendezvous stream", "[rv] a1b2c3d4 disconnected"].join("\n");
    const result = parseRelayLog(text, "relay.log");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.at).toBe(0);
    expect(result.events[1]?.at).toBe(1);
    expect(result.warnings.some((w) => w.includes("relative"))).toBe(true);
  });

  it("an unmatched line survives as a raw event and increments unmatched", () => {
    const line = "[relay] this service must run as exactly ONE replica; see deploy/README.md";
    const result = parseRelayLog(withTs(line), "relay.log");
    expect(result.unmatched).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.d?.raw).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// parseConsoleLog
// ---------------------------------------------------------------------------

describe("parseConsoleLog", () => {
  it("maps a house-style [tag] line to its DiagKind", () => {
    const result = parseConsoleLog(withTs("[Transport] relay connected"), "console.txt");
    expect(result.unmatched).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("relay.dial.ok");
    expect(result.events[0]?.observer).toBe("");
  });

  it("carries a peer suffix in d.peerSuffix, never resolving it inline", () => {
    const result = parseConsoleLog(withTs("[Transport] stream never confirmed for a1b2c3d4"), "console.txt");
    expect(result.events[0]?.kind).toBe("stream.confirm.fail");
    expect(result.events[0]?.peer).toBeNull();
    expect(result.events[0]?.d?.peerSuffix).toBe("a1b2c3d4");
  });

  it("maps a mailbox delivery-failed line with delivered:false", () => {
    const result = parseConsoleLog(withTs("[mailbox] delivery failed, keeping blob: Error: timeout"), "console.txt");
    expect(result.events[0]?.kind).toBe("dm.mailbox.collect");
    expect(result.events[0]?.d).toMatchObject({ delivered: false });
  });

  it("an unmatched line survives as a raw event and increments unmatched", () => {
    const result = parseConsoleLog(withTs("[voice] setSinkId failed for peer-a: NotFoundError"), "console.txt");
    expect(result.unmatched).toBe(1);
    expect(result.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseSfuTelemetry
// ---------------------------------------------------------------------------

describe("parseSfuTelemetry", () => {
  it("summarises a structured sweep line into one sfu.diag event, never leaking the room code into the room field", () => {
    const payload = {
      v: 1,
      t: 1750000000000,
      room: "room-9f3a",
      peers: [
        {
          peerId: "peer-a",
          producers: [
            { id: "prod-1", source: "camera", kind: "video", consumers: 2 },
            { id: "prod-2", source: "mic", kind: "audio", consumers: 1 },
          ],
        },
        { peerId: "peer-b", producers: [{ id: "prod-3", source: "screen", kind: "video", consumers: 0 }] },
      ],
    };
    const line = `[sfu-telemetry] ${JSON.stringify(payload)}`;
    const result = parseSfuTelemetry(line, "sfu.log");
    expect(result.unmatched).toBe(0);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.kind).toBe("sfu.diag");
    expect(event.sev).toBe("debug");
    expect(event.room).toBeNull();
    expect(event.at).toBe(1750000000000);
    expect(event.t).toBe(1750000000000);
    expect(event.observer).toBe("sfu");
    expect(event.d).toMatchObject({
      roomRaw: "room-9f3a",
      roomPeers: 2,
      producers: 3,
      consumers: 3,
    });
  });

  it("ignores a non-telemetry line entirely (parseSfuLog's job), not counting it as unmatched", () => {
    const result = parseSfuTelemetry(withTs("[sfu] peer peer-a joined room room-9f3a"), "sfu.log");
    expect(result.events).toHaveLength(0);
    expect(result.unmatched).toBe(0);
  });

  it("a [sfu-telemetry] line with malformed JSON is counted as unmatched, and does not throw", () => {
    expect(() => parseSfuTelemetry("[sfu-telemetry] {not valid json", "sfu.log")).not.toThrow();
    const result = parseSfuTelemetry("[sfu-telemetry] {not valid json", "sfu.log");
    expect(result.unmatched).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.d?.raw).toContain("[sfu-telemetry]");
  });

  it("concatenates with parseSfuLog on the same text with no double counting", () => {
    const text = [
      '[sfu-telemetry] {"v":1,"t":1750000000000,"room":"room-9f3a","peers":[{"peerId":"peer-a","producers":[{"id":"p1","source":"camera","kind":"video","consumers":1}]}]}',
      "[sfu] peer peer-a joined room room-9f3a",
    ].join("\n");
    const telemetry = parseSfuTelemetry(text, "sfu.log");
    const freeform = parseSfuLog(text, "sfu.log");
    expect(telemetry.events).toHaveLength(1);
    expect(telemetry.events[0]?.kind).toBe("sfu.diag");
    expect(freeform.events).toHaveLength(1);
    expect(freeform.events[0]?.kind).toBe("sfu.join");
    expect(freeform.unmatched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveSuffix
// ---------------------------------------------------------------------------

describe("resolveSuffix", () => {
  const peerA = "12D3KooWAlphaAlphaAlphaAlphaAlphaAlphaAAAAAAAA1a2b3c4d";
  const peerB = "12D3KooWBetaBetaBetaBetaBetaBetaBetaBetaBBBBBBB1a2b3c4d";

  it("resolves a unique suffix to its full peerId", () => {
    expect(resolveSuffix("1a2b3c4d", [peerA, "12D3KooWSomeoneElseZZZZZZZZZ"])).toEqual({
      peerId: peerA,
      ambiguous: false,
    });
  });

  it("returns null with no attribution when nothing matches", () => {
    expect(resolveSuffix("deadbeef", [peerA])).toEqual({ peerId: null, ambiguous: false });
  });

  it("an ambiguous 8-character suffix produces no attribution, so a caller can warn instead of guessing wrong", () => {
    // peerA and peerB share the same last 8 characters by construction.
    const { peerId, ambiguous } = resolveSuffix("1a2b3c4d", [peerA, peerB]);
    expect(peerId).toBeNull();
    expect(ambiguous).toBe(true);

    // The integration pattern a downstream caller (e.g. sources.svelte.ts,
    // once bundles are loaded) is expected to follow: push a warning rather
    // than attribute the event to either peer.
    const warnings: string[] = [];
    if (ambiguous) warnings.push(`ambiguous peer suffix "1a2b3c4d" matches more than one known peer`);
    expect(warnings).toHaveLength(1);
  });
});
