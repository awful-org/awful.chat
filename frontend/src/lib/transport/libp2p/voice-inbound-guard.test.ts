import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibP2PVoice, isVoiceSignal } from "./voice";

function makeVoice(dtln: unknown = null, dfn: unknown = null) {
  const transport = {
    selfId: () => "zzz",
    peers: () => [],
    isRelay: () => false,
    send: async () => {},
    on: () => {},
    off: () => {},
  };
  const voice = new LibP2PVoice(transport as never, dtln as never, dfn as never);
  const internals = voice as never as Record<string, unknown>;
  return { voice, internals };
}

describe("isVoiceSignal", () => {
  it("accepts a well-formed offer/answer", () => {
    expect(isVoiceSignal({ type: "offer", sdp: "v=0..." })).toBe(true);
    expect(isVoiceSignal({ type: "answer", sdp: "v=0..." })).toBe(true);
  });

  it("accepts a well-formed ice candidate", () => {
    expect(
      isVoiceSignal({ type: "ice", candidate: { candidate: "candidate:1 ..." } })
    ).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(isVoiceSignal({ type: "eval", sdp: "x" })).toBe(false);
  });

  it("rejects a non-string sdp", () => {
    expect(isVoiceSignal({ type: "offer", sdp: 123 })).toBe(false);
  });

  it("rejects an ice signal whose candidate is missing the candidate string", () => {
    expect(isVoiceSignal({ type: "ice", candidate: {} })).toBe(false);
    expect(isVoiceSignal({ type: "ice", candidate: "not-an-object" })).toBe(
      false
    );
  });

  it("rejects non-objects", () => {
    expect(isVoiceSignal(null)).toBe(false);
    expect(isVoiceSignal("offer")).toBe(false);
    expect(isVoiceSignal(42)).toBe(false);
  });
});

describe("admitsInboundStream (default-deny inbound guard)", () => {
  it("denies before the roster has been fed at least once", () => {
    const { internals } = makeVoice();
    expect(internals.rosterSeen as boolean).toBe(false);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });

  it("denies a peer not on the roster once fed", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["bbb"]);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });

  it("admits a peer once the roster has been fed and includes them", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(true);
  });

  it("goes back to default-deny after leave()", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    voice.leave();
    expect(internals.rosterSeen as boolean).toBe(false);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });
});

describe("handleWireSignal (signalling over the app transport)", () => {
  it("ignores a signal from a peer outside the roster", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["bbb"]);
    let created = false;
    internals.ensureRemotePeer = () => {
      created = true;
    };
    voice.handleWireSignal("aaa", { type: "offer", sdp: "v=0..." });
    expect(created).toBe(false);
  });

  it("counts and drops a malformed signal before any roster or pc work", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    voice.handleWireSignal("aaa", { type: "eval", sdp: "x" });
    expect(
      (internals.debugStats as Record<string, number>).signalsInvalid
    ).toBe(1);
    expect((internals.remotePeers as Map<string, unknown>).size).toBe(0);
  });

  it("creates the peer only for an admitted offer, and routes it on", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    const calls: string[] = [];
    internals.ensureRemotePeer = (peerId: string) => {
      calls.push(`ensure:${peerId}`);
    };
    internals.handleSignal = async (peerId: string, sig: { type: string }) => {
      calls.push(`signal:${peerId}:${sig.type}`);
    };
    voice.handleWireSignal("aaa", { type: "offer", sdp: "v=0..." });
    // An answer or candidate must not create state - stale ones arrive after
    // a teardown, and a fresh pc built for them would sit forever.
    voice.handleWireSignal("aaa", {
      type: "ice",
      candidate: { candidate: "candidate:1" },
    });
    expect(calls).toEqual([
      "ensure:aaa",
      "signal:aaa:offer",
      "signal:aaa:ice",
    ]);
  });
});

describe("dialAndOfferInner offer delivery", () => {
  it("tears the link down when the transport says the offer never went out", async () => {
    const { voice, internals } = makeVoice();
    internals.node = {};
    // A pc stub that hands out an offer; the transport refuses to deliver it.
    const remote = {
      peerId: "aaa",
      pc: {
        remoteDescription: null,
        signalingState: "stable",
        localDescription: null,
        createOffer: async () => ({ type: "offer", sdp: "v=0..." }),
        setLocalDescription: async () => {},
        close: () => {},
      },
      stream: null,
      audio: { srcObject: null },
      sourceNode: null,
      gainNode: null,
      pendingCandidates: [],
      createdAt: performance.now(),
      everConnected: false,
      okAt: performance.now(),
    };
    internals.ensureRemotePeer = () => remote;
    (internals.remotePeers as Map<string, unknown>).set("aaa", remote);
    (voice as never as { transport: { send: () => Promise<boolean> } })[
      "transport"
    ].send = async () => false;

    await (
      internals.dialAndOfferInner as (peerId: string) => Promise<void>
    ).call(internals, "aaa");

    expect((internals.remotePeers as Map<string, unknown>).has("aaa")).toBe(
      false
    );
  });
});

describe("pendingCandidates cap", () => {
  it("stops buffering at MAX_PENDING_CANDIDATES, dropping the newest", async () => {
    const { internals } = makeVoice();
    const remote = {
      pc: { remoteDescription: null },
      pendingCandidates: [] as unknown[],
    };
    (internals.remotePeers as Map<string, unknown>).set("aaa", remote);

    // Called through `internals`, not extracted into a local, so `this`
    // still resolves to the voice instance - handleSignal is a normal
    // (unbound) method.
    for (let i = 0; i < 300; i++) {
      await (
        internals.handleSignal as (
          peerId: string,
          signal: unknown
        ) => Promise<void>
      ).call(internals, "aaa", {
        type: "ice",
        candidate: { candidate: `candidate:${i}` },
      });
    }

    expect(remote.pendingCandidates.length).toBe(256);
    // The first 256 survive; the rest were dropped rather than evicting them.
    expect(
      (remote.pendingCandidates[0] as { candidate: string }).candidate
    ).toBe("candidate:0");
  });
});

describe("startMic replaceTrack loop (finding 2)", () => {
  const fakeMicTrack = { getSettings: () => ({ deviceId: "mic1" }), stop: () => {} };
  const fakeMicStream = {
    getAudioTracks: () => [fakeMicTrack],
    getTracks: () => [fakeMicTrack],
  };
  const fakeProcessedTrack = { kind: "audio" };
  const fakeAudioCtx = {
    createMediaStreamSource: () => ({ connect: () => {} }),
    createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
    createMediaStreamDestination: () => ({
      stream: { getAudioTracks: () => [fakeProcessedTrack] },
    }),
  };

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => fakeMicStream },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeSenderRemote(
    peerId: string,
    replaceTrack: (track: unknown) => Promise<void>
  ) {
    return {
      peerId,
      pc: {
        getSenders: () => [{ track: { kind: "audio" }, replaceTrack }],
        addTrack: () => {},
      },
    };
  }

  it("a replaceTrack rejection for one peer still updates every other peer", async () => {
    const { internals } = makeVoice();
    internals.audioCtx = fakeAudioCtx;
    const updated: string[] = [];
    const remotes = new Map<string, unknown>([
      [
        "aaa",
        fakeSenderRemote("aaa", async () => {
          // A peer torn down mid-switch (reconcile tick, redial) rejects
          // here with InvalidStateError - the exact failure finding 2 names.
          throw new DOMException("stopped", "InvalidStateError");
        }),
      ],
      [
        "bbb",
        fakeSenderRemote("bbb", async () => {
          updated.push("bbb");
        }),
      ],
      [
        "ccc",
        fakeSenderRemote("ccc", async () => {
          updated.push("ccc");
        }),
      ],
    ]);
    internals.remotePeers = remotes;

    // Must resolve, not reject: before the fix, "aaa"'s rejection propagated
    // out of startMic and skipped applyMuteState() and every peer after it
    // in Map iteration order.
    await (internals.startMic as (d?: string) => Promise<void>).call(
      internals
    );

    expect(updated).toEqual(["bbb", "ccc"]);
  });
});

describe("handleSignal: an offer in an unrecoverable signalling state asks for redial (finding 4)", () => {
  it("asks for a fresh dial instead of dropping the offer silently", async () => {
    const { internals } = makeVoice();
    const asked: string[] = [];
    internals.askForRedial = (peerId: string) => {
      asked.push(peerId);
    };
    const remote = {
      pc: {
        // "have-remote-offer" is neither "stable" nor "have-local-offer" -
        // the branch the audit calls unrecoverable at this signalling layer.
        signalingState: "have-remote-offer",
        setRemoteDescription: async () => {
          throw new Error("must not be reached");
        },
      },
      pendingCandidates: [],
    };
    (internals.remotePeers as Map<string, unknown>).set("aaa", remote);

    await (
      internals.handleSignal as (
        peerId: string,
        signal: unknown
      ) => Promise<void>
    ).call(internals, "aaa", { type: "offer", sdp: "v=0..." });

    expect(asked).toEqual(["aaa"]);
  });
});

/** A model that loads (or fails to, once `gate` opens) and hands back a processed stream. */
function fakeDenoiser(failures = 0, gate?: Promise<void>) {
  const d = {
    loads: 0,
    processed: 0,
    released: 0,
    /** The mic its peer-facing graph runs on; null once released. */
    attachedTo: null as unknown,
    fatal: null as ((err: Error) => void) | null,
    waitUntilReady: async () => {
      d.loads++;
      await gate;
      if (d.loads <= failures) throw new Error("offline");
    },
    processStream: async (mic: unknown) => {
      d.processed++;
      d.attachedTo = mic;
      return fakeStream();
    },
    monitorStream: async () => ({ processedStream: fakeStream(), cleanup: () => {} }),
    releaseTransport: () => {
      d.released++;
      d.attachedTo = null;
    },
    disconnectFromTransport: () => {},
    reconnectToTransport: () => {},
    setInputGain: () => {},
    onFatal: (handler: ((err: Error) => void) | null) => {
      d.fatal = handler;
    },
    getProcessingLoad: () => null,
  };
  return d;
}

function fakeStream() {
  const track = {
    enabled: true,
    stopped: false,
    stop: () => {
      track.stopped = true;
    },
    getSettings: () => ({ deviceId: "mic-1" }),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

type Fatal = (error: Error, engine: string) => void;

class FakeCallCtx {
  sampleRate = 48000;
  state = "running";
  destination = {};
  async resume() {}
  async close() {}
  createDynamicsCompressor() {
    const param = () => ({ value: 0 });
    return {
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      connect: () => {}, disconnect: () => {},
    };
  }
  createMediaStreamDestination() {
    return { stream: fakeStream() };
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
}

describe("LibP2PVoice.handleDtlnFatal (finding 1)", () => {
  it("rebuilds the mic on the active input device when a call is active", () => {
    const { voice, internals } = makeVoice(fakeDenoiser());
    internals.audioCtx = {}; // a call is active
    internals.activeInputDevice = "mic-2";
    const calls: (string | undefined)[] = [];
    internals.startMic = (deviceId?: string) => {
      calls.push(deviceId);
      return Promise.resolve();
    };

    (internals.handleDtlnFatal as Fatal).call(internals, new Error("x"), "dtln");

    expect(calls).toEqual(["mic-2"]);
    // The switch is the user's: a crash no longer turns it off.
    expect(voice.isDtlnEnabled()).toBe(true);
  });

  it("reports native fallback with its reason so settings cannot claim DTLN is active", () => {
    const { voice, internals } = makeVoice(fakeDenoiser());
    internals.audioCtx = {};
    internals.startMic = () => Promise.resolve();
    const changed = vi.fn();
    voice.on("processingChanged", changed);
    (internals.handleDtlnFatal as Fatal).call(internals, new Error("DTLN processing budget exceeded"), "dtln");
    expect(changed).toHaveBeenCalledWith("browser", "DTLN processing budget exceeded", false);
  });

  it("ignores a model the call is not running through", () => {
    const { internals } = makeVoice(fakeDenoiser(), fakeDenoiser());
    internals.audioCtx = {};
    let called = false;
    internals.startMic = () => {
      called = true;
      return Promise.resolve();
    };

    // DFN3 is the active one; an idle DTLN dying changes nothing.
    (internals.handleDtlnFatal as Fatal).call(internals, new Error("x"), "dtln");

    expect(called).toBe(false);
  });

  it("does nothing without an active call - no audioCtx, nothing to rebuild", () => {
    const { internals } = makeVoice();
    internals.audioCtx = null;
    let called = false;
    internals.startMic = () => {
      called = true;
      return Promise.resolve();
    };

    (internals.handleDtlnFatal as Fatal).call(internals, new Error("x"), "dtln");

    expect(called).toBe(false);
  });
});

describe("noise-suppression fallback chain", () => {
  let asked: MediaTrackConstraints[];

  let opened: ReturnType<typeof fakeStream>[];

  beforeEach(() => {
    asked = [];
    opened = [];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async (c: MediaStreamConstraints) => {
          asked.push(c.audio as MediaTrackConstraints);
          const mic = fakeStream();
          opened.push(mic);
          return mic;
        },
      },
    });
    // dfnUnsupportedReason() wants AudioWorklet (and SIMD, which Node has).
    vi.stubGlobal("AudioWorkletNode", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(dfn = fakeDenoiser(), dtln = fakeDenoiser()) {
    const { voice, internals } = makeVoice(dtln, dfn);
    internals.audioCtx = new FakeCallCtx();
    const changed = vi.fn();
    const notices: string[] = [];
    voice.on("processingChanged", changed);
    voice.on("status", (s) => {
      if (s.type === "app-warning") notices.push(s.message);
    });
    const startMic = () => (internals.startMic as () => Promise<void>).call(internals);
    return { voice, internals, dfn, dtln, changed, notices, startMic };
  }

  /** What join() needs to run here, with the hardware at `sampleRate`. */
  function joinable(internals: Record<string, unknown>, sampleRate = 48000) {
    vi.stubGlobal("AudioContext", class extends FakeCallCtx {
      sampleRate = sampleRate;
    });
    (internals.transport as { p2pNode?: unknown }).p2pNode = {};
    internals.reconcileLinks = () => {};
  }

  /** Mics opened and never stopped. */
  const live = () => opened.filter((mic) => !mic.getTracks()[0].stopped);

  it("runs DeepFilterNet3 by default, with browser suppression off", async () => {
    const { dfn, dtln, notices, startMic } = setup();
    await startMic();
    expect(dfn.processed).toBe(1);
    expect(dtln.processed).toBe(0);
    expect(asked).toEqual([expect.objectContaining({ noiseSuppression: false, echoCancellation: true })]);
    expect(notices).toEqual([]);
  });

  it("falls back to DTLN on the same mic, says so, and keeps the saved choice", async () => {
    const { voice, dfn, dtln, changed, notices, startMic } = setup(fakeDenoiser(1));
    await startMic();

    expect(dtln.processed).toBe(1);
    expect(dfn.released).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
    expect(changed).toHaveBeenLastCalledWith("dtln", "offline", false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/DeepFilterNet.*DTLN/);
    expect(voice.isDtlnEnabled()).toBe(true);
    expect(voice.getNoiseEngine()).toBe("dfn3");
  });

  it("ends on browser suppression, re-requesting the mic, when no model works", async () => {
    const { changed, notices, startMic } = setup(fakeDenoiser(1), fakeDenoiser(1));
    await startMic();

    expect(asked.map((c) => c.noiseSuppression)).toEqual([false, true]);
    expect(changed).toHaveBeenLastCalledWith("browser", "offline", false);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatch(/DTLN.*browser/);
  });

  // The only test here to hit the skip: the once-a-session flag is module state.
  it("skips DeepFilterNet3 up front off 48 kHz, reporting it every call but saying so once", async () => {
    const { voice, internals, dfn, dtln, changed, notices } = setup();
    joinable(internals, 44100);
    await voice.join("room");
    voice.leave();
    await voice.join("room");
    // A settings toggle restarts the mic, and skips again.
    await voice.setDtlnEnabled(false);
    await voice.setDtlnEnabled(true);
    voice.leave();

    expect(dfn.loads).toBe(0);
    expect(dtln.processed).toBe(3);
    const skip = ["dtln", "the audio hardware runs at 44100 Hz, not 48 kHz", true];
    expect(changed.mock.calls.filter(([, , unsupported]) => unsupported)).toEqual([skip, skip, skip]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/DeepFilterNet .*can't run on this device \(.*44100 Hz.*\), so DTLN/);
  });

  it("a setting changed while DeepFilterNet3 loads leaves one model, on the newest mic", async () => {
    const slow = deferred();
    const { voice, dfn, dtln, changed, notices, startMic } = setup(fakeDenoiser(0, slow.promise));
    const first = startMic();
    await vi.waitFor(() => expect(dfn.loads).toBe(1));

    await voice.setNoiseEngine("dtln");
    slow.resolve();
    await first;

    expect(dfn.processed).toBe(0);
    expect(dfn.attachedTo).toBeNull();
    expect(dtln.attachedTo).toBe(voice.getMicStream());
    expect(live()).toEqual([voice.getMicStream()]);
    expect(changed).toHaveBeenLastCalledWith("dtln");
    expect(notices).toEqual([]);
  });

  it("a mic that opens after a newer run took over is closed, not used", async () => {
    const { voice, dfn, dtln, startMic } = setup();
    const slow = deferred();
    const open = navigator.mediaDevices.getUserMedia;
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (calls++ === 0) await slow.promise;
      return open(c);
    };
    const first = startMic();

    await voice.setNoiseEngine("dtln");
    slow.resolve();
    await first;

    expect(dfn.loads).toBe(0);
    expect(dtln.attachedTo).toBe(voice.getMicStream());
    expect(live()).toEqual([voice.getMicStream()]);
  });

  it.each([
    ["fails", 1],
    ["finishes", 0],
  ])("leaving while DeepFilterNet3 loads: a load that then %s changes nothing", async (_, failures) => {
    const slow = deferred();
    const { voice, internals, dfn, dtln, changed, notices } = setup(fakeDenoiser(failures, slow.promise));
    joinable(internals);
    const joining = voice.join("room");
    await vi.waitFor(() => expect(dfn.loads).toBe(1));

    voice.leave();
    slow.resolve();
    await joining;

    expect(notices).toEqual([]);
    expect(changed.mock.calls.filter(([, reason]) => reason)).toEqual([]);
    expect(dtln.loads).toBe(0);
    expect(dfn.attachedTo).toBeNull();
    expect(live()).toEqual([]);
    voice.leave(); // join() carries on past a leave; drop what it set up
  });

  it("switching suppression off mid-call asks for the browser's and releases both models", async () => {
    const { voice, dfn, dtln, changed, startMic } = setup();
    await startMic();
    await voice.setDtlnEnabled(false);

    expect(asked.at(-1)).toEqual(expect.objectContaining({ noiseSuppression: true }));
    expect(dfn.attachedTo).toBeNull();
    expect(dtln.attachedTo).toBeNull();
    expect(dfn.released).toBeGreaterThan(0);
    expect(dtln.released).toBeGreaterThan(0);
    expect(live()).toEqual([voice.getMicStream()]);
    expect(changed).toHaveBeenLastCalledWith("browser");
  });

  it("a crash mid-call moves to the next model for the rest of the call", async () => {
    const { dfn, dtln, changed, startMic, internals } = setup();
    await startMic();
    // As join() wires it.
    dfn.onFatal((e) => (internals.handleDtlnFatal as Fatal).call(internals, e, "dfn3"));
    dfn.fatal!(new Error("DeepFilterNet3 cannot keep up (load 0.92)"));
    await vi.waitFor(() => expect(dtln.processed).toBe(1));
    expect(changed).toHaveBeenLastCalledWith("dtln", "DeepFilterNet3 cannot keep up (load 0.92)", false);

    // A device switch later in the same call stays on DTLN.
    await startMic();
    expect(dtln.processed).toBe(2);
    expect(dfn.processed).toBe(1);
  });

  it("a fallback lasts one call: the next join re-arms DeepFilterNet3", async () => {
    const { voice, internals, dfn, dtln, changed, startMic } = setup(fakeDenoiser(1));
    await startMic();
    expect(dtln.processed).toBe(1);
    voice.leave();

    joinable(internals);
    await voice.join("room");

    expect(dfn.processed).toBe(1);
    expect(changed).toHaveBeenCalledWith("dfn3");
    voice.leave();
  });

  it("choosing DTLN skips DeepFilterNet3 entirely", async () => {
    const { voice, dfn, dtln, startMic } = setup();
    await voice.setNoiseEngine("dtln");
    await vi.waitFor(() => expect(dtln.processed).toBe(1));
    await startMic();
    expect(dfn.loads).toBe(0);
    expect(dtln.processed).toBe(2);
  });

  it("a rebuilt model takes over the call only when the call runs on it", async () => {
    const { voice, internals, dfn, dtln, startMic } = setup();
    await startMic();
    await voice.reloadNoiseEngine("dfn3");
    expect(dfn.processed).toBe(2);
    expect(live()).toEqual([voice.getMicStream()]);

    await voice.reloadNoiseEngine("dtln");
    expect(dtln.loads).toBe(0);
    internals.audioCtx = null; // no call
    await voice.reloadNoiseEngine("dfn3");
    expect(dfn.processed).toBe(2);
  });

  describe("model loading state", () => {
    function watch(voice: ReturnType<typeof setup>["voice"]) {
      const states: boolean[] = [];
      voice.on("processingLoading", (loading) => states.push(loading));
      return states;
    }

    it("is on for exactly the wait on the model, through a fallback", async () => {
      const slow = deferred();
      const { voice, dfn, dtln, startMic } = setup(fakeDenoiser(1, slow.promise));
      const states = watch(voice);
      const run = startMic();
      await vi.waitFor(() => expect(dfn.loads).toBe(1));
      expect(states).toEqual([true]);

      slow.resolve();
      await run;
      // DFN3 failed, DTLN loaded: one wait each, and nothing left showing.
      expect(dtln.processed).toBe(1);
      expect(states).toEqual([true, false, true, false]);
    });

    it.each([
      ["switching suppression off", (v: ReturnType<typeof setup>["voice"]) => v.setDtlnEnabled(false)],
      ["leaving", (v: ReturnType<typeof setup>["voice"]) => v.leave()],
    ])("ends when %s abandons the load", async (_, abandon) => {
      const slow = deferred();
      const { voice, dfn, startMic } = setup(fakeDenoiser(0, slow.promise));
      const states = watch(voice);
      const run = startMic();
      await vi.waitFor(() => expect(dfn.loads).toBe(1));

      await abandon(voice);
      expect(states).toEqual([true, false]);
      slow.resolve();
      await run;
      expect(states).toEqual([true, false]);
    });
  });
});
