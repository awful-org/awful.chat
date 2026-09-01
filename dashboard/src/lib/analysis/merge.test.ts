import { describe, it, expect } from "vitest";
import {
  MAX_ACCEPTABLE_SKEW_MS,
  mergeSources,
  peerIdsOf,
  skewSamples,
  solveSkew,
  vantagesOf,
  type LoadedVantage,
} from "./merge";
import type { ClientBundle, DiagEvent, RelayVantage } from "../schema";

let seq = 0;

function event(
  kind: DiagEvent["kind"],
  t: number,
  extra: Partial<DiagEvent> = {}
): DiagEvent {
  return {
    seq: ++seq,
    t,
    kind,
    sev: "info",
    peer: null,
    room: null,
    ...extra,
  };
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
    createdAt: startedAt + 60_000,
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
    rooms: [{ ref: "h:abc", size: 2, members: [observedPeerId] }],
    streams: [],
    events,
  };
}

describe("vantagesOf", () => {
  it("splits a stapled relay view into a second vantage", () => {
    const bundle = bundleOf("pA", 1000, [event("session.start", 0)], {
      relayView: relayView("pA", [event("rv.open", 1500)]),
    });
    const vantages = vantagesOf(bundle, "a.json");
    expect(vantages.map((v) => v.kind)).toEqual(["client", "relay"]);
    expect(vantages[1].source).toBe("a.json#relay");
    expect(vantages[1].observer).toBe("12D3KooWRELAY");
  });

  it("gives a client vantage an epoch and a relay vantage none", () => {
    // A relay event's `t` is already unix ms: the relay has no session start.
    const bundle = bundleOf("pA", 5000, [event("session.start", 0)], {
      relayView: relayView("pA", [event("rv.open", 7000)]),
    });
    const [client, relay] = vantagesOf(bundle, "a.json");
    expect(client.epoch).toBe(5000);
    expect(relay.epoch).toBe(0);
  });
});

describe("peerIdsOf", () => {
  it("names the observer, every peer ref, every event peer and every relay member", () => {
    const bundle = bundleOf("pA", 1000, [event("peer.connect", 5, { peer: "pB" })], {
      peers: [
        { peerId: "pC", identityRef: null, firstSeen: 0, lastSeen: 1 },
      ],
      relayView: relayView("pA", []),
    });
    const [client, relay] = vantagesOf(bundle, "a.json");
    expect([...peerIdsOf(client)].sort()).toEqual(["pA", "pB", "pC"]);
    expect([...peerIdsOf(relay)]).toContain("pA");
  });
});

describe("skewSamples", () => {
  it("computes the NTP offset from the four timestamps", () => {
    // A remote clock 1000 ms ahead, with a 20 ms symmetric path.
    const bundle = bundleOf("pA", 0, [
      event("peer.clock", 100, {
        peer: "pB",
        d: { t0: 1000, t1: 2010, t2: 2010, t3: 1020 },
      }),
    ]);
    const [client] = vantagesOf(bundle, "a.json");
    expect(skewSamples(client)).toEqual([
      { from: "a.json", peer: "pB", offsetMs: 1000 },
    ]);
  });

  it("ignores a clock event with a missing timestamp", () => {
    const bundle = bundleOf("pA", 0, [
      event("peer.clock", 100, { peer: "pB", d: { t0: 1, t1: 2 } }),
    ]);
    expect(skewSamples(vantagesOf(bundle, "a.json")[0])).toEqual([]);
  });

  it("ignores a clock event with no peer", () => {
    const bundle = bundleOf("pA", 0, [
      event("peer.clock", 100, { d: { t0: 1, t1: 2, t2: 3, t3: 4 } }),
    ]);
    expect(skewSamples(vantagesOf(bundle, "a.json")[0])).toEqual([]);
  });
});

describe("solveSkew", () => {
  function clockEvent(peer: string, offset: number, t: number): DiagEvent {
    return event("peer.clock", t, {
      peer,
      d: { t0: 1000, t1: 1000 + offset, t2: 1000 + offset, t3: 1000 },
    });
  }

  it("anchors on the vantage with the most samples and solves the rest", () => {
    const a = bundleOf("pA", 0, [
      clockEvent("pB", 1000, 10),
      clockEvent("pB", 1000, 20),
    ]);
    const b = bundleOf("pB", 0, [clockEvent("pA", -1000, 15)]);
    const vantages = [
      ...vantagesOf(a, "a.json"),
      ...vantagesOf(b, "b.json"),
    ];
    const solved = solveSkew(vantages);
    expect(solved.offsets.get("a.json")).toBe(0);
    expect(solved.offsets.get("b.json")).toBeCloseTo(1000, 0);
    expect(solved.maxResidualMs).toBeLessThan(1);
  });

  it("reports a residual when two vantages disagree", () => {
    // A and B measure each other and their answers do not agree, which is what
    // an asymmetric path does. The residual is what makes every cross-vantage
    // finding suspect.
    const a = bundleOf("pA", 0, [clockEvent("pB", 5000, 10)]);
    const b = bundleOf("pB", 0, [clockEvent("pA", 5000, 15)]);
    const solved = solveSkew([
      ...vantagesOf(a, "a.json"),
      ...vantagesOf(b, "b.json"),
    ]);
    expect(solved.maxResidualMs).toBeGreaterThan(MAX_ACCEPTABLE_SKEW_MS);
  });

  it("warns when two client vantages carry no clock sample at all", () => {
    const a = bundleOf("pA", 0, [event("peer.connect", 1, { peer: "pB" })]);
    const b = bundleOf("pB", 0, [event("peer.connect", 1, { peer: "pA" })]);
    const solved = solveSkew([
      ...vantagesOf(a, "a.json"),
      ...vantagesOf(b, "b.json"),
    ]);
    expect(solved.warnings).toHaveLength(1);
    expect(solved.warnings[0]).toContain("No peer.clock samples");
    expect(solved.offsets.get("b.json")).toBe(0);
  });

  it("does not warn for a single client vantage, which needs no correction", () => {
    const a = bundleOf("pA", 0, [event("peer.connect", 1, { peer: "pB" })]);
    expect(solveSkew(vantagesOf(a, "a.json")).warnings).toEqual([]);
  });

  it("leaves a relay vantage at zero, since it is its own reference", () => {
    const a = bundleOf("pA", 0, [clockEvent("pB", 1000, 10)], {
      relayView: relayView("pA", [event("rv.open", 7000)]),
    });
    const b = bundleOf("pB", 0, [clockEvent("pA", -1000, 15)]);
    const solved = solveSkew([
      ...vantagesOf(a, "a.json"),
      ...vantagesOf(b, "b.json"),
    ]);
    expect(solved.offsets.get("a.json#relay")).toBe(0);
  });

  it("ignores a sample about a peer that uploaded nothing", () => {
    const a = bundleOf("pA", 0, [clockEvent("pGhost", 9000, 10)]);
    const solved = solveSkew(vantagesOf(a, "a.json"));
    expect(solved.maxResidualMs).toBe(0);
    expect(solved.offsets.get("a.json")).toBe(0);
  });
});

describe("mergeSources", () => {
  it("groups vantages that overlap and share a peer into one capture", () => {
    const a = bundleOf("pA", 1000, [event("peer.connect", 100, { peer: "pB" })]);
    const b = bundleOf("pB", 1200, [event("peer.connect", 100, { peer: "pA" })]);
    const ws = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]);
    expect(ws.captures).toHaveLength(1);
    expect(ws.captures[0].vantages).toHaveLength(2);
  });

  it("keeps two unrelated sessions apart", () => {
    const a = bundleOf("pA", 1000, [event("peer.connect", 10, { peer: "pB" })]);
    const far = bundleOf("pZ", 900_000_000, [
      event("peer.connect", 10, { peer: "pY" }),
    ]);
    const ws = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: far, source: "z.json" },
    ]);
    expect(ws.captures).toHaveLength(2);
  });

  it("keeps overlapping vantages apart when they share no peer", () => {
    // Two unrelated incidents at the same moment are not one incident.
    const a = bundleOf("pA", 1000, [event("peer.connect", 10, { peer: "pB" })]);
    const c = bundleOf("pC", 1000, [event("peer.connect", 10, { peer: "pD" })]);
    const ws = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: c, source: "c.json" },
    ]);
    expect(ws.captures).toHaveLength(2);
  });

  it("refuses a bundle from an unknown schema version, loudly", () => {
    const a = bundleOf("pA", 1000, []);
    const ws = mergeSources([
      {
        bundle: { ...a, schemaVersion: 99 } as unknown as ClientBundle,
        source: "future.json",
      },
    ]);
    expect(ws.captures).toEqual([]);
    expect(ws.warnings[0]).toContain("future.json");
  });

  it("makes every timeline entry absolute and sorted", () => {
    const a = bundleOf("pA", 10_000, [
      event("session.start", 0),
      event("peer.connect", 500, { peer: "pB" }),
    ]);
    const [capture] = mergeSources([{ bundle: a, source: "a.json" }]).captures;
    expect(capture.timeline.map((e) => e.at)).toEqual([10_000, 10_500]);
    expect(capture.timeline[0].vantage).toBe("client");
    expect(capture.timeline[0].observer).toBe("pA");
    expect(capture.timeline[0].source).toBe("a.json");
  });

  it("interleaves a relay vantage by absolute time", () => {
    const a = bundleOf(
      "pA",
      10_000,
      [event("session.start", 0), event("peer.connect", 500, { peer: "pB" })],
      { relayView: relayView("pA", [event("rv.open", 10_200)]) }
    );
    const [capture] = mergeSources([{ bundle: a, source: "a.json" }]).captures;
    expect(capture.timeline.map((e) => e.kind)).toEqual([
      "session.start",
      "rv.open",
      "peer.connect",
    ]);
  });

  it("summarises peers, and marks the ones that uploaded a vantage", () => {
    const a = bundleOf("pA", 1000, [event("peer.connect", 10, { peer: "pB" })]);
    const b = bundleOf("pB", 1000, [event("peer.connect", 10, { peer: "pA" })]);
    const [capture] = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]).captures;
    expect(capture.peers.get("pA")?.hasVantage).toBe(true);
    expect(capture.peers.get("pB")?.hasVantage).toBe(true);
    expect(capture.peers.get("pA")?.observers.sort()).toEqual(["pA", "pB"]);
  });

  it("scopes a room ref to its bundle, since r1 in two bundles is two rooms", () => {
    // A room code is the room's only membership secret, so there is no way to
    // join two bundles' refs, and pretending otherwise would invent a room.
    const a = bundleOf("pA", 1000, [
      event("app.join", 10, { peer: "pB", room: "r1" }),
    ]);
    const b = bundleOf("pB", 1000, [
      event("app.join", 10, { peer: "pA", room: "r1" }),
    ]);
    const [capture] = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]).captures;
    expect([...capture.rooms.keys()].sort()).toEqual(["a.json:r1", "b.json:r1"]);
  });

  it("shares a relay room ref, which is an HMAC under one boot secret", () => {
    const a = bundleOf("pA", 1000, [event("session.start", 0)], {
      relayView: relayView("pA", [event("rv.register", 1100, { room: "h:abc" })]),
    });
    const b = bundleOf("pB", 1000, [event("session.start", 0)], {
      relayView: relayView("pB", [event("rv.register", 1100, { room: "h:abc" })]),
    });
    const [capture] = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]).captures;
    expect([...capture.rooms.keys()]).toContain("relay:h:abc");
  });

  it("puts a log source in its own vantage so a mis-parse is attributable", () => {
    const a = bundleOf("pA", 1000, [event("peer.connect", 10, { peer: "pB" })]);
    const ws = mergeSources(
      [{ bundle: a, source: "a.json" }],
      [
        {
          ...event("rv.open", 0),
          at: 1200,
          vantage: "log",
          source: "relay.log",
          observer: "pA",
        },
      ]
    );
    expect(ws.captures).toHaveLength(1);
    const kinds = ws.captures[0].vantages.map((v) => v.kind);
    expect(kinds).toContain("log");
    expect(ws.captures[0].timeline.map((e) => e.at)).toEqual([1010, 1200]);
  });

  it("orders captures newest first", () => {
    const older = bundleOf("pA", 1000, [event("peer.connect", 1, { peer: "pB" })]);
    const newer = bundleOf("pZ", 900_000_000, [
      event("peer.connect", 1, { peer: "pY" }),
    ]);
    const ws = mergeSources([
      { bundle: older, source: "a.json" },
      { bundle: newer, source: "z.json" },
    ]);
    expect(ws.captures[0].window.from).toBeGreaterThan(
      ws.captures[1].window.from
    );
  });

  it("carries the skew warning into the capture", () => {
    const a = bundleOf("pA", 0, [event("peer.connect", 1, { peer: "pB" })]);
    const b = bundleOf("pB", 0, [event("peer.connect", 1, { peer: "pA" })]);
    const [capture] = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]).captures;
    expect(capture.warnings.join(" ")).toContain("No peer.clock samples");
  });

  it("returns an empty workspace for no input", () => {
    expect(mergeSources([])).toEqual({ captures: [], warnings: [] });
  });

  it("applies the solved offset to a vantage's own times", () => {
    const a = bundleOf("pA", 0, [
      event("peer.clock", 10, {
        peer: "pB",
        d: { t0: 1000, t1: 2000, t2: 2000, t3: 1000 },
      }),
    ]);
    const b = bundleOf("pB", 0, [
      event("peer.connect", 10, { peer: "pA" }),
      event("peer.clock", 20, {
        peer: "pA",
        d: { t0: 1000, t1: 0, t2: 0, t3: 1000 },
      }),
    ]);
    const [capture] = mergeSources([
      { bundle: a, source: "a.json" },
      { bundle: b, source: "b.json" },
    ]).captures;
    const bVantage = capture.vantages.find(
      (v: LoadedVantage) => v.source === "b.json"
    );
    expect(bVantage?.offset).toBeCloseTo(1000, 0);
    const bEvent = capture.timeline.find((e) => e.source === "b.json");
    expect(bEvent?.at).toBeCloseTo(1010, 0);
  });
});
