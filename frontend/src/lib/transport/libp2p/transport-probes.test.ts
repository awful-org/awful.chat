import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
import { LibP2PTransport } from "./transport";

interface Probe {
  settle: (rtt: number | null) => void;
  settleClock?: (remoteWallMs: number | null) => void;
}

function setup() {
  const transport = new LibP2PTransport();
  const internals = transport as unknown as {
    node: unknown;
    connectedPeers: Set<string>;
    rttProbes: Map<number, Probe>;
  };
  internals.node = {};
  internals.connectedPeers.add("peer-a");
  vi.spyOn(transport, "send").mockResolvedValue(true);
  return { transport, internals };
}

describe("measurement promises complete", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  for (const kind of ["rtt", "clock"] as const) {
    const measure = (transport: LibP2PTransport) => kind === "rtt"
      ? transport.measureRtt("peer-a", 2000)
      : transport.measureClock("peer-a", 2000);

    it(`${kind}: publishes the reply to callers and cleans up`, async () => {
      const { transport, internals } = setup();
      const complete = vi.fn();
      void measure(transport).then(complete);
      const probe = [...internals.rttProbes.values()][0];
      if (kind === "rtt") probe.settle(42);
      else probe.settleClock!(Date.now());
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledExactlyOnceWith(kind === "rtt" ? 42 : {
        t0: expect.any(Number), t1: expect.any(Number),
        t2: expect.any(Number), t3: expect.any(Number),
      });
      expect(internals.rttProbes.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it(`${kind}: resolves loss on timeout rather than hanging the caller`, async () => {
      const { transport, internals } = setup();
      const complete = vi.fn();
      void measure(transport).then(complete);
      await vi.advanceTimersByTimeAsync(2000);
      expect(complete).toHaveBeenCalledExactlyOnceWith(null);
      expect(internals.rttProbes.size).toBe(0);
    });

    it(`${kind}: resolves loss when sending rejects`, async () => {
      const { transport, internals } = setup();
      vi.mocked(transport.send).mockRejectedValue(new Error("closed stream"));
      const complete = vi.fn();
      void measure(transport).then(complete);
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledExactlyOnceWith(null);
      expect(internals.rttProbes.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${kind}: resolves immediately for a disconnected peer`, async () => {
      const { transport, internals } = setup();
      internals.connectedPeers.clear();
      expect(await measure(transport)).toBeNull();
      expect(transport.send).not.toHaveBeenCalled();
      expect(internals.rttProbes.size).toBe(0);
    });
  }
});
