/**
 * End-to-end proof, on data the real code produced.
 *
 * Every other test in this directory builds its own fixture, so it can only
 * prove the engine agrees with itself. This one reads a capture from a real
 * session - two browser profiles, a real relay, a real SFU - and asserts that
 * the engine names what actually happened, and does NOT name what did not.
 *
 * The must-not-fire assertions are the load-bearing half. A console that
 * invents a relay failure for a healthy relay is worse than no console.
 *
 * See `fixtures/README.md` for how the capture was made and what the one
 * substitution in `relay.log` is.
 */

import { describe, expect, it } from "vitest";
import { mergeSources } from "./merge";
import { foldTopology, primaryObserver, topologyKeyframes } from "./topology";
import { runFindings } from "./findings";
import { parseRelayLog, parseSfuTelemetry } from "./logs";
import { buildPromptPack } from "./prompt";
import type { ClientBundle, SfuSnapshot } from "../schema";

// Loaded through vite's own glob rather than `node:fs`, so the test needs no
// node types and runs exactly as the app's own code would read them.
const JSON_FIXTURES = import.meta.glob("./fixtures/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const LOG_FIXTURES = import.meta.glob("./fixtures/*.log", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const clientA = JSON_FIXTURES["./fixtures/client-a-stapled.json"] as ClientBundle;
const clientB = JSON_FIXTURES["./fixtures/client-b-stapled.json"] as ClientBundle;
const sfuSnapshot = JSON_FIXTURES["./fixtures/sfu-snapshot.json"] as SfuSnapshot;
const relayLogText = LOG_FIXTURES["./fixtures/relay.log"];
const sfuLogText = LOG_FIXTURES["./fixtures/sfu-telemetry.log"];

/** Peer A ran with `blockWebrtcDial` on. */
const PEER_A = "12D3KooWEDgQn3CXpBD8fA6PHunKzgwfBv39zK3BkQWBTBsh4Aqx";
const PEER_B = "12D3KooWNQD8Z3CKkw1CSgCURpqkyYPVLxEn64fpPyaESH4gDmtC";
const RELAY = "12D3KooWMM79wZwhXBK6yfwaFoGumZNRxrZVWdyc3eVzvyuEEgaD";

function workspace() {
  return mergeSources([
    { bundle: clientA, source: "client-a.json" },
    { bundle: clientB, source: "client-b.json" },
  ]);
}

describe("the captured fixtures themselves", () => {
  it("are real three-vantage bundles", () => {
    expect(clientA.schemaVersion).toBe(1);
    expect(clientA.self.peerId).toBe(PEER_A);
    expect(clientB.self.peerId).toBe(PEER_B);
    expect(clientA.events.length).toBeGreaterThan(200);
    expect(clientA.relayView?.relayPeerId).toBe(RELAY);
    expect(clientA.relayView?.events.length).toBeGreaterThan(0);
  });

  it("carry no room code and no DID, as the redaction contract requires", () => {
    for (const bundle of [clientA, clientB]) {
      const json = JSON.stringify(bundle);
      expect(json).not.toContain("did:key:");
      // Every room reference is an ordinal or an HMAC ref.
      for (const room of bundle.rooms) expect(room.ref).toMatch(/^r\d+$/);
      for (const room of bundle.relayView?.rooms ?? []) {
        expect(room.ref).toMatch(/^h:[0-9a-f]{12}$/);
      }
    }
  });

  it("recorded the fault harness in the peer that ran it, and only there", () => {
    expect(clientA.meta.faultsActive).toBe(true);
    expect(clientB.meta.faultsActive).toBe(false);
  });

  it("recorded the throttle suppressing a hot kind", () => {
    // A real message storm during history sync, bounded to 5/s.
    expect(clientA.meta.suppressed["app.msg.in"]).toBeGreaterThan(0);
    expect(clientA.events.some((e) => e.kind === "meta.suppressed")).toBe(true);
  });

  it("recorded the blocked WebRTC dial that the fault injected", () => {
    const failed = clientA.events.filter((e) => e.kind === "peer.dial.fail");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].d?.form).toBe("webrtc");
  });

  it("recorded the four silent TURN branches, which reached no UI before", () => {
    const turn = clientA.events.filter((e) => e.kind.startsWith("ice.turn."));
    expect(turn.length).toBeGreaterThan(0);
    expect(new Set(turn.map((e) => e.d?.branch)).size).toBeGreaterThan(0);
  });
});

describe("mergeSources on a real capture", () => {
  it("groups every vantage into ONE capture", () => {
    const ws = workspace();
    expect(ws.warnings).toEqual([]);
    expect(ws.captures).toHaveLength(1);
    expect(ws.captures[0].vantages.map((v) => `${v.source}:${v.kind}`)).toEqual([
      "client-a.json:client",
      "client-a.json#relay:relay",
      "client-b.json:client",
      "client-b.json#relay:relay",
    ]);
  });

  it("builds one absolute, sorted timeline across all four vantages", () => {
    const [c] = workspace().captures;
    expect(c.timeline.length).toBeGreaterThan(400);
    for (let i = 1; i < c.timeline.length; i++) {
      expect(c.timeline[i].at).toBeGreaterThanOrEqual(c.timeline[i - 1].at);
    }
    expect(new Set(c.timeline.map((e) => e.vantage))).toEqual(
      new Set(["client", "relay"])
    );
  });

  it("names all three peers, and knows which two uploaded a vantage", () => {
    const [c] = workspace().captures;
    expect([...c.peers.keys()].sort()).toEqual([PEER_A, PEER_B, RELAY].sort());
    expect(c.peers.get(PEER_A)?.hasVantage).toBe(true);
    expect(c.peers.get(PEER_B)?.hasVantage).toBe(true);
    expect(c.peers.get(RELAY)?.hasVantage).toBe(true);
  });

  it("warns that no clock sample exists, rather than pretending to be exact", () => {
    // Neither peer measured the other's clock in this capture, so the offsets
    // are zero and every cross-vantage finding is suspect. The engine must SAY
    // so; silently assuming perfect clocks is how a timeline lies.
    const [c] = workspace().captures;
    expect(c.maxSkewResidualMs).toBe(0);
    expect(c.warnings.join(" ")).toContain("No peer.clock samples");
  });
});

describe("runFindings on a real capture", () => {
  const findings = runFindings(workspace().captures[0]);
  const ids = findings.map((f) => f.id);

  it("names the fault harness, so no other finding is trusted blindly", () => {
    // `send()` deliberately returns true for a dropped frame, so every other
    // finding in this capture is suspect and the engine has to say it.
    expect(ids).toContain("fault-injection-active");
  });

  it("names a peer that connected without a proven stream", () => {
    expect(ids).toContain("connected-not-proven");
    const subjects = findings
      .filter((f) => f.id === "connected-not-proven")
      .map((f) => f.subject.peer);
    expect(subjects).toContain(PEER_A);
    expect(subjects).toContain(PEER_B);
  });

  it("names the relay stream that closed for a real reason, not gracefully", () => {
    // THE relay-side value of this whole change: before it, a liveness
    // timeout, an idle timeout and a clean close were one log line.
    expect(ids).toContain("relay-close-unclean");
    const f = findings.find((x) => x.id === "relay-close-unclean");
    expect(f?.subject.vantage).toBe(RELAY);
    expect(f?.detail.reason).toBe("read-error");
    expect(f?.detail.reason).not.toBe("graceful");
  });

  it("reports the capture as incomplete, because the throttle dropped events", () => {
    expect(ids).toContain("capture-incomplete");
  });

  it("does NOT invent a relay failure: the relay was reachable", () => {
    // The relay was dialled and answered three times. A console that reports
    // an unreachable relay here is a console nobody will believe again.
    expect(ids).not.toContain("relay-unreachable");
    expect(ids).not.toContain("relay-reservation-never-completed");
  });

  it("does NOT report rendezvous as wedged: registration worked", () => {
    // A relay vantage records `rv.register` and never records `rv.peers` - the
    // PEERS reply is something it sends, not something it logs. Running the
    // register deadline over a relay vantage fired on every healthy
    // registration until this capture exposed it.
    expect(ids).not.toContain("rendezvous-wedged");
  });

  it("does NOT report an asymmetric link: both peers saw each other", () => {
    expect(ids).not.toContain("asymmetric-link");
  });

  it("does NOT report any SFU or voice failure: neither ran in this capture", () => {
    for (const id of ids) {
      expect(id.startsWith("sfu-")).toBe(false);
      expect(id.startsWith("voice-")).toBe(false);
    }
  });

  it("reports a stalled sync ONCE per observer, not once per digest", () => {
    // A stalled sync re-sends a digest every few seconds. One finding per
    // event buried every other rule under thirty copies of one fact.
    const stalls = findings.filter((f) => f.id === "sync-stalled");
    expect(stalls.length).toBeLessThanOrEqual(2);
    for (const f of stalls) {
      expect(Number(f.detail.unansweredDigests)).toBeGreaterThan(0);
      expect(f.evidence.length).toBe(Number(f.detail.unansweredDigests));
    }
  });

  it("orders blocking findings before warnings", () => {
    const rank = { block: 0, warn: 1, info: 2 };
    const seen = findings.map((f) => rank[f.severity]);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("points every piece of evidence at a real timeline entry", () => {
    const [c] = workspace().captures;
    for (const f of findings) {
      for (const idx of f.evidence) {
        expect(c.timeline[idx]).toBeDefined();
      }
      // A finding read off the bundle ENVELOPE - `meta.faultsActive`,
      // `meta.dropped` - honestly has no event to point at. It must then say
      // what it read instead, or the Findings view has nothing to show.
      if (f.evidence.length === 0) {
        expect(Object.keys(f.detail).length).toBeGreaterThan(0);
      }
    }
  });

  it("cites the throttle's own marker for an incomplete capture", () => {
    // `meta.suppressed` is in the envelope, but the ring also emits a
    // `meta.suppressed` EVENT for exactly this reason: a reader with only the
    // events must still see the gap.
    const [c] = workspace().captures;
    const f = findings.find((x) => x.id === "capture-incomplete");
    expect(f?.evidence.length).toBeGreaterThan(0);
    for (const idx of f?.evidence ?? []) {
      expect(c.timeline[idx].kind).toBe("meta.suppressed");
    }
  });
});


describe("foldTopology on a real capture", () => {
  it("reconstructs the link both peers really had, in both directions", () => {
    const [c] = workspace().captures;
    const top = foldTopology(c, c.window.to);
    expect(top.self).toBe(PEER_A);
    expect(primaryObserver(c)).toBe(PEER_A);

    const forward = top.links.find((l) => l.from === PEER_A && l.to === PEER_B);
    const back = top.links.find((l) => l.from === PEER_B && l.to === PEER_A);
    expect(forward?.state).toBe("proven");
    expect(back?.state).toBe("proven");
    expect(forward?.proven).toBe(true);
  });

  it("reports the relay as connected and reserved, and no SFU at all", () => {
    const [c] = workspace().captures;
    const top = foldTopology(c, c.window.to);
    expect(top.relay).toEqual({ peerId: RELAY, connected: true, reserved: true });
    expect(top.sfu).toBeNull();
  });

  it("reports a proven peer online and the relay itself offline", () => {
    // The relay is a node in the graph but never a proven chat peer, so it
    // must not render as an online participant.
    const [c] = workspace().captures;
    const top = foldTopology(c, c.window.to);
    const peerB = top.nodes.find((n) => n.peerId === PEER_B);
    const relay = top.nodes.find((n) => n.peerId === RELAY);
    expect(peerB).toMatchObject({ online: true, connecting: false });
    expect(relay).toMatchObject({ online: false, connecting: false });
  });

  it("reports nothing connected at the start of the window", () => {
    const [c] = workspace().captures;
    const top = foldTopology(c, c.window.from);
    expect(top.relay?.connected ?? false).toBe(false);
    expect(top.nodes.every((n) => !n.online)).toBe(true);
  });

  it("finds the instants where the graph really changed", () => {
    const [c] = workspace().captures;
    const keys = topologyKeyframes(c);
    expect(keys.length).toBeGreaterThan(4);
    expect(keys.length).toBeLessThan(c.timeline.length);
    expect(keys[0]).toBe(c.window.from);
    expect(keys[keys.length - 1]).toBe(c.window.to);
  });
});

describe("log parsing on real container output", () => {
  it("reads the SFU's structured sweep and agrees with the SFU's own snapshot", () => {
    // The two came from the same SFU, one from stdout and one over ms:diag.
    // If they disagree, one of the two readers is wrong.
    const parsed = parseSfuTelemetry(sfuLogText, "sfu-telemetry.log");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.unmatched).toBe(0);
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);
    expect(parsed.events[0].d?.roomPeers).toBe(sfuSnapshot.roomPeerCount);
    expect(parsed.events[0].d?.producers).toBe(
      sfuSnapshot.self.producers.length
    );
  });

  it("reads the relay's own log, including the new close reason", () => {
    const parsed = parseRelayLog(relayLogText, "relay.log");
    expect(parsed.events.length).toBeGreaterThan(20);
    const kinds = new Set(parsed.events.map((e) => e.kind));
    expect(kinds).toContain("rv.open");
    expect(kinds).toContain("rv.register");
    expect(kinds).toContain("peer.connect");
  });

  it("keeps a line it did not recognise instead of dropping it", () => {
    const parsed = parseRelayLog(relayLogText, "relay.log");
    expect(parsed.unmatched).toBeGreaterThan(0);
    const raw = parsed.events.filter((e) => e.kind === "log.raw");
    expect(raw.length).toBe(parsed.unmatched);
    for (const e of raw) expect(typeof e.d?.raw).toBe("string");
  });

  it("resolves the relay's 8-character suffixes against the real peer ids", () => {
    const parsed = parseRelayLog(relayLogText, "relay.log");
    const suffixes = new Set(
      parsed.events.map((e) => e.d?.peerSuffix).filter(Boolean)
    );
    expect(suffixes).toContain(PEER_A.slice(-8));
    expect(suffixes).toContain(PEER_B.slice(-8));
  });
});

describe("buildPromptPack on a real capture", () => {
  const [c] = workspace().captures;
  const pack = buildPromptPack(c, runFindings(c));

  it("leaks no room code, no DID and no message text", () => {
    // The same gate `frontend/src/lib/telemetry/bundle.test.ts` applies,
    // turned on the dashboard's own output. `relay.log`'s room code
    // placeholder is the one string a log parser could have carried through.
    expect(pack.markdown).not.toContain("did:key:");
    expect(pack.markdown).not.toContain("ROOMCODEFIXTURE");
    expect(pack.markdown).not.toContain("capture fixture message");
  });

  it("is a usable size and reports it", () => {
    expect(pack.markdown.length).toBeGreaterThan(1000);
    expect(pack.tokensEstimate).toBeGreaterThan(0);
    expect(pack.tokensEstimate).toBeLessThan(pack.markdown.length);
  });

  it("states the contract before the data", () => {
    const order = [
      pack.markdown.indexOf("awful.chat"),
      pack.markdown.indexOf("DiagEvent"),
      pack.markdown.indexOf("fault-injection-active"),
    ];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
  });
});
