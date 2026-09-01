import { describe, it, expect } from "vitest";
import { mergeSources, type Capture } from "./merge";
import {
  PEER_PROOF_GRACE_MS,
  foldTopology,
  primaryObserver,
  topologyKeyframes,
  vantageKinds,
} from "./topology";
import type { ClientBundle, DiagEvent, RelayVantage } from "../schema";

let seq = 0;

function event(
  kind: DiagEvent["kind"],
  t: number,
  extra: Partial<DiagEvent> = {}
): DiagEvent {
  return { seq: ++seq, t, kind, sev: "info", peer: null, room: null, ...extra };
}

function bundleOf(
  peerId: string,
  startedAt: number,
  events: DiagEvent[],
  overrides: Partial<ClientBundle> = {}
): ClientBundle {
  return {
    schemaVersion: 1,
    bundleId: `bundle-${peerId}`,
    sessionId: `sess-${peerId}`,
    createdAt: startedAt + 120_000,
    startedAt,
    vantage: "client",
    app: { version: "1.0.0", commit: "abc" },
    env: { ua: "test" },
    config: {
      apiHost: "relay.example.org",
      relayPeerId: "12D3KooWRELAY",
      sfuHosts: ["sfu.example.org"],
      configured: true,
    },
    self: { peerId },
    rooms: [],
    peers: [],
    counters: {},
    events,
    sfuSnapshots: [],
    meta: {
      ringCapacity: 4096,
      dropped: 0,
      suppressed: {},
      faultsActive: false,
      truncated: false,
    },
    ...overrides,
  };
}

function relayView(observedPeerId: string, events: DiagEvent[]): RelayVantage {
  return {
    vantage: "relay",
    relayPeerId: "12D3KooWRELAY",
    observedPeerId,
    registry: { totalRegistrations: 1, streamsForPeer: 1, atTotalCap: false },
    rooms: [],
    streams: [],
    events,
  };
}

function captureOf(...bundles: Array<[string, ClientBundle]>): Capture {
  const ws = mergeSources(
    bundles.map(([source, bundle]) => ({ bundle, source }))
  );
  expect(ws.captures).toHaveLength(1);
  return ws.captures[0];
}

const T0 = 100_000;

describe("primaryObserver", () => {
  it("picks the client vantage with the most events", () => {
    const a = bundleOf("pA", T0, [
      event("session.start", 0),
      event("peer.connect", 10, { peer: "pB" }),
      event("stream.proven", 20, { peer: "pB" }),
    ]);
    const b = bundleOf("pB", T0, [event("peer.connect", 10, { peer: "pA" })]);
    expect(primaryObserver(captureOf(["a.json", a], ["b.json", b]))).toBe("pA");
  });
});

describe("foldTopology", () => {
  it("reports the relay as connected and reserved", () => {
    const a = bundleOf("pA", T0, [
      event("relay.dial.ok", 10),
      event("relay.reservation.ok", 20),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(top.relay).toEqual({
      peerId: "12D3KooWRELAY",
      connected: true,
      reserved: true,
    });
  });

  it("clears the reservation when the relay goes away", () => {
    const a = bundleOf("pA", T0, [
      event("relay.dial.ok", 10),
      event("relay.reservation.ok", 20),
      event("relay.disconnect", 30),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(top.relay).toMatchObject({ connected: false, reserved: false });
  });

  it("ignores events after the folded instant", () => {
    const a = bundleOf("pA", T0, [
      event("relay.dial.ok", 10),
      event("relay.disconnect", 5000),
    ]);
    const capture = captureOf(["a.json", a]);
    expect(foldTopology(capture, T0 + 100).relay?.connected).toBe(true);
    expect(foldTopology(capture, T0 + 6000).relay?.connected).toBe(false);
  });

  it("keeps a link directed, so one side's view cannot imply the other's", () => {
    // THE point of three vantages: A saw B, B never saw A.
    const a = bundleOf("pA", T0, [
      event("peer.connect", 10, { peer: "pB" }),
      event("stream.proven", 20, { peer: "pB" }),
    ]);
    const b = bundleOf("pB", T0, [event("session.start", 0)]);
    const top = foldTopology(captureOf(["a.json", a], ["b.json", b]), T0 + 100);
    const forward = top.links.find((l) => l.from === "pA" && l.to === "pB");
    const back = top.links.find((l) => l.from === "pB" && l.to === "pA");
    expect(forward?.state).toBe("proven");
    expect(back).toBeUndefined();
  });

  it("promotes a connected link to proven and demotes it on loss", () => {
    const a = bundleOf("pA", T0, [
      event("peer.connect", 10, { peer: "pB" }),
      event("stream.proven", 20, { peer: "pB" }),
      event("stream.lost", 30, { peer: "pB" }),
    ]);
    const capture = captureOf(["a.json", a]);
    expect(link(foldTopology(capture, T0 + 15), "pA", "pB")?.state).toBe(
      "relayed"
    );
    expect(link(foldTopology(capture, T0 + 25), "pA", "pB")?.state).toBe(
      "proven"
    );
    expect(link(foldTopology(capture, T0 + 35), "pA", "pB")?.state).toBe("lost");
  });

  it("keeps a proven link proven when it upgrades to direct", () => {
    const a = bundleOf("pA", T0, [
      event("peer.connect", 10, { peer: "pB" }),
      event("stream.proven", 20, { peer: "pB" }),
      event("peer.direct", 30, { peer: "pB" }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")?.state).toBe("proven");
  });

  it("names a liveness drop distinctly from an ordinary disconnect", () => {
    const a = bundleOf("pA", T0, [
      event("peer.connect", 10, { peer: "pB" }),
      event("peer.drop.liveness", 20, { peer: "pB" }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")?.state).toBe("dropped");
  });

  it("reports a connected but unproven peer as online inside the grace window", () => {
    // Reproducing `peer-online-status.ts`: reporting online from peer.connect
    // alone is the bug that module exists to fix, and reporting "connecting"
    // during the ordinary handshake is the flicker it also fixes.
    const a = bundleOf("pA", T0, [event("peer.connect", 0, { peer: "pB" })]);
    const capture = captureOf(["a.json", a]);
    const early = foldTopology(capture, T0 + PEER_PROOF_GRACE_MS - 1);
    expect(node(early, "pB")).toMatchObject({ online: true, connecting: false });
  });

  it("downgrades to connecting once the grace window elapses with no proof", () => {
    const a = bundleOf("pA", T0, [event("peer.connect", 0, { peer: "pB" })]);
    const late = foldTopology(
      captureOf(["a.json", a]),
      T0 + PEER_PROOF_GRACE_MS + 1
    );
    expect(node(late, "pB")).toMatchObject({ online: false, connecting: true });
  });

  it("reports a proven peer as online however long it has been up", () => {
    const a = bundleOf("pA", T0, [
      event("peer.connect", 0, { peer: "pB" }),
      event("stream.proven", 10, { peer: "pB" }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 600_000);
    expect(node(top, "pB")).toMatchObject({ online: true, connecting: false });
  });

  it("reports a peer nobody connected to as offline, not connecting", () => {
    const a = bundleOf("pA", T0, [
      event("peer.dial.fail", 10, { peer: "pB" }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(node(top, "pB")).toMatchObject({ online: false, connecting: false });
    expect(link(top, "pA", "pB")?.state).toBe("dial-failed");
  });

  it("tracks the voice link separately from the data link", () => {
    const a = bundleOf("pA", T0, [
      event("peer.connect", 10, { peer: "pB" }),
      event("voice.pc.new", 20, { peer: "pB" }),
      event("voice.ice.connected", 30, { peer: "pB", d: { relayed: true } }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")).toMatchObject({
      state: "relayed",
      voice: "relayed",
    });
  });

  it("distinguishes a direct voice path from a TURN-relayed one", () => {
    const a = bundleOf("pA", T0, [
      event("voice.ice.connected", 30, { peer: "pB", d: { relayed: false } }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")?.voice).toBe("connected");
  });

  it("marks a stalled voice link in both the voice and media dimensions", () => {
    const a = bundleOf("pA", T0, [
      event("voice.ice.connected", 10, { peer: "pB", d: { relayed: false } }),
      event("voice.media.stall", 20, { peer: "pB", d: { silentMs: 4000 } }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")).toMatchObject({
      voice: "stalled",
      media: "stalled",
    });
  });

  it("tracks the SFU host, its socket and its room count", () => {
    const a = bundleOf("pA", T0, [
      event("sfu.pick", 10, { d: { host: "sfu.example.org", poolSize: 2 } }),
      event("sfu.ws.open", 20),
      event("sfu.diag", 30, { d: { roomPeers: 3 } }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(top.sfu).toEqual({
      host: "sfu.example.org",
      connected: true,
      roomPeerCount: 3,
    });
  });

  it("forgets the SFU room count when the socket closes", () => {
    const a = bundleOf("pA", T0, [
      event("sfu.ws.open", 10),
      event("sfu.diag", 20, { d: { roomPeers: 3 } }),
      event("sfu.ws.close", 30, { d: { code: 1006 } }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(top.sfu).toMatchObject({ connected: false, roomPeerCount: null });
  });

  it("attributes a room ref to its own source", () => {
    const a = bundleOf("pA", T0, [
      event("app.join", 10, { peer: "pB", room: "r1" }),
    ]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(node(top, "pB")?.rooms).toEqual(["a.json:r1"]);
  });

  it("keeps a relay vantage's own link view separate from the client's", () => {
    const a = bundleOf("pA", T0, [event("peer.connect", 10, { peer: "pB" })], {
      relayView: relayView("pA", [
        event("peer.disconnect", T0 + 20, { peer: "pA" }),
      ]),
    });
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(link(top, "pA", "pB")?.state).toBe("relayed");
    expect(link(top, "12D3KooWRELAY", "pA")?.state).toBe("lost");
  });

  it("excludes the primary observer from the node list", () => {
    const a = bundleOf("pA", T0, [event("peer.connect", 10, { peer: "pB" })]);
    const top = foldTopology(captureOf(["a.json", a]), T0 + 100);
    expect(top.self).toBe("pA");
    expect(top.nodes.map((n) => n.peerId)).toEqual(["pB", "12D3KooWRELAY"].filter(
      (id) => top.nodes.some((n) => n.peerId === id)
    ));
    expect(top.nodes.some((n) => n.peerId === "pA")).toBe(false);
  });
});

describe("topologyKeyframes", () => {
  it("returns only the times where the graph changed", () => {
    const a = bundleOf("pA", T0, [
      event("session.start", 0), // no topology
      event("relay.dial.ok", 10), // change
      event("relay.dial.ok", 20), // no change: already connected
      event("peer.connect", 30, { peer: "pB" }), // change
      event("peer.rtt", 40, { peer: "pB", d: { ms: 30 } }), // no topology
    ]);
    const capture = captureOf(["a.json", a]);
    expect(topologyKeyframes(capture)).toEqual([
      capture.window.from,
      T0 + 10,
      T0 + 30,
      capture.window.to,
    ]);
  });

  it("always brackets the capture window", () => {
    const a = bundleOf("pA", T0, [event("session.start", 0)]);
    const capture = captureOf(["a.json", a]);
    expect(topologyKeyframes(capture)).toEqual([
      capture.window.from,
      capture.window.to,
    ]);
  });
});

describe("vantageKinds", () => {
  it("lists each kind once", () => {
    const a = bundleOf("pA", T0, [event("session.start", 0)], {
      relayView: relayView("pA", [event("rv.open", T0 + 10)]),
    });
    const b = bundleOf("pB", T0, [event("peer.connect", 10, { peer: "pA" })]);
    expect(vantageKinds(captureOf(["a.json", a], ["b.json", b])).sort()).toEqual([
      "client",
      "relay",
    ]);
  });
});

function link(
  top: ReturnType<typeof foldTopology>,
  from: string,
  to: string
): ReturnType<typeof foldTopology>["links"][number] | undefined {
  return top.links.find((l) => l.from === from && l.to === to);
}

function node(
  top: ReturnType<typeof foldTopology>,
  peerId: string
): ReturnType<typeof foldTopology>["nodes"][number] | undefined {
  return top.nodes.find((n) => n.peerId === peerId);
}
