import { describe, expect, it, vi } from "vitest";
import { MediasoupVideo } from "./mediasoup";
import type * as mediasoupClient from "mediasoup-client";

// White-box: reach past the public VideoTransport surface to drive the
// private signal handler and stats sweep directly, the same pattern already
// used for LibP2PVoice's redial internals (voice-redial.test.ts). Building a
// real mediasoup-client Device or a live WebSocket is unnecessary for either
// finding under test - both fire on data already inside the class.
function internalsOf(video: MediasoupVideo): Record<string, unknown> {
  return video as never as Record<string, unknown>;
}

// Fake transport: only `close()` and `connectionState` are read by the code
// paths under test.
function fakeTransport(): { close: ReturnType<typeof vi.fn>; connectionState: string } {
  return { close: vi.fn(), connectionState: "connected" };
}

describe("ms:error transport-timeout does not latch a session refusal (finding 1)", () => {
  it("clears only the affected direction's transport, leaves refusal unset", () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const send = fakeTransport();
    const recv = fakeTransport();
    internals.sendTransport = send;
    internals.recvTransport = recv;
    // No producers/consumers to republish - isolates this assertion to the
    // refusal-latch behaviour, covered separately below.
    internals.producers = new Map();
    internals.consumers = new Map();

    (internals.handleSignal as (msg: unknown) => void).call(internals, {
      type: "ms:error",
      reason: "transport-timeout",
      direction: "send",
    });

    // The bug: failSession() used to run for EVERY ms:error, so one
    // transient failure on either transport permanently rejected every
    // future request() on the whole session (both directions).
    expect(internals.refusal).toBeNull();
    expect(send.close).toHaveBeenCalledTimes(1);
    expect(internals.sendTransport).toBeNull();
    // The OTHER direction is untouched - this is the point of finding 1: a
    // recv-side failure must not also kill a healthy send transport.
    expect(recv.close).not.toHaveBeenCalled();
    expect(internals.recvTransport).toBe(recv);
  });

  it("still refuses the session for a real refusal reason (server-full)", () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);

    (internals.handleSignal as (msg: unknown) => void).call(internals, {
      type: "ms:error",
      reason: "server-full",
    });

    // Only transport-timeout gets the per-direction treatment; every other
    // reason is a genuine session refusal and must still latch.
    expect(internals.refusal).toBeInstanceOf(Error);
  });

  it("a request issued after a transport-timeout is not rejected by a stale refusal", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.sendTransport = fakeTransport();
    internals.recvTransport = fakeTransport();
    internals.producers = new Map();
    internals.consumers = new Map();

    (internals.handleSignal as (msg: unknown) => void).call(internals, {
      type: "ms:error",
      reason: "transport-timeout",
      direction: "recv",
    });

    // request() rejects synchronously (before even calling signal()) when
    // this.refusal is set - that is exactly the "sits out its own 10s
    // timeout with nothing left alive to answer it" failure finding 1
    // describes, now provably not reachable from a transport-timeout.
    const sent: unknown[] = [];
    internals.sfuWs = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(m) };
    const pending = (
      internals.request as (msg: unknown, responseType: string) => Promise<unknown>
    ).call(internals, { type: "ms:get-capabilities", requestId: "r1" }, "ms:capabilities");
    // Resolve it immediately via the matching response so the promise does
    // not hang the test - only reachable at all if request() did not
    // reject synchronously on a stale refusal.
    (internals.handleSignal as (msg: unknown) => void).call(internals, {
      type: "ms:capabilities",
      requestId: "r1",
      rtpCapabilities: {},
      roomPeerCount: 0,
    });
    await expect(pending).resolves.toMatchObject({ roomPeerCount: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe("getStats consumer stall detector (finding 5)", () => {
  function fakeConsumerEntry(opts: {
    id: string;
    producerId: string;
    bytesReceived: number;
    kind?: "audio" | "video";
  }): {
    consumer: mediasoupClient.types.Consumer;
    source: "camera" | "screen";
    getStatsCalls: number[];
  } {
    const state = { closed: false, calls: 0 };
    const consumer = {
      get closed() {
        return state.closed;
      },
      id: opts.id,
      producerId: opts.producerId,
      kind: opts.kind ?? "video",
      getStats: vi.fn(async () => {
        state.calls++;
        return new Map([
          [
            "inbound",
            { type: "inbound-rtp", bytesReceived: opts.bytesReceived },
          ],
        ]);
      }),
      close: vi.fn(() => {
        state.closed = true;
      }),
    } as unknown as mediasoupClient.types.Consumer;
    return { consumer, source: "camera", getStatsCalls: [] };
  }

  it("does not close a consumer on the first stalled sample", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const entry = fakeConsumerEntry({
      id: "c1",
      producerId: "p1",
      bytesReceived: 1000,
    });
    internals.consumers = new Map([["peer-a", [entry]]]);
    internals.consumerStats = new Map([["c1", { bytes: 1000, misses: 0 }]]);
    const consumeProducer = vi.fn();
    internals.consumeProducer = consumeProducer;
    const stalled = vi.fn();
    video.on("trackStalled", stalled);

    await (
      internals.checkConsumerStats as (peerId: string, c: unknown) => Promise<void>
    ).call(internals, "peer-a", entry);

    expect(entry.consumer.close).not.toHaveBeenCalled();
    expect(consumeProducer).not.toHaveBeenCalled();
    expect(stalled).not.toHaveBeenCalled();
  });

  it("closes and re-consumes after two consecutive stalled samples, and emits trackStalled once", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const entry = fakeConsumerEntry({
      id: "c1",
      producerId: "p1",
      bytesReceived: 1000,
    });
    internals.consumers = new Map([["peer-a", [entry]]]);
    // Seeded as if the previous sweep already saw one stalled sample at the
    // same byte count - this call is the second in a row.
    internals.consumerStats = new Map([["c1", { bytes: 1000, misses: 1 }]]);
    const consumeProducer = vi.fn(async () => {});
    internals.consumeProducer = consumeProducer;
    const stalled = vi.fn();
    video.on("trackStalled", stalled);

    await (
      internals.checkConsumerStats as (peerId: string, c: unknown) => Promise<void>
    ).call(internals, "peer-a", entry);

    // Every other detector on this path reacts to signalling or transport
    // state and stays healthy through this exact failure - this is the one
    // that notices RTP genuinely stopped while everything else says fine.
    expect(entry.consumer.close).toHaveBeenCalledTimes(1);
    expect(stalled).toHaveBeenCalledWith("peer-a", "camera");
    expect(consumeProducer).toHaveBeenCalledWith("peer-a", "p1", "camera");
    // The stalled entry no longer owns a slot in the peer's consumer list -
    // otherwise it would sit there stale forever, and a later real
    // trackRemoved for it (or a second sweep) would double-count it. The
    // peer had exactly one consumer, so removing it deletes the map entry
    // rather than leaving an empty array behind.
    expect((internals.consumers as Map<string, unknown[]>).has("peer-a")).toBe(false);
  });

  it("resets the miss count and does not close when bytesReceived has advanced", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const entry = fakeConsumerEntry({
      id: "c1",
      producerId: "p1",
      bytesReceived: 2000, // advanced from the seeded 1000
    });
    internals.consumers = new Map([["peer-a", [entry]]]);
    internals.consumerStats = new Map([["c1", { bytes: 1000, misses: 1 }]]);
    internals.consumeProducer = vi.fn();

    await (
      internals.checkConsumerStats as (peerId: string, c: unknown) => Promise<void>
    ).call(internals, "peer-a", entry);

    expect(entry.consumer.close).not.toHaveBeenCalled();
    expect((internals.consumerStats as Map<string, { bytes: number; misses: number }>).get("c1")).toEqual({
      bytes: 2000,
      misses: 0,
    });
  });
});
