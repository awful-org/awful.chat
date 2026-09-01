import { describe, it, expect, beforeEach } from "vitest";
import { buildClientBundle, trimBundleForUpload } from "./bundle";
import { ev } from "./event";
import {
  beginSession,
  initRecorder,
  noteIdentity,
  rec,
  recordCounters,
  recordSfuSnapshot,
  recorderSnapshot,
  refs,
  resetRecorderForTest,
} from "./recorder";
import { transportEvent } from "./taps";
import type { ClientBundle, DiagEvent, SfuSnapshot } from "./schema";

const ROOM_CODE = "a1b2c3d4e5f60718";
const DID = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";
const PAYLOAD_TEXT = "the secret plan for the weekend";
const INFO_HASH = "0123456789abcdef0123456789abcdef01234567";

const CTX = {
  version: "1.2.3",
  commit: "abc1234",
  ua: "Mozilla/5.0 (test)",
  now: 1_750_000_000_000,
  randomHex: (bytes: number) => "b".repeat(bytes * 2),
};

function sfuFixture(takenAt: number): SfuSnapshot {
  return {
    schemaVersion: 1,
    takenAt,
    roomPeerCount: 2,
    self: {
      peerId: "12D3KooWSELF",
      transports: [
        {
          dir: "send",
          iceState: "completed",
          dtlsState: "connected",
          tuple: { protocol: "udp", localPort: 40000 },
          bytesSent: 1,
          bytesReceived: 2,
          rtt: 30,
        },
      ],
      producers: [],
      consumers: [],
      cumulativeProduces: 1,
      backpressured: false,
    },
    room: [],
    ceilings: {
      peersPerRoom: 32,
      producersPerPeer: 8,
      consumersPerPeer: 256,
      rooms: 1,
      maxRooms: 64,
    },
  };
}

describe("buildClientBundle", () => {
  beforeEach(() => {
    resetRecorderForTest();
    initRecorder({
      selfPeerId: () => "12D3KooWSELF",
      runtime: () => ({
        apiHost: "relay.example.org",
        relayPeerId: "12D3KooWRELAY",
        sfuHosts: ["sfu.example.org"],
        configured: true,
      }),
      faultsActive: () => false,
    });
    beginSession("s0s0s0s0s0s0s0s0", 1_749_999_000_000);
  });

  it("never leaks a room code, a DID, a payload or an infoHash", () => {
    // THE GATE for the whole feature. Feed the recorder every category of
    // secret through the paths that really carry them, then assert none of the
    // four strings survives serialization.
    const body = transportEvent("message", [
      "12D3KooWPEER",
      new TextEncoder().encode(PAYLOAD_TEXT),
      ROOM_CODE,
    ]);
    expect(body).not.toBeNull();
    if (body) rec(body);
    noteIdentity("12D3KooWPEER", DID);
    rec(ev("file.announce", { d: { fileRef: refs().fileRef(INFO_HASH) } }));
    rec(ev("app.msg.out", { room: refs().roomRef(ROOM_CODE), d: { bytes: 31 } }));

    const json = JSON.stringify(buildClientBundle(recorderSnapshot(), CTX));
    expect(json).not.toContain(ROOM_CODE);
    expect(json).not.toContain(DID);
    expect(json).not.toContain("did:key:");
    expect(json).not.toContain(PAYLOAD_TEXT);
    expect(json).not.toContain(INFO_HASH);
  });

  it("names the room by its bundle-local ordinal", () => {
    rec(ev("app.join", { room: refs().roomRef(ROOM_CODE) }));
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(bundle.rooms).toHaveLength(1);
    expect(bundle.rooms[0].ref).toBe("r1");
    expect(bundle.rooms[0].kind).toBe("text");
    expect(bundle.events[0].room).toBe("r1");
  });

  it("keeps full peerIds, which both servers already have", () => {
    rec(ev("peer.connect", { peer: "12D3KooWPEER" }));
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(bundle.self.peerId).toBe("12D3KooWSELF");
    expect(bundle.peers[0].peerId).toBe("12D3KooWPEER");
  });

  it("carries no did field at all, not even the uploader's own", () => {
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(Object.keys(bundle.self)).toEqual(["peerId"]);
  });

  it("records a host, never a URL with a path", () => {
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(bundle.config.apiHost).toBe("relay.example.org");
    expect(bundle.config.apiHost).not.toContain("/");
    expect(bundle.config.sfuHosts.every((h) => !h.includes("/"))).toBe(true);
  });

  it("stamps the schema version, the ids and the session window", () => {
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      vantage: "client",
      bundleId: "b".repeat(32),
      sessionId: "s0s0s0s0s0s0s0s0",
      createdAt: CTX.now,
      startedAt: 1_749_999_000_000,
      app: { version: "1.2.3", commit: "abc1234" },
    });
  });

  it("truncates the user agent", () => {
    const bundle = buildClientBundle(recorderSnapshot(), {
      ...CTX,
      ua: "u".repeat(1000),
    });
    expect(bundle.env.ua).toHaveLength(200);
  });

  it("reports the recorder's own losses", () => {
    recordCounters({ "t.connects": 4 });
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(bundle.counters).toEqual({ "t.connects": 4 });
    expect(bundle.meta).toMatchObject({
      dropped: 0,
      suppressed: {},
      faultsActive: false,
      truncated: false,
    });
  });

  it("survives structured cloning, so it can be written to IndexedDB", () => {
    rec(ev("session.start"));
    recordSfuSnapshot(sfuFixture(1));
    const bundle = buildClientBundle(recorderSnapshot(), CTX);
    expect(structuredClone(bundle)).toEqual(bundle);
  });
});

describe("trimBundleForUpload", () => {
  function bundleWith(events: DiagEvent[], snapshots = 0): ClientBundle {
    resetRecorderForTest();
    beginSession("s", 0);
    const base = buildClientBundle(recorderSnapshot(), CTX);
    for (let i = 0; i < snapshots; i++) base.sfuSnapshots.push(sfuFixture(i));
    base.events = events;
    return base;
  }

  function eventsOfEachSeverity(perClass: number): DiagEvent[] {
    const out: DiagEvent[] = [];
    let seq = 1;
    const kinds = [
      ["peer.rtt", "debug"],
      ["session.config", "info"],
      ["peer.disconnect", "warn"],
      ["peer.dial.fail", "error"],
    ] as const;
    for (const [kind, sev] of kinds) {
      for (let i = 0; i < perClass; i++) {
        out.push({
          seq: seq++,
          t: seq,
          kind,
          sev,
          peer: null,
          room: null,
          d: { pad: "x".repeat(150) },
        });
      }
    }
    return out;
  }

  it("returns the bundle untouched when it already fits", () => {
    const bundle = bundleWith(eventsOfEachSeverity(1));
    const trimmed = trimBundleForUpload(bundle, 1_000_000);
    expect(trimmed).toBe(bundle);
    expect(trimmed.meta.truncated).toBe(false);
  });

  it("sacrifices debug before error and marks the bundle truncated", () => {
    const bundle = bundleWith(eventsOfEachSeverity(20));
    const trimmed = trimBundleForUpload(bundle, 6000);
    expect(trimmed.meta.truncated).toBe(true);
    expect(trimmed.events.length).toBeLessThan(bundle.events.length);
    const kept = new Set(trimmed.events.map((e) => e.sev));
    expect(kept.has("error")).toBe(true);
    expect(kept.has("debug")).toBe(false);
  });

  it("drops the SFU snapshots first, since sfu.diag keeps their summary", () => {
    const bundle = bundleWith(eventsOfEachSeverity(2), 8);
    const before = JSON.stringify(bundle).length;
    const trimmed = trimBundleForUpload(bundle, Math.floor(before / 2));
    expect(trimmed.sfuSnapshots.length).toBeLessThan(8);
    expect(trimmed.events).toHaveLength(bundle.events.length);
  });

  it("keeps the events it keeps in their original order", () => {
    const bundle = bundleWith(eventsOfEachSeverity(20));
    const trimmed = trimBundleForUpload(bundle, 6000);
    const seqs = trimmed.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("never mutates the bundle it was given", () => {
    const bundle = bundleWith(eventsOfEachSeverity(20), 4);
    const originalCount = bundle.events.length;
    trimBundleForUpload(bundle, 4000);
    expect(bundle.events).toHaveLength(originalCount);
    expect(bundle.sfuSnapshots).toHaveLength(4);
    expect(bundle.meta.truncated).toBe(false);
  });

  it("gives up gracefully when even an empty event list does not fit", () => {
    const bundle = bundleWith(eventsOfEachSeverity(4));
    const trimmed = trimBundleForUpload(bundle, 1);
    expect(trimmed.events).toEqual([]);
    expect(trimmed.meta.truncated).toBe(true);
  });
});
