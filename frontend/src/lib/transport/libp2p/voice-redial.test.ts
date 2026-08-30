import { beforeEach, describe, expect, it, vi } from "vitest";
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
    createdAt: Date.now() - ageMs,
    everConnected,
    okAt: Date.now() - okAgoMs,
    lastBytesReceived,
    lastBytesReceivedAt: Date.now() - bytesReceivedAgoMs,
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

describe("handleRedialRequest", () => {
  let dialed: string[];
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
      Date.now() + 8_000
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
    const now = Date.now();
    remote.lastBytesReceived = 50_000;
    remote.lastBytesReceivedAt = now - 9_000; // past the 8s stall threshold
    remote.okAt = now - 9_000; // no progress since the stall started
    // Still inside the 20s wedge grace, so not unhealthy YET - but okAt must
    // not have been bumped to "now": that refresh is exactly what hid a
    // stalled sender (finding 1/2) or a dropped renegotiation (finding 4)
    // forever, because connectionState alone kept reading "connected".
    expect(callLinkIsHealthy(internals, remote, now)).toBe(true);
    expect(remote.okAt).toBe(now - 9_000);
  });

  it("tears a connected-but-stalled link down once the wedge grace elapses on top of the stall", () => {
    const { internals } = makeVoice("connected");
    const remote = (internals.remotePeers as Map<string, TestRemote>).get(
      "aaa"
    )!;
    const now = Date.now();
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
    const now = Date.now();
    remote.lastBytesReceived = 12_000;
    remote.lastBytesReceivedAt = now - 500; // increased half a second ago
    remote.okAt = now - 10_000; // stale from before this sample
    expect(callLinkIsHealthy(internals, remote, now)).toBe(true);
    // Refreshed just now: no false positive despite the stale okAt going in.
    expect(remote.okAt).toBe(now);
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
    const now = Date.now();
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
