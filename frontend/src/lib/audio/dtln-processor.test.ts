import { beforeEach, describe, expect, it } from "vitest";
import { DtlnProcessor } from "./dtln-processor";

// Minimal Web Audio fakes: enough to observe how the graph is wired, which is
// the part that actually breaks (a mic test must not sever a live call's path).
class FakeNode {
  outputs = new Set<FakeNode>();
  connect(dst: FakeNode) {
    this.outputs.add(dst);
    return dst;
  }
  disconnect(dst?: FakeNode) {
    if (!dst) {
      this.outputs.clear();
      return;
    }
    // Real nodes throw when the edge does not exist - mimic that so the code
    // under test has to target the edge that really is there.
    if (!this.outputs.has(dst)) throw new Error("InvalidAccessError");
    this.outputs.delete(dst);
  }
  isConnectedTo(dst: FakeNode) {
    return this.outputs.has(dst);
  }
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
}
class FakeDest extends FakeNode {
  stream = { id: Math.random().toString(36).slice(2) } as unknown as MediaStream;
}

class FakeCtx {
  state = "running";
  gains: FakeGain[] = [];
  dests: FakeDest[] = [];
  sources: FakeNode[] = [];
  audioWorklet = { addModule: async () => {} };
  // Real contexts flip `state` in a queued task, never synchronously - the
  // suspend-vs-resume ordering bugs only exist under that timing model.
  async resume() {
    await Promise.resolve();
    this.state = "running";
  }
  async suspend() {
    await Promise.resolve();
    this.state = "suspended";
  }
  createMediaStreamSource(_s: MediaStream) {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createMediaStreamDestination() {
    const d = new FakeDest();
    this.dests.push(d);
    return d;
  }
}

class FakeWorkletNode extends FakeNode {
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: () => {},
  };
  constructor() {
    super();
    // The processor waits for a "ready" message before resolving init().
    setTimeout(() => this.port.onmessage?.({ data: "ready" }), 0);
  }
}

let ctx: FakeCtx;

async function makeProcessor(): Promise<DtlnProcessor> {
  ctx = new FakeCtx();
  (globalThis as any).AudioContext = function () {
    return ctx;
  };
  (globalThis as any).AudioWorkletNode = FakeWorkletNode;
  const d = new DtlnProcessor();
  await d.init();
  return d;
}

const micStream = {} as MediaStream;

describe("DtlnProcessor graph wiring", () => {
  beforeEach(() => {
    ctx = new FakeCtx();
  });

  it("routes the mic through the worklet to the peer-facing destination", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);

    const [source] = ctx.sources;
    const [inputGain, outputGain] = ctx.gains;
    const [dest] = ctx.dests;
    const worklet = d.node as unknown as FakeNode;

    expect(source.isConnectedTo(inputGain)).toBe(true);
    expect(inputGain.isConnectedTo(worklet)).toBe(true);
    expect(worklet.isConnectedTo(outputGain)).toBe(true);
    expect(outputGain.isConnectedTo(dest)).toBe(true);
  });

  it("a mic test does not tear down a live call's audio path", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    const [callSource] = ctx.sources;
    const [callInputGain, callOutputGain] = ctx.gains;
    const [callDest] = ctx.dests;
    const worklet = d.node as unknown as FakeNode;

    const { cleanup } = await d.monitorStream(micStream);

    // Call path survives the monitor being built...
    expect(callSource.isConnectedTo(callInputGain)).toBe(true);
    expect(callInputGain.isConnectedTo(worklet)).toBe(true);
    expect(worklet.isConnectedTo(callOutputGain)).toBe(true);
    expect(callOutputGain.isConnectedTo(callDest)).toBe(true);

    // ...and survives it being torn down.
    cleanup();
    expect(callSource.isConnectedTo(callInputGain)).toBe(true);
    expect(worklet.isConnectedTo(callOutputGain)).toBe(true);
    expect(callOutputGain.isConnectedTo(callDest)).toBe(true);

    // The monitor's own destination is gone.
    const monitorDest = ctx.dests[1];
    expect(worklet.isConnectedTo(monitorDest)).toBe(false);
  });

  it("mutes peers during a mic test and restores them afterwards", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    const [, outputGain] = ctx.gains;
    const [dest] = ctx.dests;

    d.disconnectFromTransport();
    expect(outputGain.isConnectedTo(dest)).toBe(false);

    d.reconnectToTransport();
    expect(outputGain.isConnectedTo(dest)).toBe(true);
  });

  it("keeps peers muted when the mic is rebuilt mid-test", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    d.disconnectFromTransport();
    const { cleanup } = await d.monitorStream(micStream);

    // e.g. the user switches input device while the test is running
    await d.processStream(micStream);
    const newOutputGain = ctx.gains[ctx.gains.length - 1];
    const newDest = ctx.dests[ctx.dests.length - 1];
    expect(newOutputGain.isConnectedTo(newDest)).toBe(false);

    cleanup();
    d.reconnectToTransport();
    expect(newOutputGain.isConnectedTo(newDest)).toBe(true);
  });

  it("releaseTransport detaches the whole peer-facing chain", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    const [source] = ctx.sources;
    const [inputGain, outputGain] = ctx.gains;
    const [dest] = ctx.dests;
    const worklet = d.node as unknown as FakeNode;

    d.releaseTransport();

    expect(source.outputs.size).toBe(0);
    expect(inputGain.outputs.size).toBe(0);
    expect(outputGain.isConnectedTo(dest)).toBe(false);
    expect(worklet.isConnectedTo(outputGain)).toBe(false);
    // Idempotent - a second call (e.g. call ends after DTLN was toggled off)
    // must not throw.
    expect(() => d.releaseTransport()).not.toThrow();
  });

  it("replacing the mic does not leak the previous graph", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    const [firstSource] = ctx.sources;
    const [firstInputGain, firstOutputGain] = ctx.gains;
    const [firstDest] = ctx.dests;

    await d.processStream(micStream);

    expect(firstSource.outputs.size).toBe(0);
    expect(firstInputGain.outputs.size).toBe(0);
    expect(firstOutputGain.isConnectedTo(firstDest)).toBe(false);
  });
});

describe("DtlnProcessor lifecycle", () => {
  it("suspends the context once both graphs are released, resumes on reuse", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    expect(ctx.state).toBe("running");

    d.releaseTransport();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe("suspended");

    await d.processStream(micStream);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe("running");
  });

  it("rebuilding the mic mid-call leaves the context running", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    // e.g. the user switches input device during a call: processStream
    // releases the old graph (queuing a suspend) and rebuilds - the fresh
    // graph must not end up on a suspended context.
    await d.processStream(micStream);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe("running");
  });

  it("does not suspend while a mic test still monitors", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    await d.monitorStream(micStream);

    d.releaseTransport();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe("running");
  });

  it("a synchronous init failure still rejects waitUntilReady", async () => {
    (globalThis as any).AudioContext = function () {
      throw new Error("no 16 kHz context");
    };
    (globalThis as any).AudioWorkletNode = FakeWorkletNode;
    const d = new DtlnProcessor();

    await expect(d.waitUntilReady()).rejects.toThrow("no 16 kHz context");
  });

  it("a failed init rejects waitUntilReady, and a later retry can succeed", async () => {
    ctx = new FakeCtx();
    let fail = true;
    ctx.audioWorklet = {
      addModule: async () => {
        if (fail) throw new Error("offline");
      },
    };
    (globalThis as any).AudioContext = function () {
      return ctx;
    };
    (globalThis as any).AudioWorkletNode = FakeWorkletNode;
    const d = new DtlnProcessor();

    // The old code left this promise pending forever, wedging join().
    await expect(d.waitUntilReady()).rejects.toThrow("offline");
    expect(d.isReady()).toBe(false);

    fail = false;
    await d.waitUntilReady();
    expect(d.isReady()).toBe(true);
  });

  it("a processor crash during init rejects instead of eating the timeout", async () => {
    ctx = new FakeCtx();
    (globalThis as any).AudioContext = function () {
      return ctx;
    };
    class CrashingWorkletNode extends FakeNode {
      onprocessorerror: (() => void) | null = null;
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: () => {},
      };
      constructor() {
        super();
        // Never posts "ready" - dies instead.
        setTimeout(() => this.onprocessorerror?.(), 0);
      }
    }
    (globalThis as any).AudioWorkletNode = CrashingWorkletNode;
    const d = new DtlnProcessor();

    await expect(d.waitUntilReady()).rejects.toThrow("crashed during init");
  });
});

interface CrashableWorklet {
  onprocessorerror: () => void;
}

describe("DtlnProcessor fatal callback (finding 1)", () => {
  it("calls the registered handler when the worklet crashes after init", async () => {
    const d = await makeProcessor();
    await d.processStream(micStream);
    let fatalCalls = 0;
    d.onFatal(() => {
      fatalCalls++;
    });

    // init() rewires node.onprocessorerror to handleFatal once the worklet
    // is up - this is the browser firing it on a LIVE worklet, not the
    // init-time crash the other tests cover.
    const worklet = d.node as unknown as CrashableWorklet;
    worklet.onprocessorerror();

    expect(fatalCalls).toBe(1);
    expect(d.isReady()).toBe(false);
  });

  it("onFatal(null) clears a previously registered handler", async () => {
    const d = await makeProcessor();
    let fatalCalls = 0;
    d.onFatal(() => {
      fatalCalls++;
    });
    d.onFatal(null);

    const worklet = d.node as unknown as CrashableWorklet;
    worklet.onprocessorerror();

    expect(fatalCalls).toBe(0);
  });
});
