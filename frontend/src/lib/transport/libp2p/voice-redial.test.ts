import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibP2PVoice } from "./voice";

// handleRedialRequest touches only the link bookkeeping, so the peer
// connection can be a state holder and the audio graph never comes up.
function fakeRemote(
  state: string,
  ageMs = 0,
  everConnected = false,
  okAgoMs = 0,
  lastBytesReceived: number | null = 0,
  bytesReceivedAgoMs = 0
) {
  return {
    peerId: "aaa",
    pc: { connectionState: state, close: vi.fn(), getStats: () => Promise.resolve(new Map()) },
    stream: null,
    audio: { srcObject: null, play: () => Promise.resolve() },
    sourceNode: null,
    gainNode: null,
    pendingCandidates: [],
    createdAt: performance.now() - ageMs,
    everConnected,
    okAt: performance.now() - okAgoMs,
    lastBytesReceived,
    lastBytesReceivedAt: performance.now() - bytesReceivedAgoMs,
  };
}

function makeVoice(
  remoteState: string | null,
  ageMs = 0,
  everConnected = false,
  okAgoMs = 0
) {
  const transport = {
    selfId: () => "zzz", // higher than "aaa": we are the pair's dialer
    peers: () => ["aaa"],
    isRelay: () => false,
    send: async () => {},
    on: () => {},
    off: () => {},
  };
  const voice = new LibP2PVoice(transport as never, null);
  const internals = voice as never as Record<string, unknown>;
  internals.node = {} as unknown;
  internals.callPeers = new Set(["aaa"]);
  if (remoteState) {
    (internals.remotePeers as Map<string, unknown>).set(
      "aaa",
      fakeRemote(remoteState, ageMs, everConnected, okAgoMs)
    );
  }
  return { voice, internals };
}

describe("live voice status from stats", () => {
  function setup() {
    const { voice, internals } = makeVoice("connected");
    const remote = (internals.remotePeers as Map<string, ReturnType<typeof fakeRemote> & {
      relayed?: boolean; reportedRelayed?: boolean; recoveryPending?: boolean;
      stallSignaled?: boolean;
    }>).get("aaa")!;
    const statuses: unknown[] = [];
    voice.on("status", (status) => statuses.push(status));
    const poll = () => (internals.pollInboundMedia as (r: unknown, n: number) => Promise<void>)
      .call(internals, remote, performance.now());
    const stats = (relayed: boolean, bytes = 100) => new Map([
      ["pair", { type: "candidate-pair", state: "succeeded", nominated: true,
        localCandidateType: relayed ? "relay" : "host", remoteCandidateType: "host" }],
      ["audio", { type: "inbound-rtp", kind: "audio", bytesReceived: bytes }],
    ]);
    return { voice, internals, remote, statuses, poll, stats };
  }

  it("exposes measured diagnostics without refreshing their age when stats fail", async () => {
    const { voice, remote, poll, stats } = setup();
    expect(voice.getPeerDiagnostics("aaa")).toBeNull();
    remote.pc.getStats = async () => stats(true, 100);
    await poll();
    const first = voice.getPeerDiagnostics("aaa")!;
    expect(first).toMatchObject({ route: "relay", connectionState: "connected", rttMs: null });
    expect(first.lastAudioAt).toBe(first.sampledAt);

    // A successful sample with unchanged bytes does not fake audio progress.
    await poll();
    expect(voice.getPeerDiagnostics("aaa")!.lastAudioAt).toBe(first.lastAudioAt);
    const sampledAt = voice.getPeerDiagnostics("aaa")!.sampledAt;
    remote.pc.connectionState = "disconnected";
    remote.pc.getStats = async () => { throw new Error("stats unavailable"); };
    await poll();
    expect(voice.getPeerDiagnostics("aaa")).toMatchObject({ sampledAt, connectionState: "disconnected" });
    expect(voice.getPeerDiagnostics("unknown")).toBeNull();
  });

  it("reports TURN-to-direct changes without a connection-state event, once per change", async () => {
    const { remote, statuses, poll, stats } = setup();
    remote.pc.getStats = async () => stats(true);
    await poll();
    remote.pc.getStats = async () => stats(false, 200);
    await poll();
    await poll();
    expect(statuses).toEqual([
      expect.objectContaining({ type: "voice-ice-connected", relayed: true }),
      expect.objectContaining({ type: "voice-ice-connected", relayed: false }),
    ]);
  });

  it("retries missing initial stats and clears a recovered disconnect on the same route", async () => {
    const { remote, statuses, poll, stats } = setup();
    await poll();
    expect(statuses).toHaveLength(0);
    remote.pc.getStats = async () => stats(true);
    await poll();
    remote.recoveryPending = true;
    await poll();
    expect(statuses).toHaveLength(2);
    expect(remote.recoveryPending).toBe(false);
  });

  it("does not clear degraded media just because the ICE route changed", async () => {
    const { remote, statuses, poll, stats } = setup();
    remote.stallSignaled = true;
    remote.lastBytesReceived = 100;
    remote.lastBytesReceivedAt = performance.now() - 20_000;
    remote.pc.getStats = async () => stats(false);
    await poll();
    expect(statuses).toHaveLength(0);
  });

  it("ignores a pending stats result after the peer is replaced", async () => {
    const { internals, remote, statuses, poll, stats } = setup();
    let resolve!: (value: Map<string, unknown>) => void;
    remote.pc.getStats = () => new Promise((r) => { resolve = r; });
    const pending = poll();
    (internals.remotePeers as Map<string, unknown>).set("aaa", fakeRemote("connected"));
    resolve(stats(false));
    await pending;
    expect(statuses).toHaveLength(0);
  });
});

describe("handleRedialRequest", () => {
  let dialed: string[];
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    dialed = [];
  });

  const spyDial = (internals: Record<string, unknown>) => {
    internals.dialAndOffer = async (peerId: string) => {
      dialed.push(peerId);
    };
  };

  it("rebuilds even when our own connection still reads connected", () => {
    // The far side tore its link down; ours will sit at "connected" until ICE
    // consent expires. Their word beats our stale state.
    const { voice, internals } = makeVoice("connected");
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
    expect((internals.remotePeers as Map<string, unknown>).has("aaa")).toBe(
      false
    );
  });

  it("rebuilds a handshake that has been stuck longer than any real one takes", () => {
    // Every rebuild used to look "mid-handshake" again, so the third
    // caller's asks were refused forever and only a manual rejoin healed it.
    const { voice, internals } = makeVoice("connecting", 15_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("leaves a link that is still mid-handshake alone", () => {
    const { voice, internals } = makeVoice("connecting");
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual([]);
    expect((internals.remotePeers as Map<string, unknown>).has("aaa")).toBe(
      true
    );
  });

  it("does not spend the rate-limit slot on a refused ask", () => {
    const { voice, internals } = makeVoice("connecting");
    spyDial(internals);
    voice.handleRedialRequest("aaa"); // refused, mid-handshake
    // The link dies; the next ask must land rather than wait out the limit.
    (
      (internals.remotePeers as Map<string, { pc: { connectionState: string } }>)
        .get("aaa")!
    ).pc.connectionState = "failed";
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("serves at most one rebuild per interval", () => {
    const { voice, internals } = makeVoice(null);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it.each([-3_600_000, 3_600_000])("keeps retry limits working across a %i ms clock correction", (jump) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { voice, internals } = makeVoice(null);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]); // first retry allowed even at time zero
    wall.mockReturnValue(1_800_000_000_000 + jump);
    clock.mockReturnValue(1_000);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
    clock.mockReturnValue(60_000);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa", "aaa"]);
  });

  it("does not expire a fresh handshake when the system clock jumps forward", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { voice, internals } = makeVoice("connecting");
    spyDial(internals);
    wall.mockReturnValue(1_800_003_600_000);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual([]);
  });

  it("refuses an ask during a fresh blip on an established link", () => {
    // "disconnected" seconds after being connected may recover by itself
    // (ICE restart); the ask must not flap a link mid-recovery.
    const { voice, internals } = makeVoice("disconnected", 60_000, true, 1_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual([]);
  });

  it("serves once an established link has sat blipped with no progress", () => {
    // Past the blip grace with okAt untouched there is no recovery in
    // flight. Waiting out the full 20s wedge grace here was most of the
    // "voice takes forever to come back".
    const { voice, internals } = makeVoice("disconnected", 60_000, true, 6_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("clears the dial backoff when it serves an ask", () => {
    const { voice, internals } = makeVoice("connected");
    spyDial(internals);
    (internals.nextDialAt as Map<string, number>).set(
      "aaa",
      performance.now() + 8_000
    );
    (internals.dialBackoff as Map<string, number>).set("aaa", 8_000);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
    expect((internals.nextDialAt as Map<string, number>).has("aaa")).toBe(false);
    expect((internals.dialBackoff as Map<string, number>).has("aaa")).toBe(
      false
    );
  });
});

describe("reconcileLinks asks for a blipped link, not only a missing one", () => {
  function makePassiveVoice(everConnected: boolean, okAgoMs: number) {
    const sent: string[] = [];
    const transport = {
      selfId: () => "aaa", // LOWER than "zzz": we are the passive side
      peers: () => ["zzz"],
      isRelay: () => false,
      send: async (peerId: string) => {
        sent.push(peerId);
        return true;
      },
      on: () => {},
      off: () => {},
    };
    const voice = new LibP2PVoice(transport as never, null);
    const internals = voice as never as Record<string, unknown>;
    internals.node = {} as unknown;
    internals.callPeers = new Set(["zzz"]);
    internals.rosterSeen = true;
    const remote = { ...fakeRemote("disconnected", 60_000, everConnected, okAgoMs), peerId: "zzz" };
    (internals.remotePeers as Map<string, unknown>).set("zzz", remote);
    // Keep the reconcile from tearing the link down before the ask branch
    // runs: linkIsHealthy passes while okAt is inside the 20s wedge grace.
    return { voice, internals, sent };
  }

  it("asks while the blipped link still exists, once the blip grace passes", () => {
    const { internals, sent } = makePassiveVoice(true, 6_000);
    (internals.reconcileLinks as () => void).call(internals);
    expect(sent).toEqual(["zzz"]);
  });

  it("stays quiet during a fresh blip", () => {
    const { internals, sent } = makePassiveVoice(true, 1_000);
    (internals.reconcileLinks as () => void).call(internals);
    expect(sent).toEqual([]);
  });
});

describe("linkIsHealthy: inbound-media watchdog (finding 3)", () => {
  interface TestRemote {
    okAt: number;
    lastBytesReceived: number | null;
    lastBytesReceivedAt: number;
  }

  function callLinkIsHealthy(internals: Record<string, unknown>, remote: TestRemote, now: number) {
    return (
      internals.linkIsHealthy as (r: TestRemote, n: number) => boolean
    ).call(internals, remote, now);
  }

  it("does not refresh okAt for a connected link whose bytesReceived has stalled past the threshold", () => {
    const { internals } = makeVoice("connected");
    const remote = (internals.remotePeers as Map<string, TestRemote>).get(
      "aaa"
    )!;
    const now = performance.now();
    remote.lastBytesReceived = 50_000;
    remote.lastBytesReceivedAt = now - 6_000; // inside the 8s stall window
    remote.okAt = now - 6_000;
    // Bytes still counted as flowing: healthy, and okAt refreshes.
    expect(callLinkIsHealthy(internals, remote, now)).toBe(true);

    // Past the stall threshold, okAt must NOT refresh - that refresh is
    // exactly what hid a stalled sender forever - and an ESTABLISHED link
    // gets only the short grace now (8s, not the 20s setup grace), so at
    // 9s of no progress it is already unhealthy and torn down for redial.
    remote.lastBytesReceivedAt = now - 9_000;
    remote.okAt = now - 9_000;
    expect(callLinkIsHealthy(internals, remote, now)).toBe(false);
    expect(remote.okAt).toBe(now - 9_000);
  });

  it("tears a connected-but-stalled link down once the wedge grace elapses on top of the stall", () => {
    const { internals } = makeVoice("connected");
    const remote = (internals.remotePeers as Map<string, TestRemote>).get(
      "aaa"
    )!;
    const now = performance.now();
    remote.lastBytesReceived = 50_000;
    remote.lastBytesReceivedAt = now - 25_000;
    remote.okAt = now - 25_000;
    expect(callLinkIsHealthy(internals, remote, now)).toBe(false);
  });

  it("a muted peer does not trip the watchdog - enabled=false still transmits silence frames, so bytesReceived keeps climbing", () => {
    const { internals } = makeVoice("connected");
    const remote = (internals.remotePeers as Map<string, TestRemote>).get(
      "aaa"
    )!;
    const now = performance.now();
    remote.lastBytesReceived = 12_000;
    remote.lastBytesReceivedAt = now - 500; // increased half a second ago
    remote.okAt = now - 10_000; // stale from before this sample
    expect(callLinkIsHealthy(internals, remote, now)).toBe(true);
    // Refreshed just now: no false positive despite the stale okAt going in.
    expect(remote.okAt).toBe(now);
  });

  it("a stall that recovers WITHOUT a rebuild emits voice-ice-connected, so the degraded tile ring clears", () => {
    const { voice, internals } = makeVoice("connected");
    const remote = (
      internals.remotePeers as Map<
        string,
        TestRemote & { stallSignaled: boolean; relayed: boolean }
      >
    ).get("aaa")!;
    const statuses: Array<{ type: string; peerId?: string; relayed?: boolean }> =
      [];
    voice.on("status", (s) => statuses.push(s as (typeof statuses)[number]));
    const now = performance.now();
    // A stall was already announced (tile is amber), the pair went via TURN.
    remote.stallSignaled = true;
    remote.relayed = true;
    remote.lastBytesReceived = 50_000;
    remote.lastBytesReceivedAt = now - 500; // bytes flowing again
    expect(callLinkIsHealthy(internals, remote, now)).toBe(true);
    expect(remote.stallSignaled).toBe(false);
    expect(statuses.filter((s) => s.type === "voice-ice-connected")).toEqual([
      expect.objectContaining({ peerId: "aaa", relayed: true }),
    ]);
    // The next healthy tick must NOT emit again - once per episode.
    expect(callLinkIsHealthy(internals, remote, now + 1_000)).toBe(true);
    expect(
      statuses.filter((s) => s.type === "voice-ice-connected")
    ).toHaveLength(1);
  });

  it("reconcileLinks tears down a stalled connected link end to end, on the side that notices it", () => {
    const sent: string[] = [];
    const transport = {
      selfId: () => "aaa", // lower id: passive side, never dials
      peers: () => ["zzz"],
      isRelay: () => false,
      send: async (peerId: string) => {
        sent.push(peerId);
        return true;
      },
      on: () => {},
      off: () => {},
    };
    const voice = new LibP2PVoice(transport as never, null);
    const internals = voice as never as Record<string, unknown>;
    internals.node = {} as unknown;
    internals.callPeers = new Set(["zzz"]);
    internals.rosterSeen = true;
    const now = performance.now();
    const remote = {
      ...fakeRemote("connected", 60_000, true, 25_000, 50_000, 25_000),
      peerId: "zzz",
    };
    (internals.remotePeers as Map<string, TestRemote>).set("zzz", remote);
    (internals.reconcileLinks as () => void).call(internals);
    // Torn down (finding 3's watchdog owning the existing tdUnhealthy path),
    // and the passive side's only further action is to ask - never a second
    // repair path.
    expect(
      (internals.remotePeers as Map<string, TestRemote>).has("zzz")
    ).toBe(false);
  });
});
