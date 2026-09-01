import { describe, expect, it } from "vitest";
import type { ClientBundle } from "../schema";
import type { Capture, LoadedVantage, MergedEvent, VantageKind } from "./merge";
import { RULES, type FindingId } from "./rules";
import {
  ASYMMETRIC_WINDOW_MS,
  CONFIRM_FAIL_THRESHOLD,
  DIAL_FAIL_STREAK_THRESHOLD,
  FLAP_WINDOW_MS,
  LIVENESS_FLAP_MIN_COUNT,
  PROOF_DEADLINE_MS,
  REGISTER_PEERS_DEADLINE_MS,
  RESERVATION_COMPLETE_DEADLINE_MS,
  ROOM_VIEW_SPLIT_MS,
  SFU_CONSUMER_STALL_THRESHOLD,
  SFU_REJOIN_LOOP_THRESHOLD,
  PC_LIVE_ALARM,
  PRODUCER_CONSUME_DEADLINE_MS,
  SFU_ROOM_SPLIT_MS,
  SYNC_STALL_MS,
  UPGRADE_FAIL_THRESHOLD,
  VOICE_RESTART_LOOP_THRESHOLD,
  VOICE_SETUP_DEADLINE_MS,
  runFindings,
  type Finding,
} from "./findings";

// ---------------------------------------------------------------------------
// Fixture helpers - built locally, no imported fixture file.
// ---------------------------------------------------------------------------

let seqCounter = 0;

function ev(partial: Partial<MergedEvent> & { kind: MergedEvent["kind"] }): MergedEvent {
  seqCounter += 1;
  const at = partial.at ?? 0;
  return {
    seq: partial.seq ?? seqCounter,
    t: partial.t ?? at,
    kind: partial.kind,
    sev: partial.sev ?? "info",
    peer: partial.peer ?? null,
    room: partial.room ?? null,
    d: partial.d,
    at,
    vantage: partial.vantage ?? "client",
    source: partial.source ?? partial.observer ?? "self",
    observer: partial.observer ?? "self",
  };
}

function makeBundle(observer: string, overrides?: Partial<ClientBundle>): ClientBundle {
  return {
    schemaVersion: 1,
    bundleId: `${observer}-bundle`,
    sessionId: `${observer}-session`,
    createdAt: 0,
    startedAt: 0,
    vantage: "client",
    app: { version: "0", commit: "0" },
    env: { ua: "" },
    config: { apiHost: "h", relayPeerId: "r", sfuHosts: [], configured: true },
    self: { peerId: observer },
    rooms: [],
    peers: [],
    counters: {},
    events: [],
    sfuSnapshots: [],
    meta: { ringCapacity: 4096, dropped: 0, suppressed: {}, faultsActive: false, truncated: false },
    ...overrides,
  };
}

function makeVantage(
  observer: string,
  opts?: { kind?: VantageKind; bundle?: Partial<ClientBundle> }
): LoadedVantage {
  const kind = opts?.kind ?? "client";
  return {
    source: observer,
    kind,
    bundleKey: observer,
    observer,
    epoch: 0,
    offset: 0,
    events: [],
    window: { from: 0, to: 1_000_000 },
    bundle: kind === "client" ? makeBundle(observer, opts?.bundle) : undefined,
  };
}

function makeCapture(
  events: MergedEvent[],
  opts?: { vantages?: LoadedVantage[]; maxSkewResidualMs?: number }
): Capture {
  const timeline = [...events].sort((a, b) => a.at - b.at || a.seq - b.seq);
  return {
    id: "test-capture",
    window: { from: 0, to: 1_000_000 },
    vantages: opts?.vantages ?? [makeVantage("self")],
    timeline,
    peers: new Map(),
    rooms: new Map(),
    maxSkewResidualMs: opts?.maxSkewResidualMs ?? 0,
    warnings: [],
  };
}

function idsOf(findings: Finding[]): FindingId[] {
  return findings.map((f) => f.id);
}

function findOf(findings: Finding[], id: FindingId): Finding | undefined {
  return findings.find((f) => f.id === id);
}

function expectEvidenceValid(capture: Capture, findings: Finding[]): void {
  for (const f of findings) {
    for (const idx of f.evidence) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(capture.timeline.length);
    }
  }
}

// ---------------------------------------------------------------------------
// Coverage / structural tests.
// ---------------------------------------------------------------------------

describe("RULES", () => {
  it("has exactly 34 entries, one per FindingId", () => {
    expect(Object.keys(RULES).length).toBe(34);
  });

  it("every rule has a matching id and non-empty prose", () => {
    for (const key of Object.keys(RULES) as FindingId[]) {
      const rule = RULES[key];
      expect(rule.id).toBe(key);
      expect(rule.meaning.length).toBeGreaterThan(0);
      expect(rule.remedy.length).toBeGreaterThan(0);
      expect(rule.aiHint.length).toBeGreaterThan(0);
      expect(["block", "warn", "info"]).toContain(rule.severity);
    }
  });
});

describe("runFindings", () => {
  it("returns [] for a capture with no events", () => {
    const c = makeCapture([]);
    expect(runFindings(c)).toEqual([]);
  });

  it("sorts findings block, then warn, then info", () => {
    const c = makeCapture([
      ev({ kind: "storage.locked", at: 0 }), // warn
      ev({ kind: "app.msg.reject", at: 1, d: { reason: "no-did" } }), // block
      ev({ kind: "meta.suppressed", at: 2 }), // info
    ]);
    const findings = runFindings(c);
    const ranks: Record<string, number> = { block: 0, warn: 1, info: 2 };
    for (let i = 1; i < findings.length; i++) {
      expect(ranks[findings[i - 1].severity]).toBeLessThanOrEqual(ranks[findings[i].severity]);
    }
    expectEvidenceValid(c, findings);
  });
});

// ---------------------------------------------------------------------------
// 1. relay-reservation-never-completed
// ---------------------------------------------------------------------------

describe("relay-reservation-never-completed", () => {
  it("fires when no reservation.ok follows within the deadline", () => {
    const c = makeCapture([ev({ kind: "relay.reservation.request", at: 0 })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("relay-reservation-never-completed");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when reservation.ok arrives in time", () => {
    const c = makeCapture([
      ev({ kind: "relay.reservation.request", at: 0 }),
      ev({ kind: "relay.reservation.ok", at: RESERVATION_COMPLETE_DEADLINE_MS - 1000 }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("relay-reservation-never-completed");
  });
});

// ---------------------------------------------------------------------------
// 2. relay-unreachable
// ---------------------------------------------------------------------------

describe("relay-unreachable", () => {
  it(`fires after ${DIAL_FAIL_STREAK_THRESHOLD} dial fails in a row`, () => {
    const events = Array.from({ length: DIAL_FAIL_STREAK_THRESHOLD }, (_, i) =>
      ev({ kind: "relay.dial.fail", at: i * 100 })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    const f = findOf(findings, "relay-unreachable");
    expect(f).toBeDefined();
    expect(f?.detail.count).toBe(DIAL_FAIL_STREAK_THRESHOLD);
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the relay dialled and then succeeded", () => {
    const c = makeCapture([
      ev({ kind: "relay.dial.fail", at: 0 }),
      ev({ kind: "relay.dial.fail", at: 100 }),
      ev({ kind: "relay.dial.fail", at: 200 }),
      ev({ kind: "relay.dial.ok", at: 300 }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("relay-unreachable");
  });
});

// ---------------------------------------------------------------------------
// 3. relay-flapping
// ---------------------------------------------------------------------------

describe("relay-flapping", () => {
  it("fires on 3 disconnects inside 5 minutes", () => {
    const c = makeCapture([
      ev({ kind: "relay.disconnect", at: 0 }),
      ev({ kind: "relay.disconnect", at: 60_000 }),
      ev({ kind: "relay.disconnect", at: 120_000 }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("relay-flapping");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when disconnects are spread beyond the window", () => {
    const c = makeCapture([
      ev({ kind: "relay.disconnect", at: 0 }),
      ev({ kind: "relay.disconnect", at: FLAP_WINDOW_MS }),
      ev({ kind: "relay.disconnect", at: 2 * FLAP_WINDOW_MS }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("relay-flapping");
  });
});

// ---------------------------------------------------------------------------
// 4. rendezvous-wedged
// ---------------------------------------------------------------------------

describe("rendezvous-wedged", () => {
  it("fires when rv.register gets no rv.peers in time", () => {
    const c = makeCapture([ev({ kind: "rv.register", at: 0, room: "r1" })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("rendezvous-wedged");
    expectEvidenceValid(c, findings);
  });

  it("fires on a relay-vantage liveness-timeout close", () => {
    const c = makeCapture([
      ev({ kind: "rv.close", at: 0, vantage: "relay", d: { reason: "liveness-timeout" } }),
    ]);
    expect(idsOf(runFindings(c))).toContain("rendezvous-wedged");
  });

  it("does not fire when rv.peers answers in time and no bad close occurs", () => {
    const c = makeCapture([
      ev({ kind: "rv.register", at: 0, room: "r1" }),
      ev({ kind: "rv.peers", at: REGISTER_PEERS_DEADLINE_MS - 500, room: "r1", d: { count: 2 } }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("rendezvous-wedged");
  });
});

// ---------------------------------------------------------------------------
// 5. turn-missing-and-needed
// ---------------------------------------------------------------------------

describe("turn-missing-and-needed", () => {
  it("fires when TURN failed and a relayed peer never proved", () => {
    const c = makeCapture([
      ev({ kind: "ice.turn.fail", at: 0 }),
      ev({ kind: "peer.relayed", at: 100, peer: "p1" }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("turn-missing-and-needed");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the relayed peer eventually proved", () => {
    const c = makeCapture([
      ev({ kind: "ice.turn.fail", at: 0 }),
      ev({ kind: "peer.relayed", at: 100, peer: "p1" }),
      ev({ kind: "stream.proven", at: 200, peer: "p1" }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("turn-missing-and-needed");
  });
});

// ---------------------------------------------------------------------------
// 6. connected-not-proven
// ---------------------------------------------------------------------------

describe("connected-not-proven", () => {
  it("fires when connect has no proof within the deadline", () => {
    const c = makeCapture([ev({ kind: "peer.connect", at: 0, peer: "p1" })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("connected-not-proven");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the stream is proven in time", () => {
    const c = makeCapture([
      ev({ kind: "peer.connect", at: 0, peer: "p1" }),
      ev({ kind: "stream.proven", at: PROOF_DEADLINE_MS - 1000, peer: "p1" }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("connected-not-proven");
  });
});

// ---------------------------------------------------------------------------
// 7. asymmetric-link
// ---------------------------------------------------------------------------

describe("asymmetric-link", () => {
  it("fires when B's own vantage never saw the reciprocal connect", () => {
    const c = makeCapture(
      [ev({ kind: "peer.connect", at: 1000, observer: "a", peer: "b" })],
      { vantages: [makeVantage("a"), makeVantage("b")] }
    );
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("asymmetric-link");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when both sides see the connect within the window", () => {
    const c = makeCapture(
      [
        ev({ kind: "peer.connect", at: 1000, observer: "a", peer: "b" }),
        ev({ kind: "peer.connect", at: 1000 + ASYMMETRIC_WINDOW_MS / 2, observer: "b", peer: "a" }),
      ],
      { vantages: [makeVantage("a"), makeVantage("b")] }
    );
    expect(idsOf(runFindings(c))).not.toContain("asymmetric-link");
  });

  it("never fires with a single client vantage", () => {
    const c = makeCapture(
      [ev({ kind: "peer.connect", at: 1000, observer: "a", peer: "b" })],
      { vantages: [makeVantage("a")] }
    );
    expect(idsOf(runFindings(c))).not.toContain("asymmetric-link");
  });
});

// ---------------------------------------------------------------------------
// 8. upgrade-starved
// ---------------------------------------------------------------------------

describe("upgrade-starved", () => {
  it(`fires after ${UPGRADE_FAIL_THRESHOLD} upgrade fails for one peer`, () => {
    const events = Array.from({ length: UPGRADE_FAIL_THRESHOLD }, (_, i) =>
      ev({ kind: "peer.upgrade.fail", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("upgrade-starved");
    expectEvidenceValid(c, findings);
  });

  it("does not fire with one fewer failure", () => {
    const events = Array.from({ length: UPGRADE_FAIL_THRESHOLD - 1 }, (_, i) =>
      ev({ kind: "peer.upgrade.fail", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    expect(idsOf(runFindings(c))).not.toContain("upgrade-starved");
  });
});

// ---------------------------------------------------------------------------
// 9. liveness-flap
// ---------------------------------------------------------------------------

describe("liveness-flap", () => {
  it(`fires on ${LIVENESS_FLAP_MIN_COUNT} drops in 5 minutes for one peer`, () => {
    const c = makeCapture([
      ev({ kind: "peer.drop.liveness", at: 0, peer: "p1" }),
      ev({ kind: "peer.drop.liveness", at: 60_000, peer: "p1" }),
      ev({ kind: "peer.drop.liveness", at: 120_000, peer: "p1" }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("liveness-flap");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when drops are spread beyond the window", () => {
    const c = makeCapture([
      ev({ kind: "peer.drop.liveness", at: 0, peer: "p1" }),
      ev({ kind: "peer.drop.liveness", at: FLAP_WINDOW_MS, peer: "p1" }),
      ev({ kind: "peer.drop.liveness", at: 2 * FLAP_WINDOW_MS, peer: "p1" }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("liveness-flap");
  });
});

// ---------------------------------------------------------------------------
// 10. stream-confirm-starved
// ---------------------------------------------------------------------------

describe("stream-confirm-starved", () => {
  it(`fires after ${CONFIRM_FAIL_THRESHOLD} confirm fails for one peer`, () => {
    const events = Array.from({ length: CONFIRM_FAIL_THRESHOLD }, (_, i) =>
      ev({ kind: "stream.confirm.fail", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("stream-confirm-starved");
    expectEvidenceValid(c, findings);
  });

  it("does not fire on a single confirm fail", () => {
    const c = makeCapture([ev({ kind: "stream.confirm.fail", at: 0, peer: "p1" })]);
    expect(idsOf(runFindings(c))).not.toContain("stream-confirm-starved");
  });
});

// ---------------------------------------------------------------------------
// 11. room-view-split
// ---------------------------------------------------------------------------

describe("room-view-split", () => {
  it("fires when rv.peers and app.roomusers disagree for over 30s", () => {
    const c = makeCapture([
      ev({ kind: "rv.peers", at: 0, d: { count: 2 } }),
      ev({ kind: "app.roomusers", at: 0, d: { count: 3 } }),
      ev({ kind: "app.roomusers", at: ROOM_VIEW_SPLIT_MS + 10_000, d: { count: 3 } }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("room-view-split");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the counts agree", () => {
    const c = makeCapture([
      ev({ kind: "rv.peers", at: 0, d: { count: 2 } }),
      ev({ kind: "app.roomusers", at: 0, d: { count: 2 } }),
      ev({ kind: "app.roomusers", at: ROOM_VIEW_SPLIT_MS + 10_000, d: { count: 2 } }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("room-view-split");
  });
});

// ---------------------------------------------------------------------------
// 12. message-rejected
// ---------------------------------------------------------------------------

describe("message-rejected", () => {
  it("fires and groups by reason", () => {
    const c = makeCapture([
      ev({ kind: "app.msg.reject", at: 0, peer: "p1", d: { reason: "bad-signature" } }),
    ]);
    const findings = runFindings(c);
    const f = findOf(findings, "message-rejected");
    expect(f).toBeDefined();
    expect(f?.detail.reason).toBe("bad-signature");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when no message was rejected", () => {
    const c = makeCapture([ev({ kind: "app.msg.in", at: 0, peer: "p1" })]);
    expect(idsOf(runFindings(c))).not.toContain("message-rejected");
  });
});

// ---------------------------------------------------------------------------
// 13. sync-stalled
// ---------------------------------------------------------------------------

describe("sync-stalled", () => {
  it("fires when digest.out gets no reply while a peer is proven", () => {
    const c = makeCapture([
      ev({ kind: "stream.proven", at: 0, peer: "p1" }),
      ev({ kind: "app.digest.out", at: 1000 }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sync-stalled");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when digest.in answers in time", () => {
    const c = makeCapture([
      ev({ kind: "stream.proven", at: 0, peer: "p1" }),
      ev({ kind: "app.digest.out", at: 1000 }),
      ev({ kind: "app.digest.in", at: 1000 + SYNC_STALL_MS - 1000 }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("sync-stalled");
  });

  it("does not fire when no peer is proven", () => {
    const c = makeCapture([ev({ kind: "app.digest.out", at: 1000 })]);
    expect(idsOf(runFindings(c))).not.toContain("sync-stalled");
  });
});

// ---------------------------------------------------------------------------
// 14. voice-never-connected
// ---------------------------------------------------------------------------

describe("voice-never-connected", () => {
  it("fires when ICE never connects within the deadline", () => {
    const c = makeCapture([ev({ kind: "voice.pc.new", at: 0, peer: "p1" })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("voice-never-connected");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when ICE connects in time", () => {
    const c = makeCapture([
      ev({ kind: "voice.pc.new", at: 0, peer: "p1" }),
      ev({ kind: "voice.ice.connected", at: VOICE_SETUP_DEADLINE_MS - 1000, peer: "p1" }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("voice-never-connected");
  });
});

// ---------------------------------------------------------------------------
// 15. voice-media-stalled
// ---------------------------------------------------------------------------

describe("voice-media-stalled", () => {
  it("fires when media never resumes", () => {
    const c = makeCapture([ev({ kind: "voice.media.stall", at: 0, peer: "p1" })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("voice-media-stalled");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when media resumes", () => {
    const c = makeCapture([
      ev({ kind: "voice.media.stall", at: 0, peer: "p1" }),
      ev({ kind: "voice.media.resume", at: 500, peer: "p1" }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("voice-media-stalled");
  });
});

// ---------------------------------------------------------------------------
// 16. voice-relayed-only
// ---------------------------------------------------------------------------

describe("voice-relayed-only", () => {
  it("fires when every voice connection was relayed", () => {
    const c = makeCapture([
      ev({ kind: "voice.ice.connected", at: 0, peer: "p1", d: { relayed: true } }),
      ev({ kind: "voice.ice.connected", at: 10, peer: "p2", d: { relayed: true } }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("voice-relayed-only");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when at least one connection was direct", () => {
    const c = makeCapture([
      ev({ kind: "voice.ice.connected", at: 0, peer: "p1", d: { relayed: true } }),
      ev({ kind: "voice.ice.connected", at: 10, peer: "p2", d: { relayed: false } }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("voice-relayed-only");
  });
});

// ---------------------------------------------------------------------------
// 17. voice-restart-loop
// ---------------------------------------------------------------------------

describe("voice-restart-loop", () => {
  it(`fires after ${VOICE_RESTART_LOOP_THRESHOLD} restarts for one peer`, () => {
    const events = Array.from({ length: VOICE_RESTART_LOOP_THRESHOLD }, (_, i) =>
      ev({ kind: "voice.restart", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("voice-restart-loop");
    expectEvidenceValid(c, findings);
  });

  it("does not fire with one fewer restart", () => {
    const events = Array.from({ length: VOICE_RESTART_LOOP_THRESHOLD - 1 }, (_, i) =>
      ev({ kind: "voice.restart", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    expect(idsOf(runFindings(c))).not.toContain("voice-restart-loop");
  });
});

// ---------------------------------------------------------------------------
// 18. sfu-session-latched
// ---------------------------------------------------------------------------

describe("sfu-session-latched", () => {
  it("fires on a latching sfu.error reason", () => {
    const c = makeCapture([ev({ kind: "sfu.error", at: 0, d: { reason: "producer-limit" } })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sfu-session-latched");
    expectEvidenceValid(c, findings);
  });

  it("does not fire on an unrelated sfu.error reason", () => {
    const c = makeCapture([ev({ kind: "sfu.error", at: 0, d: { reason: "transport-error" } })]);
    expect(idsOf(runFindings(c))).not.toContain("sfu-session-latched");
  });
});

// ---------------------------------------------------------------------------
// 19. sfu-transport-timeout
// ---------------------------------------------------------------------------

describe("sfu-transport-timeout", () => {
  it("fires and reports the direction", () => {
    const c = makeCapture([ev({ kind: "sfu.transport.timeout", at: 0, d: { direction: "send" } })]);
    const findings = runFindings(c);
    const f = findOf(findings, "sfu-transport-timeout");
    expect(f).toBeDefined();
    expect(f?.detail.direction).toBe("send");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when there is no timeout", () => {
    const c = makeCapture([ev({ kind: "sfu.transport.state", at: 0, d: { state: "connected" } })]);
    expect(idsOf(runFindings(c))).not.toContain("sfu-transport-timeout");
  });
});

// ---------------------------------------------------------------------------
// 20. sfu-rejoin-loop
// ---------------------------------------------------------------------------

describe("sfu-rejoin-loop", () => {
  it(`fires after ${SFU_REJOIN_LOOP_THRESHOLD} rejoins`, () => {
    const events = Array.from({ length: SFU_REJOIN_LOOP_THRESHOLD }, (_, i) =>
      ev({ kind: "sfu.rejoin", at: i * 10 })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sfu-rejoin-loop");
    expectEvidenceValid(c, findings);
  });

  it("does not fire with one fewer rejoin", () => {
    const events = Array.from({ length: SFU_REJOIN_LOOP_THRESHOLD - 1 }, (_, i) =>
      ev({ kind: "sfu.rejoin", at: i * 10 })
    );
    const c = makeCapture(events);
    expect(idsOf(runFindings(c))).not.toContain("sfu-rejoin-loop");
  });
});

// ---------------------------------------------------------------------------
// 21. sfu-consumer-stalled
// ---------------------------------------------------------------------------

describe("sfu-consumer-stalled", () => {
  it(`fires after ${SFU_CONSUMER_STALL_THRESHOLD} stalls for one producer`, () => {
    const events = Array.from({ length: SFU_CONSUMER_STALL_THRESHOLD }, (_, i) =>
      ev({ kind: "sfu.track.stalled", at: i * 10, peer: "p1" })
    );
    const c = makeCapture(events);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sfu-consumer-stalled");
    expectEvidenceValid(c, findings);
  });

  it("does not fire on a single stall", () => {
    const c = makeCapture([ev({ kind: "sfu.track.stalled", at: 0, peer: "p1" })]);
    expect(idsOf(runFindings(c))).not.toContain("sfu-consumer-stalled");
  });
});

// ---------------------------------------------------------------------------
// 22. sfu-room-split
// ---------------------------------------------------------------------------

describe("sfu-room-split", () => {
  it("fires when the sfu room count disagrees with the voice roster for over 30s", () => {
    const c = makeCapture([
      ev({ kind: "sfu.diag", at: 0, d: { roomPeers: 5 } }),
      ev({ kind: "sfu.diag", at: SFU_ROOM_SPLIT_MS + 10_000, d: { roomPeers: 5 } }),
    ]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sfu-room-split");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the counts agree", () => {
    const c = makeCapture([
      ev({ kind: "voice.join", at: 0, peer: "p1" }),
      ev({ kind: "sfu.diag", at: 100, d: { roomPeers: 2 } }),
      ev({ kind: "sfu.diag", at: SFU_ROOM_SPLIT_MS + 10_000, d: { roomPeers: 2 } }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("sfu-room-split");
  });
});

// ---------------------------------------------------------------------------
// 23. sfu-placement-disagreement
// ---------------------------------------------------------------------------

describe("sfu-placement-disagreement", () => {
  it("fires when two client vantages picked different hosts", () => {
    const c = makeCapture(
      [
        ev({ kind: "sfu.pick", at: 0, observer: "a", d: { host: "h1" } }),
        ev({ kind: "sfu.pick", at: 0, observer: "b", d: { host: "h2" } }),
      ],
      { vantages: [makeVantage("a"), makeVantage("b")] }
    );
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("sfu-placement-disagreement");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when both vantages picked the same host", () => {
    const c = makeCapture(
      [
        ev({ kind: "sfu.pick", at: 0, observer: "a", d: { host: "h1" } }),
        ev({ kind: "sfu.pick", at: 0, observer: "b", d: { host: "h1" } }),
      ],
      { vantages: [makeVantage("a"), makeVantage("b")] }
    );
    expect(idsOf(runFindings(c))).not.toContain("sfu-placement-disagreement");
  });
});

// ---------------------------------------------------------------------------
// 24. clock-skew
// ---------------------------------------------------------------------------

describe("clock-skew", () => {
  it("fires when the residual exceeds the acceptable limit", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })], { maxSkewResidualMs: 3000 });
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("clock-skew");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when the residual is within the limit", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })], { maxSkewResidualMs: 500 });
    expect(idsOf(runFindings(c))).not.toContain("clock-skew");
  });
});

// ---------------------------------------------------------------------------
// 25. fault-injection-active
// ---------------------------------------------------------------------------

describe("fault-injection-active", () => {
  it("fires when a bundle reports an active fault", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })], {
      vantages: [makeVantage("self", { bundle: { meta: { ringCapacity: 4096, dropped: 0, suppressed: {}, faultsActive: true, truncated: false } } })],
    });
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("fault-injection-active");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when no fault was active", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })]);
    expect(idsOf(runFindings(c))).not.toContain("fault-injection-active");
  });
});

// ---------------------------------------------------------------------------
// 26. unconfigured-instance
// ---------------------------------------------------------------------------

describe("unconfigured-instance", () => {
  it("fires when session.config reports configured: false", () => {
    const c = makeCapture([ev({ kind: "session.config", at: 0, d: { configured: false } })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("unconfigured-instance");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when configured is true", () => {
    const c = makeCapture([ev({ kind: "session.config", at: 0, d: { configured: true } })]);
    expect(idsOf(runFindings(c))).not.toContain("unconfigured-instance");
  });
});

// ---------------------------------------------------------------------------
// 27. storage-locked-writes
// ---------------------------------------------------------------------------

describe("storage-locked-writes", () => {
  it("fires on any storage.locked event", () => {
    const c = makeCapture([ev({ kind: "storage.locked", at: 0, d: { what: "dm-queue" } })]);
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("storage-locked-writes");
    expectEvidenceValid(c, findings);
  });

  it("does not fire when storage was never locked", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })]);
    expect(idsOf(runFindings(c))).not.toContain("storage-locked-writes");
  });
});

// ---------------------------------------------------------------------------
// 28. capture-incomplete
// ---------------------------------------------------------------------------

describe("capture-incomplete", () => {
  it("fires when a bundle reports dropped events", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })], {
      vantages: [makeVantage("self", { bundle: { meta: { ringCapacity: 4096, dropped: 5, suppressed: {}, faultsActive: false, truncated: false } } })],
    });
    const findings = runFindings(c);
    expect(idsOf(findings)).toContain("capture-incomplete");
    expectEvidenceValid(c, findings);
  });

  it("fires on a meta.suppressed event even with no dropped count", () => {
    const c = makeCapture([ev({ kind: "meta.suppressed", at: 0 })]);
    expect(idsOf(runFindings(c))).toContain("capture-incomplete");
  });

  it("does not fire on a clean capture", () => {
    const c = makeCapture([ev({ kind: "session.start", at: 0 })]);
    expect(idsOf(runFindings(c))).not.toContain("capture-incomplete");
  });
});

// ---------------------------------------------------------------------------
// 29. relay-close-unclean
// ---------------------------------------------------------------------------

describe("relay-close-unclean", () => {
  it("fires and names the reason when the close was not graceful", () => {
    const c = makeCapture([
      ev({ kind: "rv.close", at: 0, vantage: "relay", d: { reason: "idle-timeout" } }),
    ]);
    const findings = runFindings(c);
    const f = findOf(findings, "relay-close-unclean");
    expect(f).toBeDefined();
    expect(f?.detail.reason).toBe("idle-timeout");
    expectEvidenceValid(c, findings);
  });

  it("does not fire on a graceful close", () => {
    const c = makeCapture([
      ev({ kind: "rv.close", at: 0, vantage: "relay", d: { reason: "graceful" } }),
    ]);
    expect(idsOf(runFindings(c))).not.toContain("relay-close-unclean");
  });
});

describe("peerconnection-leak", () => {
  it("fires once the live gauge crosses the alarm", () => {
    const capture = makeCapture([
      ev({ kind: "runtime.resources", at: 1000, d: { pcLive: 4, pcCreated: 4, pcPeak: 4 } }),
      ev({
        kind: "runtime.resources",
        at: 60_000,
        d: { pcLive: PC_LIVE_ALARM, pcCreated: 300, pcPeak: PC_LIVE_ALARM },
      }),
    ]);
    const findings = runFindings(capture);
    const hit = findOf(findings, "peerconnection-leak");
    expect(hit).toBeDefined();
    // `created` far above `peak` is the rebuild-loop shape, and it is the
    // number that says which of the two this was.
    expect(hit?.detail).toMatchObject({ peakLive: PC_LIVE_ALARM, created: 300 });
    expectEvidenceValid(capture, findings);
  });

  it("stays quiet for a busy call that closes what it opens", () => {
    const capture = makeCapture([
      ev({ kind: "runtime.resources", at: 1000, d: { pcLive: 12, pcCreated: 12, pcPeak: 12 } }),
      ev({ kind: "runtime.resources", at: 9000, d: { pcLive: 8, pcCreated: 20, pcPeak: 12 } }),
    ]);
    // A console that invents a leak is worse than no console: eight peers
    // joining and leaving is not a fault.
    expect(idsOf(runFindings(capture))).not.toContain("peerconnection-leak");
  });
});

describe("uncaught-error", () => {
  it("surfaces a single uncaught exception", () => {
    const capture = makeCapture([
      ev({
        kind: "runtime.error",
        at: 500,
        sev: "error",
        d: { source: "uncaught", err: "UnknownError: Cannot create so many PeerConnections" },
      }),
    ]);
    const findings = runFindings(capture);
    expect(idsOf(findings)).toContain("uncaught-error");
    expectEvidenceValid(capture, findings);
  });

  it("stays quiet when nothing threw", () => {
    const capture = makeCapture([ev({ kind: "peer.connect", at: 10 })]);
    expect(idsOf(runFindings(capture))).not.toContain("uncaught-error");
  });
});

describe("producer-never-consumed", () => {
  const announce = (at: number, producer: string, source = "camera") =>
    ev({
      kind: "sfu.consume",
      at,
      peer: "12D3KooWBBB",
      d: { phase: "announced", producer, source },
    });

  it("fires when a camera producer is announced and nothing consumes it", () => {
    const capture = makeCapture([announce(1000, "prod-1")]);
    const findings = runFindings(capture);
    const hit = findOf(findings, "producer-never-consumed");
    expect(hit).toBeDefined();
    expect(hit?.detail.producer).toBe("prod-1");
    expectEvidenceValid(capture, findings);
  });

  it("stays quiet once a consumer exists for it", () => {
    const capture = makeCapture([
      announce(1000, "prod-1"),
      ev({
        kind: "sfu.consume",
        at: 1500,
        peer: "12D3KooWBBB",
        d: { phase: "ok", producer: "prod-1", source: "camera", kind: "video" },
      }),
    ]);
    expect(idsOf(runFindings(capture))).not.toContain("producer-never-consumed");
  });

  it("stays quiet for a screen share nobody clicked", () => {
    // Screen share is opt-in. An unwatched share is the normal case, and a
    // console that calls it a fault would cry wolf in every single capture.
    const capture = makeCapture([announce(1000, "prod-screen", "screen")]);
    expect(idsOf(runFindings(capture))).not.toContain("producer-never-consumed");
  });

  it("stays quiet when the capture ended before the deadline", () => {
    const at = 1_000_000 - PRODUCER_CONSUME_DEADLINE_MS + 1000;
    const capture = makeCapture([announce(at, "prod-late")]);
    // The consume may have been one second away when the recording stopped.
    expect(idsOf(runFindings(capture))).not.toContain("producer-never-consumed");
  });

  it("treats a deduped consume as satisfied", () => {
    // The in-flight guard shares one consume between two callers: the OTHER
    // caller reports the outcome, so a dedup is not a missing consumer.
    const capture = makeCapture([
      announce(1000, "prod-1"),
      ev({
        kind: "sfu.consume",
        at: 1200,
        peer: "12D3KooWBBB",
        d: { phase: "dedup", producer: "prod-1", source: "camera" },
      }),
    ]);
    expect(idsOf(runFindings(capture))).not.toContain("producer-never-consumed");
  });
});

describe("turn-unreachable", () => {
  it("fires when an allocation probe failed", () => {
    const capture = makeCapture([
      ev({
        kind: "ice.turn.fail",
        at: 2000,
        sev: "error",
        d: { branch: "allocate", outcome: "gathered-none", ms: 5000 },
      }),
    ]);
    const findings = runFindings(capture);
    const hit = findOf(findings, "turn-unreachable");
    expect(hit).toBeDefined();
    expect(hit?.detail).toMatchObject({ attempts: 1, outcome: "gathered-none" });
    expectEvidenceValid(capture, findings);
  });

  it("ignores a credential failure, which is a different fault", () => {
    // No credential is a configuration problem and already has its own rule.
    // Only a refused ALLOCATION is evidence about the network itself.
    const capture = makeCapture([
      ev({ kind: "ice.turn.fail", at: 100, sev: "error", d: { branch: "not-ok", status: 500 } }),
    ]);
    expect(idsOf(runFindings(capture))).not.toContain("turn-unreachable");
  });

  it("stays quiet when the probe passed", () => {
    const capture = makeCapture([
      ev({ kind: "ice.turn.ok", at: 100, d: { branch: "allocate", ms: 120 } }),
    ]);
    expect(idsOf(runFindings(capture))).not.toContain("turn-unreachable");
  });
});

describe("sfu-misplaced", () => {
  it("fires when the client reports a room the server thinks is empty", () => {
    const capture = makeCapture([
      ev({
        kind: "sfu.misplaced",
        at: 4000,
        sev: "error",
        d: { expectedOthers: 1, reportedByServer: 0 },
      }),
    ]);
    const findings = runFindings(capture);
    expect(idsOf(findings)).toContain("sfu-misplaced");
    expectEvidenceValid(capture, findings);
  });

  it("stays quiet on an ordinary session", () => {
    // The client only emits when the disagreement is unambiguous, so the
    // absence of the event is itself the healthy signal.
    const capture = makeCapture([
      ev({ kind: "sfu.caps", at: 100, d: { roomPeerCount: 1 } }),
      ev({ kind: "sfu.join", at: 120 }),
    ]);
    expect(idsOf(runFindings(capture))).not.toContain("sfu-misplaced");
  });
});
