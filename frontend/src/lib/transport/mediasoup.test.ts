import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAMERA_PARK_GRACE_MS, MediasoupVideo, PRODUCER_GONE } from "./mediasoup";
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

describe("a rejoin does not demote a watched transmission (movie-night drop)", () => {
  it.each([false, true])("publishes restored watch state unless stopped during consume (stop=%s)", async (stop) => {
    const video = new MediasoupVideo();
    const internal = internalsOf(video);
    internal.device = { recvRtpCapabilities: {} };
    (internal.watchingTransmissionPeers as Set<string>).add("sharer");
    internal.ensureRecvTransport = async () => {};
    internal.request = async () => ({ type: "ms:consumer-options", options: {} });
    internal.signal = vi.fn();
    const consumer = { id: "c1", kind: "video", producerId: "new", track: {}, close: vi.fn(), on: vi.fn() };
    internal.recvTransport = { consume: async () => {
      if (stop) video.stopWatchingTransmission("sharer");
      return consumer;
    } };
    const restored = vi.fn();
    const added = vi.fn();
    video.on("transmissionRestored", restored);
    video.on("trackAdded", added);
    await (internal.consumeProducerInner as (peer: string, producer: string, source: string) => Promise<void>)("sharer", "new", "screen");
    if (stop) {
      expect(consumer.close).toHaveBeenCalled();
      expect(restored).not.toHaveBeenCalled();
      expect(added).not.toHaveBeenCalled();
    } else {
      expect(restored).toHaveBeenCalledWith("sharer", "new");
      expect(added).toHaveBeenCalled();
    }
  });

  it.each([true, false])("publisher replacement=%s preserves watch intent only for recovery", (replacing) => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.device = {};
    const watching = internals.watchingTransmissionPeers as Set<string>;
    watching.add("sharer");
    const entries = ["video", "audio"].map((kind) => ({
      source: "screen", consumer: { producerId: kind, kind, close: vi.fn() },
    }));
    internals.consumers = new Map([["sharer", entries]]);
    internals.pendingScreenProducerIds = new Map([["sharer", new Set(["video", "audio"])]]);
    const ended = vi.fn();
    video.on("transmissionEnded", ended);
    const signal = internals.handleSignal as (msg: unknown) => void;
    for (const kind of ["video", "audio"]) signal.call(video, {
      type: "ms:producer-closed", peerId: "sharer", producerId: kind,
      source: "screen", kind, replacing,
    });
    expect(watching.has("sharer")).toBe(replacing);
    expect(ended).toHaveBeenCalledTimes(replacing ? 0 : 1);
    const retry = vi.fn(async () => {});
    internals.consumeProducerWithRetry = retry;
    signal.call(video, {
      type: "ms:new-producer", peerId: "sharer", producerId: "replacement", source: "screen",
    });
    expect(retry).toHaveBeenCalledTimes(replacing ? 1 : 0);
  });

  it("an ended audio track leaves video playing, and stale callbacks cannot end its replacement", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const callbacks = new Map<string, () => void>();
    internals.device = { recvRtpCapabilities: {} };
    internals.ensureRecvTransport = async () => {};
    internals.request = async () => ({ type: "ms:consumer-options", options: {} });
    internals.signal = () => {};
    let kind = "video";
    internals.recvTransport = { consume: async () => {
      const trackKind = kind;
      return { id: trackKind, producerId: trackKind, kind: trackKind, track: {}, close: vi.fn(),
        on: (_event: string, cb: () => void) => callbacks.set(trackKind, cb) };
    } };
    const consume = internals.consumeProducer as (p: string, id: string, source: string) => Promise<void>;
    await consume.call(video, "sharer", "video", "screen");
    kind = "audio";
    await consume.call(video, "sharer", "audio", "screen");
    const ended = vi.fn();
    const removed = vi.fn();
    video.on("transmissionEnded", ended);
    video.on("trackRemoved", removed);
    callbacks.get("audio")!();
    expect(ended).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith("sharer", "screen", "audio");
    removed.mockClear();
    internals.consumers = new Map([["sharer", [{ source: "screen", consumer: { kind: "video" } }]]]);
    callbacks.get("video")!();
    expect(ended).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it("preserves watchingTransmissionPeers through attemptRejoin's state wipe", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.currentRoomCode = "room";
    internals.currentPeerId = "me";
    (internals.watchingTransmissionPeers as Set<string>).add("sharer");
    (internals.pendingTransmissions as Map<string, string>).set("other", "p9");
    internals.sessionIsLive = () => false;
    const removed = vi.fn();
    const left = vi.fn();
    video.on("trackRemoved", removed);
    video.on("peerLeft", left);
    internals.consumers = new Map([["sharer", [{ source: "screen", consumer: { close: vi.fn(), kind: "video" } }]]]);
    const join = vi.fn(async () => {});
    internals.join = join;

    await (internals.attemptRejoin as (g: number) => Promise<void>)(
      internals.joinGeneration as number
    );

    expect(join).toHaveBeenCalledWith("room", "me");
    expect(left).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith("sharer", "screen", "video");
    // Session state is rebuilt from scratch…
    expect((internals.pendingTransmissions as Map<string, string>).size).toBe(0);
    // …but the user's watch INTENT survives, so the join replay's
    // ms:new-producer auto-consumes instead of showing "click to watch".
    expect(
      (internals.watchingTransmissionPeers as Set<string>).has("sharer")
    ).toBe(true);
  });

  it("auto-consumes (with retry) a replayed screen producer from a watched peer", () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.device = {}; // joined
    (internals.watchingTransmissionPeers as Set<string>).add("sharer");
    const retry = vi.fn(async () => {});
    internals.consumeProducerWithRetry = retry;

    (internals.handleSignal as (msg: unknown) => void)({
      type: "ms:new-producer",
      peerId: "sharer",
      producerId: "prod-1",
      source: "screen",
    });

    expect(retry).toHaveBeenCalledWith("sharer", "prod-1", "screen");
    // No pending tile for a transmission the viewer already chose to watch.
    expect(
      (internals.pendingTransmissions as Map<string, string>).has("sharer")
    ).toBe(false);
  });
});

describe("a share that ended while we were away cannot leave a dead tile", () => {
  it("attemptRejoin retracts every pending tile from the UI, not just its own map", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.currentRoomCode = "room";
    internals.currentPeerId = "me";
    (internals.pendingTransmissions as Map<string, string>).set("sharer", "p1");
    internals.sessionIsLive = () => false;
    internals.join = vi.fn(async () => {});
    const ended: string[] = [];
    video.on("transmissionEnded", (peerId) => ended.push(peerId));

    await (internals.attemptRejoin as (g: number) => Promise<void>)(
      internals.joinGeneration as number
    );

    // The bug: the internal map was cleared silently, so transportState kept
    // offering "click to watch" for a share whose producer-closed we missed
    // while disconnected - and every click timed out on a dead producer.
    // The join replay's ms:new-producer puts back any tile still live.
    expect(ended).toEqual(["sharer"]);
  });

  it("ms:consume-failed rejects just that consume with PRODUCER_GONE", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.device = { recvRtpCapabilities: {} };
    internals.recvTransport = fakeTransport();
    internals.ensureRecvTransport = async () => {};
    // An open socket: request() fails at once on one that cannot carry it.
    internals.sfuWs = { readyState: WebSocket.OPEN, send: () => {} };

    const consuming = (
      internals.consumeProducer as (
        p: string,
        id: string,
        s: string
      ) => Promise<void>
    ).call(video, "sharer", "p1", "screen");
    // Let consumeProducer reach request() and register its pending entry.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const pending = internals.pendingById as Map<string, unknown>;
    expect(pending.size).toBe(1);
    const [requestId] = pending.keys();

    (internals.handleSignal as (msg: unknown) => void).call(video, {
      type: "ms:consume-failed",
      requestId,
      producerId: "p1",
    });

    // Scoped failure: the one request rejects fast (no 10s timeout), and no
    // session refusal latches the way an ms:error would.
    await expect(consuming).rejects.toThrow(PRODUCER_GONE);
    expect(internals.refusal).toBeNull();
  });

  it("a watch click on a gone producer retracts the tile and gives back the intent", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    internals.consumeProducer = vi.fn(async () => {
      throw new Error(PRODUCER_GONE);
    });
    const ended: string[] = [];
    video.on("transmissionEnded", (peerId) => ended.push(peerId));

    await expect(video.watchTransmission("sharer", "p1")).rejects.toThrow(
      PRODUCER_GONE
    );

    expect(ended).toEqual(["sharer"]);
    // The click added watch intent on the promise of a consumer; a failed
    // watch must not leave it behind to auto-consume a future share.
    expect(
      (internals.watchingTransmissionPeers as Set<string>).has("sharer")
    ).toBe(false);
  });
});

describe("overlapping consumes for one producer", () => {
  it("shares the in-flight consume instead of asking the SFU twice", async () => {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);

    let answer: (msg: unknown) => void = () => {};
    const request = vi.fn(
      () => new Promise((resolve) => (answer = resolve))
    );
    const consume = vi.fn(async () => ({
      id: "c1",
      producerId: "p1",
      kind: "video",
      track: {},
      closed: false,
      on: vi.fn(),
    }));
    internals.device = { recvRtpCapabilities: {} };
    internals.request = request;
    internals.recvTransport = { ...fakeTransport(), consume };

    const consumeProducer = internals.consumeProducer as (
      peerId: string,
      producerId: string,
      source: string
    ) => Promise<void>;
    // A click on the tile racing the auto-consume for the same producer -
    // and the same shape the join replay and the retry ladder produce.
    const first = consumeProducer.call(video, "sharer", "p1", "screen");
    const second = consumeProducer.call(video, "sharer", "p1", "screen");

    await Promise.resolve();
    // The bug: both passed the completed-consumer check (neither had
    // completed), the SFU answered the second with the SAME consumer id and
    // mid, and the second m-section made the browser reject the whole offer
    // with "duplicated a=msid" - permanently, since mediasoup-client keeps
    // the duplicate section and rebuilds every later offer from it.
    expect(request).toHaveBeenCalledTimes(1);

    answer({
      type: "ms:consumer-options",
      options: { id: "c1", producerId: "p1", kind: "video", rtpParameters: {} },
      peerId: "sharer",
      source: "screen",
    });
    await Promise.all([first, second]);

    expect(consume).toHaveBeenCalledTimes(1);
    expect(
      (internals.consumers as Map<string, unknown[]>).get("sharer")
    ).toHaveLength(1);
    // Released once settled, so a later re-consume (a stall, a rebuild) is
    // not answered with a stale promise.
    expect((internals.inflightConsumes as Map<string, unknown>).size).toBe(0);
  });
});

describe("cameras nothing on screen shows are not received (G05.1)", () => {
  interface Sent {
    type: string;
    producerId?: string;
  }

  /**
   * A joined session whose SFU answers every consume, recording each frame
   * sent and each consumer built. Consumers are fakes with their own track,
   * so a test can tell the original from the one a fresh consume brought.
   */
  function session() {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const sent: Sent[] = [];
    const built: Array<{ producerId: string; close: ReturnType<typeof vi.fn>; track: { id: string } }> = [];
    internals.device = { recvRtpCapabilities: {} };
    internals.ensureRecvTransport = async () => {};
    internals.signal = (msg: Sent) => sent.push(msg);
    internals.request = async (msg: Sent) => {
      sent.push(msg);
      return { type: "ms:consumer-options", options: { producerId: msg.producerId } };
    };
    let held: Promise<void> | null = null;
    internals.recvTransport = {
      ...fakeTransport(),
      consume: async (options: { producerId: string }) => {
        if (held) await held;
        const state = { closed: false };
        const consumer = {
          id: `c${built.length + 1}`,
          producerId: options.producerId,
          kind: "video",
          track: { id: `t${built.length + 1}` },
          get closed() {
            return state.closed;
          },
          close: vi.fn(() => {
            state.closed = true;
          }),
          on: vi.fn(),
        };
        built.push(consumer);
        return consumer;
      },
    };
    const consume = (peerId: string, producerId: string, source: "camera" | "screen") =>
      (internals.consumeProducer as (p: string, id: string, s: string) => Promise<void>).call(
        video,
        peerId,
        producerId,
        source
      );
    const closes = () => sent.filter((m) => m.type === "ms:close-consumer").map((m) => m.producerId);
    const consumes = () => sent.filter((m) => m.type === "ms:consume").map((m) => m.producerId);
    /**
     * Hold every consumer build from now on - the SFU has answered, the local
     * SDP work has not finished - until the returned release is called.
     */
    const holdBuilds = () => {
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      return () => {
        held = null;
        release();
      };
    };
    const signalIn = (msg: unknown) =>
      (internals.handleSignal as (m: unknown) => void).call(video, msg);
    return { video, internals, sent, built, consume, closes, consumes, holdBuilds, signalIn };
  }

  /** Let a consume started in the background (an unpark) run to the end. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("receives every camera while nothing has said what is on screen", async () => {
    const { consume, closes } = session();
    await consume("peer-a", "cam-a", "camera");

    vi.advanceTimersByTime(10 * CAMERA_PARK_GRACE_MS);

    // No opinion is the old behaviour exactly: a shell that never feeds
    // setWantedCameras keeps every camera, as before.
    expect(closes()).toEqual([]);
  });

  it("stops receiving a camera nothing shows once the grace period runs out", async () => {
    const { video, internals, built, consume, closes } = session();
    const removed = vi.fn();
    video.on("trackRemoved", removed);
    await consume("peer-a", "cam-a", "camera");

    // Another room opened: the stage is gone and the spotlight is a share.
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS - 1);
    expect(closes()).toEqual([]);
    vi.advanceTimersByTime(1);

    // Closed on the SFU, which stops forwarding it, and here.
    expect(closes()).toEqual(["cam-a"]);
    expect(built[0].close).toHaveBeenCalled();
    expect((internals.consumers as Map<string, unknown>).has("peer-a")).toBe(false);
    // The camera is still on, only not received: the app keeps the last
    // track, so the spotlight, the grid filter and the tile itself still
    // know this person has video.
    expect(removed).not.toHaveBeenCalled();
  });

  it("a glance away and back costs nothing", async () => {
    const { video, consume, closes } = session();
    await consume("peer-a", "cam-a", "camera");

    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS / 2);
    video.setWantedCameras(new Set(["peer-a"]));
    vi.advanceTimersByTime(10 * CAMERA_PARK_GRACE_MS);

    expect(closes()).toEqual([]);
  });

  it("receives it afresh the moment something shows it again", async () => {
    const { video, consume, consumes, sent } = session();
    const added = vi.fn();
    video.on("trackAdded", added);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    added.mockClear();

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();

    expect(consumes()).toEqual(["cam-a", "cam-a"]);
    // Resumed like every consume: the SFU asks for a keyframe on resume.
    expect(sent.at(-1)).toEqual({ type: "ms:resume-consumer", producerId: "cam-a" });
    // A new track replaces the one the app kept.
    expect(added).toHaveBeenCalledWith("peer-a", { id: "t2" }, "camera");
  });

  it("parks a camera that arrives while nothing shows it, after the same grace", async () => {
    const { video, consume, closes } = session();
    video.setWantedCameras(new Set(["someone-else"]));

    await consume("peer-a", "cam-a", "camera");
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    expect(closes()).toEqual(["cam-a"]);
  });

  it("never touches a screen share being watched", async () => {
    const { video, internals, consume, closes } = session();
    (internals.watchingTransmissionPeers as Set<string>).add("peer-b");
    await consume("peer-b", "share-b", "screen");

    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(10 * CAMERA_PARK_GRACE_MS);

    // Watching is the user's own choice, and the sharer's "who is watching"
    // list is announced from these consumers.
    expect(closes()).toEqual([]);
  });

  it("a camera turned off while parked leaves the app's tile", async () => {
    const { video, internals, consume } = session();
    const removed = vi.fn();
    video.on("trackRemoved", removed);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    (internals.handleSignal as (msg: unknown) => void).call(video, {
      type: "ms:producer-closed",
      peerId: "peer-a",
      producerId: "cam-a",
      source: "camera",
      kind: "video",
    });

    // No consumer was left to close, but the app still held the last track.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    // And it is not consumed again when shown: there is nothing to show.
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
  });

  it("a camera turned off just as it is shown again drops out quietly", async () => {
    const { video, internals, consume } = session();
    const removed = vi.fn();
    const errors = vi.fn();
    video.on("trackRemoved", removed);
    video.on("error", errors);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    internals.request = async () => ({ type: "ms:consume-failed", producerId: "cam-a" });

    // What is on screen can change twice while one consume is out.
    video.setWantedCameras(new Set(["peer-a"]));
    video.setWantedCameras(new Set(["peer-a", "peer-b"]));
    await settle();

    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    // Not an error anyone needs to see: the camera is simply off.
    expect(errors).not.toHaveBeenCalled();
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
  });

  it("an unpark that fails is tried once more three seconds later", async () => {
    const { video, internals, consume } = session();
    const added = vi.fn();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    video.on("trackAdded", added);
    const answer = internals.request as (msg: Sent) => Promise<unknown>;
    let calls = 0;
    internals.request = async (msg: Sent) => {
      if (++calls === 1) throw new Error("mediasoup request timeout: ms:consumer-options");
      return answer(msg);
    };

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    expect(added).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(calls).toBe(2);
    expect(added).toHaveBeenCalledWith("peer-a", { id: "t2" }, "camera");
  });

  it("an unpark that fails twice drops the frozen picture, and is tried again once shown afresh", async () => {
    const { video, internals, consume } = session();
    const removed = vi.fn();
    video.on("trackRemoved", removed);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    const answer = internals.request as (msg: Sent) => Promise<unknown>;
    let calls = 0;
    internals.request = async (msg: Sent) => {
      if (++calls <= 2) throw new Error("mediasoup request timeout: ms:consumer-options");
      return answer(msg);
    };

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    // A tile showing the person beats one frozen on a stale frame.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    // Not while it stays shown, whatever else changes: someone starting to
    // talk is no reason to ask a failing SFU again.
    video.setWantedCameras(new Set(["peer-a", "peer-b"]));
    await settle();
    expect(calls).toBe(2);
    // Off the screen and back again tries afresh.
    video.setWantedCameras(new Set(["peer-b"]));
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    expect(calls).toBe(3);
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
  });

  it("after two failed unparks, the app pushing the same cameras again does not start the tries over", async () => {
    const { video, internals, consume } = session();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    let attempts = 0;
    internals.request = async () => {
      attempts++;
      throw new Error("mediasoup request timeout: ms:consumer-options");
    };
    // What the app does on any roster change, and the double failure's own
    // trackRemoved is one: AppView hands the spotlight a new tile object and
    // call-cameras pushes an equal set.
    video.on("trackRemoved", () => video.setWantedCameras(new Set(["peer-a"])));

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    // A minute in which nothing on screen changes.
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    }

    // Was 3 by the end of the ladder and 46 a minute later: every push
    // retried a camera that had been shown all along.
    expect(attempts).toBe(2);
  });

  it("leaving while a second try waits leaves no timer, and nothing tries after a rejoin", async () => {
    const { video, internals, consume, consumes } = session();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    const answer = internals.request as (msg: Sent) => Promise<unknown>;
    const transport = internals.recvTransport;
    internals.request = async () => {
      throw new Error("mediasoup request timeout: ms:consumer-options");
    };
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();

    video.leave();
    expect(vi.getTimerCount()).toBe(0);

    // The same room again inside the three seconds, cam-a still parked
    // there: only that call's own screen may bring it back.
    internals.device = { recvRtpCapabilities: {} };
    internals.recvTransport = transport;
    internals.request = answer;
    (internals.parkedCameras as Map<string, string>).set("cam-a", "peer-a");
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(consumes()).toEqual(["cam-a"]);
  });

  it("a set changed in place after it was handed over still counts as a change", async () => {
    const { video, consume, closes } = session();
    await consume("peer-a", "cam-a", "camera");
    const shown = new Set(["peer-a"]);
    video.setWantedCameras(shown);

    shown.delete("peer-a");
    video.setWantedCameras(shown);
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    expect(closes()).toEqual(["cam-a"]);
  });

  it("an unpark whose camera closes while its consumer is being built adds no dead track", async () => {
    const { video, internals, built, consume, closes } = session();
    const added = vi.fn();
    const removed = vi.fn();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    video.on("trackAdded", added);
    video.on("trackRemoved", removed);
    // The SFU answered the consume, then the producer closed while
    // recvTransport.consume() (local SDP work) was still running.
    const transport = internals.recvTransport as { consume: (o: unknown) => Promise<unknown> };
    const build = transport.consume;
    let release!: () => void;
    transport.consume = async (o: unknown) => {
      await new Promise<void>((r) => (release = r));
      return build(o);
    };

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    (internals.handleSignal as (msg: unknown) => void).call(video, {
      type: "ms:producer-closed",
      peerId: "peer-a",
      producerId: "cam-a",
      source: "camera",
      kind: "video",
    });
    release();
    await settle();

    // Told the camera is off, and never handed a track that will not play.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(added).not.toHaveBeenCalled();
    expect(built[1].close).toHaveBeenCalled();
    expect(closes()).toEqual(["cam-a", "cam-a"]);
    expect((internals.consumers as Map<string, unknown>).has("peer-a")).toBe(false);
    expect((internals.closedWhileConsuming as Set<string>).size).toBe(0);
  });

  it("a first consume whose camera closes while its consumer is being built adds no dead track", async () => {
    // The same race on the announce path: it froze a tile until the stall
    // sweep turned it into "That stream has ended".
    const { video, internals, built, consume, closes } = session();
    const added = vi.fn();
    const errors = vi.fn();
    video.on("trackAdded", added);
    video.on("error", errors);
    const transport = internals.recvTransport as { consume: (o: unknown) => Promise<unknown> };
    const build = transport.consume;
    let release!: () => void;
    transport.consume = async (o: unknown) => {
      await new Promise<void>((r) => (release = r));
      return build(o);
    };

    const consuming = consume("peer-a", "cam-a", "camera");
    await settle();
    (internals.handleSignal as (msg: unknown) => void).call(video, {
      type: "ms:producer-closed",
      peerId: "peer-a",
      producerId: "cam-a",
      source: "camera",
      kind: "video",
    });
    release();
    await consuming;

    expect(added).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(built[0].close).toHaveBeenCalled();
    expect(closes()).toEqual(["cam-a"]);
    expect((internals.consumers as Map<string, unknown>).has("peer-a")).toBe(false);
    expect((internals.closedWhileConsuming as Set<string>).size).toBe(0);
  });

  it("a peer leaving while their camera is parked takes the kept track with peerLeft", async () => {
    const { video, internals, consume } = session();
    const left = vi.fn();
    const removed = vi.fn();
    video.on("peerLeft", left);
    video.on("trackRemoved", removed);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    expect((internals.parkedCameras as Map<string, string>).size).toBe(1);

    (internals.handleSignal as (msg: unknown) => void).call(video, {
      type: "ms:peer-left",
      peerId: "peer-a",
    });

    expect(left).toHaveBeenCalledTimes(1);
    expect(left).toHaveBeenCalledWith("peer-a");
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
    expect(removed).not.toHaveBeenCalled();
  });

  it("a rejoin retracts parked cameras; the replay brings back the ones still on", async () => {
    const { video, internals, consume } = session();
    const removed = vi.fn();
    video.on("trackRemoved", removed);
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    internals.currentRoomCode = "room";
    internals.currentPeerId = "me";
    internals.sessionIsLive = () => false;
    internals.join = vi.fn(async () => {});

    await (internals.attemptRejoin as (g: number) => Promise<void>)(
      internals.joinGeneration as number
    );

    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
    // What is on screen is not session state.
    expect(internals.wantedCameras).toEqual(new Set());
  });

  it("leaving forgets parked cameras and goes back to receiving everything", async () => {
    const { video, internals, consume } = session();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    video.leave();

    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
    expect(internals.wantedCameras).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the stall detector does not mistake a parked camera for a frozen one", async () => {
    const { video, internals, consume, consumes } = session();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    // A parked camera sends nothing, which is what a stall looks like - but
    // it is no longer among the consumers the sweep reads.
    (internals.sweepConsumerStats as () => void).call(video);
    (internals.sweepConsumerStats as () => void).call(video);
    await settle();

    expect(consumes()).toEqual(["cam-a"]);
  });

  it("an unpark in flight when its owner leaves the call does not bring them back", async () => {
    const { video, internals, built, consume, closes, holdBuilds, signalIn } = session();
    await consume("peer-a", "cam-a", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    const events: string[] = [];
    video.on("peerJoined", (p) => events.push(`peerJoined:${p}`));
    video.on("peerLeft", (p) => events.push(`peerLeft:${p}`));
    video.on("trackAdded", (p) => events.push(`trackAdded:${p}`));

    // They start to talk, or their tile scrolls into view; the SFU answers
    // the consume, and they leave while the consumer is built here - a
    // goodbye said while clicking Leave. The SFU closes a leaver's producers
    // and sends ms:peer-left alone, never ms:producer-closed.
    const release = holdBuilds();
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    signalIn({ type: "ms:peer-left", peerId: "peer-a" });
    release();
    await settle();

    // Was peerLeft, then peerJoined and trackAdded with a track that never
    // plays.
    expect(events).toEqual(["peerLeft:peer-a"]);
    expect(built[1].close).toHaveBeenCalled();
    expect(closes()).toEqual(["cam-a", "cam-a"]);
    expect((internals.consumers as Map<string, unknown>).has("peer-a")).toBe(false);
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
    expect((internals.inflightConsumes as Map<string, unknown>).size).toBe(0);
    expect((internals.closedWhileConsuming as Set<string>).size).toBe(0);
  });

  it("a first consume in flight when its owner leaves does not bring them in", async () => {
    // The same race on the announce path: answered, then the owner gone
    // before the consumer is built here.
    const { video, internals, built, closes, consumes, holdBuilds, signalIn } = session();
    const events: string[] = [];
    const errors = vi.fn();
    video.on("peerJoined", (p) => events.push(`peerJoined:${p}`));
    video.on("peerLeft", (p) => events.push(`peerLeft:${p}`));
    video.on("trackAdded", (p) => events.push(`trackAdded:${p}`));
    video.on("error", errors);

    const release = holdBuilds();
    signalIn({ type: "ms:new-producer", peerId: "peer-a", producerId: "cam-a", source: "camera" });
    await settle();
    signalIn({ type: "ms:peer-left", peerId: "peer-a" });
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    // Never joined here, so nothing to take back, and nothing tried again.
    expect(events).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(built[0].close).toHaveBeenCalled();
    expect(consumes()).toEqual(["cam-a"]);
    expect(closes()).toEqual(["cam-a"]);
    expect((internals.consumers as Map<string, unknown>).has("peer-a")).toBe(false);
    expect((internals.closedWhileConsuming as Set<string>).size).toBe(0);
  });

  it("a leaver who comes back keeps their new camera when shown", async () => {
    const { video, internals, consume, holdBuilds, signalIn } = session();
    await consume("peer-a", "cam-old", "camera");
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);
    // The race above, and then nothing shows them for the grace period.
    const release = holdBuilds();
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();
    signalIn({ type: "ms:peer-left", peerId: "peer-a" });
    release();
    await settle();
    video.setWantedCameras(new Set());
    vi.advanceTimersByTime(CAMERA_PARK_GRACE_MS);

    // They come back with a new camera; the old one is gone on the SFU.
    const answer = internals.request as (msg: Sent) => Promise<unknown>;
    internals.request = async (msg: Sent) =>
      msg.producerId === "cam-old"
        ? { type: "ms:consume-failed", producerId: "cam-old" }
        : answer(msg);
    const seen: string[] = [];
    video.on("trackAdded", (p, t) => seen.push(`added:${p}:${(t as unknown as { id: string }).id}`));
    video.on("trackRemoved", (p, s) => seen.push(`removed:${p}:${s}`));
    await consume("peer-a", "cam-new", "camera");
    // They talk, or their tile scrolls into view: shown afresh.
    video.setWantedCameras(new Set(["peer-a"]));
    await settle();

    // Was added, then removed: the late consumer, parked, left an entry for
    // the dead camera, and its failed return blanked the live one.
    expect(seen).toEqual(["added:peer-a:t3"]);
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
  });

  it("a camera that is gone never blanks the one that took its place", async () => {
    // trackRemoved names a peer and a source, never a producer. However a
    // parked entry for a dead camera came to outlive it, its failed return
    // must leave the peer's live camera alone.
    const { video, internals, consume } = session();
    await consume("peer-a", "cam-new", "camera");
    video.setWantedCameras(new Set());
    (internals.parkedCameras as Map<string, string>).set("cam-old", "peer-a");
    const answer = internals.request as (msg: Sent) => Promise<unknown>;
    internals.request = async (msg: Sent) =>
      msg.producerId === "cam-old"
        ? { type: "ms:consume-failed", producerId: "cam-old" }
        : answer(msg);
    const removed = vi.fn();
    video.on("trackRemoved", removed);

    video.setWantedCameras(new Set(["peer-a"]));
    await settle();

    expect(removed).not.toHaveBeenCalled();
    expect((internals.parkedCameras as Map<string, string>).size).toBe(0);
  });

  it("a stalled camera turned off while it is consumed again is reported off", async () => {
    const { video, internals, built, consume, holdBuilds, signalIn } = session();
    await consume("peer-a", "cam-a", "camera");
    // Not a byte comes in: the sweep's two misses in a row.
    (built[0] as unknown as { getStats: () => Promise<Map<string, unknown>> }).getStats =
      async () => new Map([["in", { type: "inbound-rtp", bytesReceived: 100 }]]);
    const added = vi.fn();
    const removed = vi.fn();
    video.on("trackAdded", added);
    video.on("trackRemoved", removed);

    const release = holdBuilds();
    for (let i = 0; i < 3; i++) {
      (internals.sweepConsumerStats as () => void).call(video);
      await settle();
    }
    expect((internals.inflightConsumes as Map<string, unknown>).has("cam-a")).toBe(true);
    // The stalled consumer is already off the list, so closing the camera
    // finds nothing to close.
    signalIn({
      type: "ms:producer-closed",
      peerId: "peer-a",
      producerId: "cam-a",
      source: "camera",
      kind: "video",
    });
    release();
    await settle();

    // The app held the stalled track as "camera on", for good.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    expect(added).not.toHaveBeenCalled();
    expect((internals.inflightConsumes as Map<string, unknown>).size).toBe(0);
  });

  it("a camera turned off while a rebuilt recv transport consumes it again is reported off", async () => {
    const { video, internals, consume, holdBuilds, signalIn } = session();
    await consume("peer-a", "cam-a", "camera");
    const transport = internals.recvTransport;
    const added = vi.fn();
    const removed = vi.fn();
    video.on("trackAdded", added);
    video.on("trackRemoved", removed);

    const release = holdBuilds();
    (internals.rebuildRecvTransport as () => void).call(video);
    // The fresh transport, which ensureRecvTransport would have built.
    internals.recvTransport = transport;
    await settle();
    expect((internals.inflightConsumes as Map<string, unknown>).has("cam-a")).toBe(true);
    signalIn({
      type: "ms:producer-closed",
      peerId: "peer-a",
      producerId: "cam-a",
      source: "camera",
      kind: "video",
    });
    release();
    await settle();

    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("peer-a", "camera", "video");
    expect(added).not.toHaveBeenCalled();
  });
});

describe("a transport whose path goes quiet restarts ICE instead of waiting to fail", () => {
  function setup() {
    const video = new MediasoupVideo();
    const internals = internalsOf(video);
    const iceParameters = { usernameFragment: "fresh", password: "p", iceLite: true };
    const recv = { closed: false, restartIce: vi.fn(async () => {}) };
    internals.recvTransport = recv;
    const request = vi.fn(async () => ({ type: "ms:ice-restarted", direction: "recv", iceParameters }));
    internals.request = request;
    const restart = () => (internals.restartIce as (d: "send" | "recv") => void).call(internals, "recv");
    return { recv, request, restart, iceParameters };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks the SFU for fresh credentials and hands them to the transport", async () => {
    const { recv, request, restart, iceParameters } = setup();
    restart();
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ms:restart-ice", direction: "recv" }),
      "ms:ice-restarted"
    );
    expect(recv.restartIce).toHaveBeenCalledWith({ iceParameters });
  });

  it("asks once while a restart is in flight, and again after it lands", async () => {
    const { request, restart } = setup();
    restart();
    restart();
    expect(request).toHaveBeenCalledTimes(1);
    await settle();
    restart();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("leaves a transport closed while the answer travelled alone", async () => {
    const { recv, restart } = setup();
    restart();
    recv.closed = true;
    await settle();
    expect(recv.restartIce).not.toHaveBeenCalled();
  });

  it("an unanswered ask is dropped quietly: a failed transport still rejoins", async () => {
    const { recv, request, restart } = setup();
    request.mockRejectedValueOnce(new Error("mediasoup request timeout: ms:ice-restarted"));
    restart();
    await settle();
    expect(recv.restartIce).not.toHaveBeenCalled();
    restart();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("a rebuilt session does not inherit the old socket's requests (transport-options timeout)", () => {
  type Internals = Record<string, unknown> & {
    ensureRecvTransport: () => Promise<void>;
    failPending: (ws: unknown, err: Error) => void;
    handleSignal: (msg: unknown) => void;
    request: (msg: unknown, responseType: string) => Promise<unknown>;
  };

  function fakeSocket(open = true) {
    const sent: Array<{ type: string; requestId?: string }> = [];
    return {
      readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
      send: (m: string) => sent.push(JSON.parse(m)),
      sent,
    };
  }

  function setup() {
    const video = new MediasoupVideo();
    const internals = internalsOf(video) as Internals;
    const recv = { on: vi.fn(), close: vi.fn(), connectionState: "new" };
    internals.device = { createRecvTransport: vi.fn(() => recv) };
    return { internals, recv };
  }

  function answer(internals: Internals, requestId: string | undefined) {
    internals.handleSignal({
      type: "ms:transport-options",
      requestId,
      direction: "recv",
      options: { id: "t", iceParameters: {}, iceCandidates: [], dtlsParameters: {} },
    });
  }

  it("fails the old socket's request at once, and the new session asks afresh", async () => {
    const { internals, recv } = setup();
    const oldWs = fakeSocket();
    internals.sfuWs = oldWs;
    const first = internals.ensureRecvTransport();
    expect(oldWs.sent.map((m) => m.type)).toEqual(["ms:create-transport"]);

    // The rebuild: what the old socket owed fails now, not 10s from now.
    internals.failPending(oldWs, new Error("SFU session rebuilt"));
    await expect(first).rejects.toThrow("SFU session rebuilt");

    const newWs = fakeSocket();
    internals.sfuWs = newWs;
    const second = internals.ensureRecvTransport();
    expect(second).not.toBe(first);
    expect(newWs.sent.map((m) => m.type)).toEqual(["ms:create-transport"]);
    answer(internals, newWs.sent[0].requestId);
    await expect(second).resolves.toBeUndefined();
    expect(internals.recvTransport).toBe(recv);
  });

  it("a stale socket closing late leaves the live session's transport request alone", async () => {
    const { internals } = setup();
    const oldWs = fakeSocket();
    const newWs = fakeSocket();
    internals.sfuWs = newWs;
    const live = internals.ensureRecvTransport();
    internals.failPending(oldWs, new Error("SFU connection closed"));
    // Still the same in-flight request: a second one would be refused by the
    // SFU without an answer while the first is being built.
    expect(internals.ensureRecvTransport()).toBe(live);
    expect(newWs.sent).toHaveLength(1);
    answer(internals, newWs.sent[0].requestId);
    await expect(live).resolves.toBeUndefined();
  });

  it("an answer that lands after the session was rebuilt is not installed", async () => {
    const { internals } = setup();
    const oldWs = fakeSocket();
    internals.sfuWs = oldWs;
    const stale = internals.ensureRecvTransport();
    internals.sfuWs = fakeSocket();
    answer(internals, oldWs.sent[0].requestId);
    await expect(stale).rejects.toThrow("SFU session rebuilt");
    expect(internals.recvTransport ?? null).toBeNull();
  });

  it("a request on a socket that is not open fails at once instead of timing out", async () => {
    const { internals } = setup();
    internals.sfuWs = fakeSocket(false);
    await expect(
      internals.request({ type: "ms:create-transport", requestId: "r9", direction: "recv" }, "ms:transport-options"),
    ).rejects.toThrow("SFU not connected");
    expect((internals.pendingById as Map<string, unknown>).size).toBe(0);
  });
});
