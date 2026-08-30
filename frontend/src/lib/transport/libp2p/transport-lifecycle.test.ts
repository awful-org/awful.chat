import { beforeEach, describe, expect, it, vi } from "vitest";

// transport.ts imports @libp2p/webrtc at module scope, which requires the
// native node-datachannel binding this test environment does not build (see
// sync.test.ts's FakeTransport for the same constraint). Nothing here calls
// connect(), so webRTC() itself never runs - only the import needs a stub.
// vitest hoists this above the static import below.
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));

import { LibP2PTransport } from "./transport";

// Every case below drives the transport through its private state directly,
// the same pattern voice-redial.test.ts uses: LibP2PTransport's constructor
// does nothing but installFaultHook(), so a real instance is cheap to build,
// and casting to internals lets a test reach the lifecycle machinery without
// standing up a real libp2p node.

interface FakeStream {
  status: string;
  addEventListener: () => void;
  removeEventListener: () => void;
  abort: () => void;
  send: () => boolean;
  onDrain: () => Promise<void>;
}

function fakeStream(): FakeStream {
  return {
    status: "open",
    addEventListener: () => {},
    removeEventListener: () => {},
    abort: () => {},
    send: () => true,
    onDrain: () => Promise.resolve(),
  };
}

interface FakeConnection {
  remotePeer: { toString: () => string };
  direct: boolean;
  status: string;
  remoteAddr: { toString: () => string };
  close: () => Promise<void>;
}

function fakeConnection(peerId: string, direct: boolean): FakeConnection {
  return {
    remotePeer: { toString: () => peerId },
    direct,
    status: "open",
    remoteAddr: { toString: () => `/p2p-circuit/webrtc/p2p/${peerId}` },
    close: () => Promise.resolve(),
  };
}

function makeTransport() {
  const transport = new LibP2PTransport();
  const internals = transport as never as Record<string, unknown>;
  return { transport, internals };
}

describe("stream proof reaches app state (finding 1)", () => {
  it("emits streamProven the moment a stream confirms, and streamLost when cleanup withdraws it", () => {
    const { transport, internals } = makeTransport();
    const peerId = "peerA";
    const stream = fakeStream();
    (internals.peerStreams as Map<string, FakeStream>).set(peerId, stream);

    const proven: string[] = [];
    const lost: string[] = [];
    transport.on("streamProven", (id: string) => proven.push(id));
    transport.on("streamLost", (id: string) => lost.push(id));

    (internals.confirmOutboundStream as (peerId: string) => void).call(
      internals,
      peerId
    );
    expect(proven).toEqual([peerId]);
    expect(
      (internals.confirmedStreams as WeakSet<FakeStream>).has(stream)
    ).toBe(true);

    (internals.cleanupPeerStream as (peerId: string) => void).call(
      internals,
      peerId
    );
    expect(lost).toEqual([peerId]);
  });

  it("does not announce a loss for a stream that never proved anything", () => {
    const { transport, internals } = makeTransport();
    const peerId = "peerB";
    const stream = fakeStream();
    (internals.peerStreams as Map<string, FakeStream>).set(peerId, stream);

    const lost: string[] = [];
    transport.on("streamLost", (id: string) => lost.push(id));

    // No confirmOutboundStream call: this stream never confirmed.
    (internals.cleanupPeerStream as (peerId: string) => void).call(
      internals,
      peerId
    );
    expect(lost).toEqual([]);
  });
});

describe("a liveness drop always schedules a redial (finding 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("dropPeer schedules redialPeer even though it deletes connectedPeers before closing connections", () => {
    const { internals } = makeTransport();
    const peerId = "peerC";
    internals.node = { getConnections: () => [] };
    (internals.connectedPeers as Set<string>).add(peerId);

    const redialSpy = vi.fn();
    internals.redialPeer = redialSpy;

    (internals.dropPeer as (peerId: string) => void).call(internals, peerId);
    // The bug this guards: dropPeer deletes connectedPeers before this point,
    // so peer:disconnect's own dedup guard (`if (!connectedPeers.has(id))
    // return`) would otherwise swallow the redial it relies on. dropPeer must
    // schedule its own.
    expect((internals.connectedPeers as Set<string>).has(peerId)).toBe(false);
    expect(redialSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(redialSpy).toHaveBeenCalledWith(peerId);
  });

  it("schedules no redial when the disconnect is intentional", () => {
    const { internals } = makeTransport();
    const peerId = "peerD";
    internals.node = { getConnections: () => [] };
    (internals.connectedPeers as Set<string>).add(peerId);
    internals.intentionalDisconnect = true;

    const redialSpy = vi.fn();
    internals.redialPeer = redialSpy;

    (internals.dropPeer as (peerId: string) => void).call(internals, peerId);
    vi.advanceTimersByTime(10_000);
    expect(redialSpy).not.toHaveBeenCalled();
  });
});

describe("reconcile never re-registers a peer whose connections are still closing (finding 3)", () => {
  it("skips re-registration inside the close-timeout window after dropPeer", () => {
    const { transport, internals } = makeTransport();
    const peerId = "peerE";
    const connected: string[] = [];
    transport.on("connect", (id: string) => connected.push(id));

    internals.node = {
      getConnections: () => [fakeConnection(peerId, true)],
      getPeers: () => [{ toString: () => peerId }],
    };
    // Simulate dropPeer having just closed this peer's connection - the
    // window connection.close() can take to actually finish.
    (internals.droppedAt as Map<string, number>).set(peerId, Date.now());

    (internals.reconcileConnections as () => void).call(internals);

    expect((internals.connectedPeers as Set<string>).has(peerId)).toBe(false);
    expect(connected).toEqual([]);
  });

  it("re-registers the same peer once the close-timeout window has passed", () => {
    const { transport, internals } = makeTransport();
    const peerId = "peerF";
    const connected: string[] = [];
    transport.on("connect", (id: string) => connected.push(id));

    internals.node = {
      getConnections: () => [fakeConnection(peerId, true)],
      getPeers: () => [{ toString: () => peerId }],
    };
    (internals.droppedAt as Map<string, number>).set(
      peerId,
      Date.now() - 5000
    );

    (internals.reconcileConnections as () => void).call(internals);

    expect((internals.connectedPeers as Set<string>).has(peerId)).toBe(true);
    expect(connected).toEqual([peerId]);
  });

  it("registers a peer with no prior drop at all (baseline)", () => {
    const { transport, internals } = makeTransport();
    const peerId = "peerG";
    const connected: string[] = [];
    transport.on("connect", (id: string) => connected.push(id));

    internals.node = {
      getConnections: () => [fakeConnection(peerId, true)],
      getPeers: () => [{ toString: () => peerId }],
    };

    (internals.reconcileConnections as () => void).call(internals);

    expect((internals.connectedPeers as Set<string>).has(peerId)).toBe(true);
    expect(connected).toEqual([peerId]);
  });

  it("drops a connectedPeers entry no longer backed by any connection (finding 11)", () => {
    const { internals } = makeTransport();
    const peerId = "peerH";
    internals.node = { getConnections: () => [] };
    (internals.connectedPeers as Set<string>).add(peerId);
    // Avoid the drop's own redial reaching into a fake node with no dial().
    internals.redialPeer = vi.fn();

    (internals.reconcileConnections as () => void).call(internals);

    expect((internals.connectedPeers as Set<string>).has(peerId)).toBe(false);
  });
});
