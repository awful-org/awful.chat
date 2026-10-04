import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibP2PVoice } from "./voice";

// A voice link that settled on TURN looks for a direct path: once, a while
// after it settled (the lower id asks), and whenever the network changes.
// The peer connection is a state holder: what is checked is the one offer
// that carries the ICE restart. restartIce() must not be called: its
// negotiationneeded sends a second offer, and the second answer tore the
// call down.
function setup(selfId: string, peerId = "mmm") {
  const transport = {
    selfId: () => selfId,
    peers: () => [peerId],
    isRelay: () => false,
    send: async () => {},
    on: () => {},
    off: () => {},
  };
  const voice = new LibP2PVoice(transport as never, null);
  const internals = voice as never as Record<string, unknown>;
  internals.node = {} as unknown;
  internals.callPeers = new Set([peerId]);
  const pc = {
    connectionState: "connected",
    signalingState: "stable",
    close: vi.fn(),
    restartIce: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0 restart" })),
    setLocalDescription: vi.fn(async () => {}),
    getStats: async (): Promise<Map<string, unknown>> => new Map(),
  };
  const remote: Record<string, unknown> = {
    peerId,
    pc,
    stream: null,
    audio: { srcObject: null, play: () => Promise.resolve() },
    sourceNode: null,
    gainNode: null,
    pendingCandidates: [],
    createdAt: performance.now(),
    everConnected: true,
    okAt: performance.now(),
    lastBytesReceived: 0,
    lastBytesReceivedAt: performance.now(),
    relayed: false,
  };
  (internals.remotePeers as Map<string, unknown>).set(peerId, remote);
  const sent: unknown[] = [];
  internals.sendSignal = vi.fn(async (_to: string, signal: unknown) => {
    sent.push(signal);
    return true;
  });
  const stats = (relayed: boolean) => new Map<string, unknown>([
    ["pair", { type: "candidate-pair", state: "succeeded", nominated: true,
      localCandidateType: relayed ? "relay" : "host", remoteCandidateType: "host" }],
    ["audio", { type: "inbound-rtp", kind: "audio", bytesReceived: 100 }],
  ]);
  const poll = () => (internals.pollInboundMedia as (r: unknown, n: number) => Promise<void>)
    .call(internals, remote, performance.now());
  return { voice, internals, remote, pc, sent, stats, poll };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("a voice link on TURN looks for a direct path", () => {
  it("once, a while after it settled, asked by the lower id", async () => {
    const { pc, sent, stats, poll } = setup("aaa");
    pc.getStats = async () => stats(true);
    await poll();
    expect(pc.createOffer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    await flush();
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(sent).toEqual([{ type: "offer", sdp: "v=0 restart" }]);
    // Still on TURN on the next probes: the settled look is not repeated.
    await poll();
    await poll();
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
  });

  it("leaves the settled look to the other side when its id is higher", async () => {
    const { pc, stats, poll } = setup("zzz");
    pc.getStats = async () => stats(true);
    await poll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pc.createOffer).not.toHaveBeenCalled();
  });

  it("looks on a network change, whichever side, at most three times", async () => {
    const { internals, remote, pc, stats, poll } = setup("zzz");
    pc.getStats = async () => stats(true);
    await poll();
    vi.useRealTimers();
    const onNetworkChange = internals.onNetworkChange as () => void;
    for (let i = 0; i < 5; i++) {
      onNetworkChange();
      await flush();
    }
    expect(pc.createOffer).toHaveBeenCalledTimes(3);
    expect(remote.healAttempts).toBe(3);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("ignores an answer with no offer of ours outstanding", async () => {
    const { internals, pc } = setup("aaa");
    const setRemoteDescription = vi.fn(async () => {});
    Object.assign(pc, { setRemoteDescription });
    const handleSignal = internals.handleSignal as (p: string, s: unknown) => Promise<void>;
    await expect(
      handleSignal.call(internals, "mmm", { type: "answer", sdp: "v=0 stale" })
    ).resolves.toBeUndefined();
    expect(setRemoteDescription).not.toHaveBeenCalled();
  });

  it("does nothing for a direct link, or one not connected and stable", async () => {
    const { internals, pc, stats, poll } = setup("aaa");
    pc.getStats = async () => stats(false);
    await poll();
    await vi.advanceTimersByTimeAsync(60_000);
    const onNetworkChange = internals.onNetworkChange as () => void;
    onNetworkChange();
    expect(pc.createOffer).not.toHaveBeenCalled();

    pc.getStats = async () => stats(true);
    await poll();
    pc.signalingState = "have-local-offer";
    onNetworkChange();
    expect(pc.createOffer).not.toHaveBeenCalled();
  });

  it("drops the pending look when the link is torn down", async () => {
    const { internals, pc, stats, poll } = setup("aaa");
    pc.getStats = async () => stats(true);
    await poll();
    (internals.teardownRemotePeer as (id: string) => void).call(internals, "mmm");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pc.createOffer).not.toHaveBeenCalled();
  });
});
