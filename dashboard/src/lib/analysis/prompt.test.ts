import { describe, expect, it } from "vitest";
import { buildPromptPack } from "./prompt";
import type { Capture, LoadedVantage, MergedEvent, PeerSummary } from "./merge";
import type { Finding } from "./findings";
import type { DiagKind, DiagSeverity } from "../schema";

const SELF = "12D3KooWSelfPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const OTHER = "12D3KooWOtherPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
/** A real 16-hex room code, exactly the format `roomKind` classifies. */
const ROOM_CODE = "a1b2c3d4e5f60718";
const DID = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";

function mkEvent(overrides: {
  at: number;
  kind: DiagKind;
  sev?: DiagSeverity;
  peer?: string | null;
  d?: Record<string, string | number | boolean | null>;
}): MergedEvent {
  return {
    seq: overrides.at,
    t: overrides.at,
    kind: overrides.kind,
    sev: overrides.sev ?? "info",
    peer: overrides.peer ?? null,
    room: null,
    d: overrides.d,
    at: overrides.at,
    vantage: "client",
    source: "fixture.json",
    observer: SELF,
  };
}

function makeCapture(timeline: MergedEvent[]): Capture {
  const from = timeline[0]?.at ?? 0;
  const to = timeline[timeline.length - 1]?.at ?? 0;
  const vantage: LoadedVantage = {
    source: "fixture.json",
    kind: "client",
    bundleKey: "fixture.json",
    observer: SELF,
    epoch: 0,
    offset: 0,
    events: timeline,
    window: { from, to },
  };
  const otherSummary: PeerSummary = {
    peerId: OTHER,
    identityRefs: [],
    observers: [SELF],
    firstSeen: from,
    lastSeen: to,
    hasVantage: false,
  };
  return {
    id: "fixture",
    window: { from, to },
    vantages: [vantage],
    timeline,
    peers: new Map([[OTHER, otherSummary]]),
    rooms: new Map(),
    maxSkewResidualMs: 0,
    warnings: [],
  };
}

function blockingFinding(evidenceIndex: number): Finding {
  return {
    id: "connected-not-proven",
    severity: "block",
    subject: { peer: OTHER },
    evidence: [evidenceIndex],
    detail: { note: "unproven" },
  };
}

const SECTION_HEADINGS = [
  "## 1. What awful.chat is",
  "## 2. Event schema and kinds present",
  "## 3. Findings",
  "## 4. Topology",
  "## 5. Event window",
  "## 6. Question",
];

describe("buildPromptPack", () => {
  it("never leaks a room code or a did:key, even from a d bag a log parser filled in", () => {
    const timeline = [
      mkEvent({ at: 0, kind: "session.start" }),
      mkEvent({ at: 1000, kind: "rv.register", peer: OTHER, d: { roomRaw: ROOM_CODE } }),
      mkEvent({
        at: 2000,
        kind: "app.profile.reject",
        peer: OTHER,
        sev: "warn",
        d: { reason: DID },
      }),
      mkEvent({ at: 3000, kind: "peer.connect", peer: OTHER }),
      mkEvent({ at: 4000, kind: "peer.upgrade.fail", peer: OTHER, sev: "error" }),
    ];
    const c = makeCapture(timeline);
    const findings = [blockingFinding(4)];

    const { markdown } = buildPromptPack(c, findings);

    expect(markdown).not.toContain(ROOM_CODE);
    expect(markdown.toLowerCase()).not.toContain("did:key:");
    expect(markdown).toContain("[redacted-room]");
    expect(markdown).toContain("[redacted-did]");
  });

  it("renders the six sections in order", () => {
    const timeline = [
      mkEvent({ at: 0, kind: "session.start" }),
      mkEvent({ at: 1000, kind: "peer.connect", peer: OTHER }),
    ];
    const c = makeCapture(timeline);

    const { markdown } = buildPromptPack(c, []);

    let lastIndex = -1;
    for (const heading of SECTION_HEADINGS) {
      const index = markdown.indexOf(heading);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("produces a usable pack for a capture with no findings", () => {
    const timeline = [mkEvent({ at: 0, kind: "session.start" })];
    const c = makeCapture(timeline);

    const { markdown, tokensEstimate } = buildPromptPack(c, []);

    expect(markdown).toContain("No findings fired for this capture.");
    expect(markdown).toContain("(no blocking finding in this capture)");
    for (const heading of SECTION_HEADINGS) expect(markdown).toContain(heading);
    expect(tokensEstimate).toBeGreaterThan(0);
  });

  it("honours maxEvents, taking the last N events when there is no blocking finding", () => {
    const timeline = Array.from({ length: 20 }, (_, i) =>
      mkEvent({ at: i * 1000, kind: "peer.rtt", peer: OTHER, d: { idx: i } }),
    );
    const c = makeCapture(timeline);

    const { markdown } = buildPromptPack(c, [], { maxEvents: 7 });

    const idxs = [...markdown.matchAll(/"idx":(\d+)/g)].map((m) => Number(m[1]));
    expect(idxs).toEqual([13, 14, 15, 16, 17, 18, 19]);
  });

  it("centres the event window on the first blocking finding's evidence", () => {
    const timeline = Array.from({ length: 20 }, (_, i) =>
      mkEvent({ at: i * 1000, kind: "peer.rtt", peer: OTHER, d: { idx: i } }),
    );
    const c = makeCapture(timeline);
    const findings = [blockingFinding(15)];

    const { markdown } = buildPromptPack(c, findings, { maxEvents: 6 });

    const idxs = [...markdown.matchAll(/"idx":(\d+)/g)].map((m) => Number(m[1]));
    // radius = floor(6/2) = 3; start = 15-3 = 12, end = 12+6 = 18 -> indices 12..17,
    // which straddles the anchor at 15 rather than trailing behind it.
    expect(idxs).toEqual([12, 13, 14, 15, 16, 17]);
    expect(idxs).toContain(15);
  });
});
