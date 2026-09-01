// Pure unit tests against telemetry.ts - no mediasoup worker, no websocket.
// Fixtures below mirror the REAL shapes mediasoup's getStats() returns
// (WebRtcTransportStat for a transport, RtpStreamRecvStats/SendStats for a
// producer/consumer), per heartbeat.test-style fakes rather than a live
// worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickTransportStats,
  pickRtpStats,
  serializeSnapshot,
  type SfuSnapshot,
} from "./telemetry";

test("pickTransportStats: a realistic WebRtcTransportStat report", () => {
  const reports = [
    {
      type: "webrtc-transport",
      transportId: "transport-1",
      timestamp: 1750000000000,
      iceRole: "controlled",
      iceState: "connected",
      iceSelectedTuple: {
        localIp: "10.0.0.5",
        localAddress: "10.0.0.5",
        localPort: 40017,
        remoteIp: "203.0.113.9",
        remotePort: 54321,
        protocol: "udp",
      },
      dtlsState: "connected",
      bytesReceived: 123456,
      recvBitrate: 48000,
      bytesSent: 654321,
      sendBitrate: 96000,
      rtpBytesReceived: 100000,
      rtpRecvBitrate: 40000,
      rtpBytesSent: 600000,
      rtpSendBitrate: 90000,
      rtxBytesReceived: 0,
      rtxRecvBitrate: 0,
      rtxBytesSent: 0,
      rtxSendBitrate: 0,
      probationBytesSent: 0,
      probationSendBitrate: 0,
    },
  ];

  const picked = pickTransportStats(reports);

  assert.deepEqual(picked.tuple, { protocol: "udp", localPort: 40017 });
  assert.equal(picked.bytesSent, 654321);
  assert.equal(picked.bytesReceived, 123456);
  // WebRtcTransportStat carries no rtt field in this mediasoup version.
  assert.equal(picked.rtt, null);
});

test("pickTransportStats: a malformed report array never throws and falls back safely", () => {
  assert.doesNotThrow(() => pickTransportStats([]));
  assert.deepEqual(pickTransportStats([]), {
    tuple: null,
    bytesSent: 0,
    bytesReceived: 0,
    rtt: null,
  });

  assert.doesNotThrow(() => pickTransportStats([null]));
  assert.doesNotThrow(() => pickTransportStats([undefined]));
  assert.doesNotThrow(() => pickTransportStats(["not an object"]));
  assert.doesNotThrow(() =>
    pickTransportStats([
      {
        // Wrong types throughout: a real report never looks like this, but a
        // future mediasoup version renaming/retyping a field must not throw.
        iceSelectedTuple: "garbage",
        bytesSent: "a lot",
        bytesReceived: null,
        rtt: "12ms",
      },
    ]),
  );

  const picked = pickTransportStats([
    { iceSelectedTuple: { protocol: 7, localPort: "x" }, bytesSent: NaN, bytesReceived: Infinity },
  ]);
  assert.equal(picked.tuple, null);
  assert.equal(picked.bytesSent, 0);
  assert.equal(picked.bytesReceived, 0);
  assert.equal(picked.rtt, null);
});

test("pickRtpStats: a realistic RtpStreamRecvStats report", () => {
  const reports = [
    {
      type: "inbound-rtp",
      timestamp: 1750000000000,
      ssrc: 11111111,
      kind: "audio",
      mimeType: "audio/opus",
      packetsLost: 3,
      fractionLost: 0.01,
      jitter: 2,
      packetsDiscarded: 0,
      packetsRetransmitted: 0,
      packetsRepaired: 0,
      nackCount: 0,
      nackPacketCount: 0,
      pliCount: 0,
      firCount: 0,
      roundTripTime: 24,
      score: 9,
      packetCount: 5000,
      byteCount: 640000,
      bitrate: 32000,
      bitrateByLayer: {},
    },
  ];

  assert.deepEqual(pickRtpStats(reports), { bitrate: 32000, packetsLost: 3 });
});

test("pickRtpStats: a malformed report array never throws and falls back to zero", () => {
  assert.doesNotThrow(() => pickRtpStats([]));
  assert.deepEqual(pickRtpStats([]), { bitrate: 0, packetsLost: 0 });
  assert.deepEqual(pickRtpStats([null]), { bitrate: 0, packetsLost: 0 });
  assert.deepEqual(
    pickRtpStats([{ bitrate: "fast", packetsLost: -Infinity }]),
    { bitrate: 0, packetsLost: 0 },
  );
});

function fixtureSnapshot(roomSize: number, producersPerPeer: number): SfuSnapshot {
  return {
    schemaVersion: 1,
    takenAt: 1750000000000,
    roomPeerCount: roomSize,
    self: {
      peerId: "self-peer",
      transports: [],
      producers: [],
      consumers: [],
      cumulativeProduces: 0,
      backpressured: false,
    },
    room: Array.from({ length: roomSize }, (_, i) => ({
      peerId: `peer-${i}`,
      producers: Array.from({ length: producersPerPeer }, (_, j) => ({
        id: `peer-${i}-producer-${j}`,
        source: "camera",
        kind: "video",
        consumers: 0,
      })),
    })),
    ceilings: {
      peersPerRoom: 32,
      producersPerPeer: 8,
      consumersPerPeer: 256,
      rooms: 1,
      maxRooms: 250,
    },
  };
}

test("serializeSnapshot: truncates at both the room-peer cap and the per-peer producer cap", () => {
  const snapshot = fixtureSnapshot(5, 3);
  const truncated = serializeSnapshot(snapshot, 2, 1);

  assert.equal(truncated.room.length, 2);
  for (const entry of truncated.room) {
    assert.equal(entry.producers.length, 1);
  }
  // roomPeerCount reports the TRUE count, unaffected by display truncation.
  assert.equal(truncated.roomPeerCount, 5);
});

test("serializeSnapshot: under both caps leaves the snapshot untouched", () => {
  const snapshot = fixtureSnapshot(2, 1);
  const result = serializeSnapshot(snapshot, 32, 8);
  assert.deepEqual(result.room, snapshot.room);
});

test("a serialized snapshot never contains a remote address", () => {
  const remoteIp = "203.0.113.42";
  const picked = pickTransportStats([
    {
      iceSelectedTuple: {
        localIp: "10.0.0.1",
        localAddress: "10.0.0.1",
        localPort: 40001,
        remoteIp,
        remotePort: 55555,
        protocol: "udp",
      },
      bytesSent: 1,
      bytesReceived: 1,
    },
  ]);

  const snapshot: SfuSnapshot = {
    ...fixtureSnapshot(1, 1),
    self: {
      peerId: "self-peer",
      transports: [
        {
          dir: "send",
          iceState: "connected",
          dtlsState: "connected",
          ...picked,
        },
      ],
      producers: [],
      consumers: [],
      cumulativeProduces: 0,
      backpressured: false,
    },
  };

  const serialized = serializeSnapshot(snapshot, 32, 8);
  const json = JSON.stringify(serialized);
  assert.ok(!json.includes(remoteIp), "serialized snapshot must never carry a remote address");
  assert.ok(json.includes("udp"), "the protocol should still be present");
  assert.ok(json.includes("40001"), "the local port should still be present");
});
