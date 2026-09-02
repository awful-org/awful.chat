import { describe, it, expect, beforeEach } from "vitest";
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
import type { SfuSnapshot } from "./schema";

function snapshotFixture(takenAt: number): SfuSnapshot {
  return {
    schemaVersion: 1,
    takenAt,
    roomPeerCount: 2,
    self: {
      peerId: "p1",
      transports: [],
      producers: [],
      consumers: [],
      cumulativeProduces: 0,
      backpressured: false,
    },
    room: [],
    ceilings: {
      peersPerRoom: 32,
      producersPerPeer: 8,
      consumersPerPeer: 256,
    },
  };
}

describe("recorder", () => {
  beforeEach(() => {
    resetRecorderForTest();
  });

  it("records before initRecorder and before beginSession", () => {
    // Boot, config and relay failures all happen before anything is wired.
    // A recorder that needs setup would miss exactly those.
    rec(ev("session.config"));
    expect(recorderSnapshot().events).toHaveLength(1);
  });

  it("numbers events from 1 again after a new session", () => {
    beginSession("s1", 1000);
    rec(ev("session.start"));
    rec(ev("session.config"));
    expect(recorderSnapshot().events.map((e) => e.seq)).toEqual([1, 2]);

    beginSession("s2", 2000);
    rec(ev("session.start"));
    const snap = recorderSnapshot();
    expect(snap.sessionId).toBe("s2");
    expect(snap.startedAt).toBe(2000);
    expect(snap.events.map((e) => e.seq)).toEqual([1]);
  });

  it("tracks first and last sight of every peer it names", () => {
    beginSession("s", 0);
    rec(ev("peer.connect", { peer: "p1" }));
    rec(ev("peer.connect", { peer: "p2" }));
    rec(ev("peer.disconnect", { peer: "p1" }));
    const peers = recorderSnapshot().peers;
    expect(peers.map((p) => p.peerId)).toEqual(["p1", "p2"]);
    expect(peers[0].lastSeen).toBeGreaterThanOrEqual(peers[0].firstSeen);
    expect(peers[0].identityRef).toBeNull();
  });

  it("does not track a peer for an event with no peer", () => {
    beginSession("s", 0);
    rec(ev("session.config"));
    expect(recorderSnapshot().peers).toEqual([]);
  });

  it("groups two devices of one identity under one ordinal", () => {
    beginSession("s", 0);
    rec(ev("peer.connect", { peer: "pA" }));
    rec(ev("peer.connect", { peer: "pB" }));
    rec(ev("peer.connect", { peer: "pC" }));
    noteIdentity("pA", "did:key:zALICE");
    noteIdentity("pB", "did:key:zALICE");
    noteIdentity("pC", "did:key:zBOB");
    const byId = new Map(recorderSnapshot().peers.map((p) => [p.peerId, p]));
    expect(byId.get("pA")?.identityRef).toBe("i1");
    expect(byId.get("pB")?.identityRef).toBe("i1");
    expect(byId.get("pC")?.identityRef).toBe("i2");
  });

  it("never puts a DID in the snapshot", () => {
    beginSession("s", 0);
    noteIdentity("pA", "did:key:zALICE");
    expect(JSON.stringify(recorderSnapshot())).not.toContain("did:key:zALICE");
  });

  it("notes an identity for a peer it has not seen yet", () => {
    beginSession("s", 0);
    noteIdentity("pNew", "did:key:zX");
    expect(recorderSnapshot().peers[0]).toMatchObject({
      peerId: "pNew",
      identityRef: "i1",
    });
  });

  it("swallows a throwing context rather than breaking a caller", () => {
    initRecorder({
      selfPeerId() {
        throw new Error("no");
      },
      runtime() {
        throw new Error("no");
      },
      faultsActive() {
        throw new Error("no");
      },
    });
    const snap = recorderSnapshot();
    expect(snap.selfPeerId).toBe("");
    expect(snap.faultsActive).toBe(false);
    expect(snap.runtime).toEqual({
      apiHost: "",
      relayPeerId: "",
      sfuHosts: [],
      configured: false,
    });
  });

  it("keeps only the newest SFU snapshots", () => {
    beginSession("s", 0);
    for (let i = 0; i < 12; i++) recordSfuSnapshot(snapshotFixture(i));
    const kept = recorderSnapshot().sfuSnapshots;
    expect(kept).toHaveLength(8);
    expect(kept[0].takenAt).toBe(4);
    expect(kept[7].takenAt).toBe(11);
  });

  it("replaces the absolute counter snapshot", () => {
    beginSession("s", 0);
    recordCounters({ "t.connects": 3 });
    recordCounters({ "t.connects": 5 });
    expect(recorderSnapshot().counters).toEqual({ "t.connects": 5 });
  });

  it("clears the ref table on a new session so ordinals never correlate", () => {
    beginSession("s1", 0);
    refs().roomRef("first-room-code");
    expect(recorderSnapshot().rooms).toHaveLength(1);
    beginSession("s2", 0);
    expect(recorderSnapshot().rooms).toEqual([]);
    expect(refs().roomRef("second-room-code")).toBe("r1");
  });

  it("returns plain objects, not a reactive proxy", () => {
    // A `$state` proxy cannot be structured-cloned into IndexedDB and must not
    // be JSON.stringify'd into a bundle.
    beginSession("s", 0);
    rec(ev("session.start"));
    const snap = recorderSnapshot();
    expect(structuredClone(snap)).toEqual(snap);
  });
});
