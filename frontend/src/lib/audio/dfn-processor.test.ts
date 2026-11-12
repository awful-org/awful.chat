import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepFilterNetAudioWorkletOptions } from "@workadventure/noise-suppression/deepfilternet";

// The package is mocked: these tests are about how its outcomes map onto the
// processor's contract, and must never pull the real 14 MB WASM.
const pkg = vi.hoisted(() => ({
  create: null as
    | null
    | ((ctx: unknown, options: DeepFilterNetAudioWorkletOptions) => Promise<unknown>),
}));
const PKG = "@workadventure/noise-suppression/deepfilternet";
const mockPackage = () => ({
  createDeepFilterNetAudioWorklet: (ctx: unknown, options: DeepFilterNetAudioWorkletOptions) =>
    pkg.create!(ctx, options),
});
vi.mock("@workadventure/noise-suppression/deepfilternet", () => mockPackage());

import { DfnProcessor, dfnUnsupportedReason } from "./dfn-processor";

// Same minimal Web Audio fakes as dtln-processor.test.ts.
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
  async resume() {
    await Promise.resolve();
    this.state = "running";
  }
  async suspend() {
    await Promise.resolve();
    this.state = "suspended";
  }
  async close() {
    await Promise.resolve();
    this.state = "closed";
  }
  createMediaStreamSource() {
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
class FakeDfnNode extends FakeNode {
  onprocessorerror: (() => void) | null = null;
  listeners: ((e: { data: unknown }) => void)[] = [];
  port = {
    addEventListener: (_type: string, listener: (e: { data: unknown }) => void) =>
      this.listeners.push(listener),
    removeEventListener: (_type: string, listener: (e: { data: unknown }) => void) => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    },
    // Whether a closed port still delivers what it had queued is not leaned
    // on: only a removed listener is sure not to run.
    close: () => {},
    postMessage: () => {},
  };
  post(data: unknown) {
    this.listeners.forEach((l) => l({ data }));
  }
}

let contexts: FakeCtx[];
let contextOptions: unknown[];
let nodes: FakeDfnNode[];
let options: DeepFilterNetAudioWorkletOptions[];

/** The package resolving with a node whose `ready` settles as `ready()` says. */
function packageBuilds(ready: () => Promise<unknown> = async () => ({ type: "ready" })) {
  pkg.create = async (_ctx, opts) => {
    options.push(opts);
    const node = new FakeDfnNode();
    nodes.push(node);
    return { node, ready: ready(), dispose: () => {} };
  };
}

beforeEach(() => {
  contexts = [];
  contextOptions = [];
  nodes = [];
  options = [];
  (globalThis as any).AudioContext = function (opts: unknown) {
    contextOptions.push(opts);
    const ctx = new FakeCtx();
    contexts.push(ctx);
    return ctx;
  };
  packageBuilds();
});

afterEach(() => {
  vi.useRealTimers();
});

const micStream = {} as MediaStream;

describe("DfnProcessor loading", () => {
  it("builds nothing until first used, then one 48 kHz context and node", async () => {
    const d = new DfnProcessor();
    expect(contexts).toHaveLength(0);

    await d.waitUntilReady();
    await d.processStream(micStream);
    await d.monitorStream(micStream);

    expect(contextOptions).toEqual([{ sampleRate: 48000 }]);
    expect(nodes).toHaveLength(1);
  });

  it("a failed download rejects, closes its context, and a retry starts fresh", async () => {
    pkg.create = async () => {
      throw new Error("Failed to load df_bg.wasm: 404 Not Found");
    };
    const d = new DfnProcessor();

    await expect(d.waitUntilReady()).rejects.toThrow("404");
    await Promise.resolve();
    expect(contexts[0].state).toBe("closed");

    packageBuilds();
    await d.waitUntilReady();
    expect(contexts).toHaveLength(2);
  });

  it("a model that never gets ready rejects with the package's reason", async () => {
    packageBuilds(async () => {
      throw new Error("Timed out waiting for the DeepFilterNet3 worklet to initialize.");
    });
    const d = new DfnProcessor();

    await expect(d.waitUntilReady()).rejects.toThrow("Timed out");
    await Promise.resolve();
    expect(contexts[0].state).toBe("closed");
  });

  it("a download that stalls gives up instead of wedging the join", async () => {
    vi.useFakeTimers();
    pkg.create = () => new Promise(() => {});
    const d = new DfnProcessor();

    const ready = d.waitUntilReady();
    const settled = expect(ready).rejects.toThrow("load timeout");
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });

  it("the cap covers the package's own import, which can stall too", async () => {
    // The package's chunk never arrives.
    vi.resetModules();
    vi.doMock(PKG, () => new Promise(() => {}));
    try {
      const { DfnProcessor: Fresh } = await import("./dfn-processor");
      vi.useFakeTimers();
      const d = new Fresh();

      const settled = expect(d.waitUntilReady()).rejects.toThrow("load timeout");
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      await Promise.resolve();
      expect(contexts[0].state).toBe("closed");
    } finally {
      vi.doMock(PKG, () => mockPackage());
      vi.resetModules();
    }
  });

  it("feeds getProcessingLoad from the package's load report", async () => {
    const d = new DfnProcessor();
    await d.waitUntilReady();
    expect(d.getProcessingLoad()).toBeNull();

    options[0].onLoadReport!({
      windows: 30,
      medianLoad: 0.21,
      p95Load: 0.3,
      maxLoad: 0.4,
      slowFrames: 0,
      frames: 6000,
    });
    expect(d.getProcessingLoad()).toBe(0.21);
  });
});

describe("DfnProcessor fatal mapping", () => {
  const triggers: [string, () => void][] = [
    ["a processor crash", () => nodes[0].onprocessorerror!()],
    ["an error message", () => nodes[0].post({ type: "error", message: "unreachable" })],
    ["an overload", () => options[0].onOverload!(0.92)],
  ];

  it.each(triggers)("reports %s after init as fatal and retires the context", async (_name, fire) => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    const fatal = vi.fn();
    d.onFatal(fatal);

    fire();

    expect(fatal).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(contexts[0].state).toBe("closed");

    // The next use rebuilds on a fresh context rather than the dead one.
    await d.processStream(micStream);
    expect(contexts).toHaveLength(2);
    expect(nodes).toHaveLength(2);
  });

  it("a retired node's late error neither retires its successor nor reports twice", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    const fatal = vi.fn();
    d.onFatal(fatal);
    const retired = nodes[0];
    retired.onprocessorerror!();
    await d.processStream(micStream);

    // An error the old node had already queued arrives after its successor exists.
    retired.post({ type: "error", message: "unreachable" });

    expect(fatal).toHaveBeenCalledTimes(1);
    expect(retired.onprocessorerror).toBeNull();
    await Promise.resolve();
    expect(contexts[1].state).toBe("running");
  });

  it("ignores the node's other messages", async () => {
    const d = new DfnProcessor();
    await d.waitUntilReady();
    const fatal = vi.fn();
    d.onFatal(fatal);

    nodes[0].post({ type: "load-report", medianLoad: 0.1 });
    nodes[0].post({ type: "ready", frameSamples: 480 });

    expect(fatal).not.toHaveBeenCalled();
  });
});

describe("DfnProcessor graph wiring", () => {
  it("a mic test shares the node and does not tear down the call's path", async () => {
    const d = new DfnProcessor();
    const callStream = await d.processStream(micStream);
    const ctx = contexts[0];
    const node = nodes[0];
    const [callSource] = ctx.sources;
    const [callGain] = ctx.gains;
    const [callDest] = ctx.dests;
    expect(callDest.stream).toBe(callStream);
    expect(callSource.isConnectedTo(callGain)).toBe(true);
    expect(callGain.isConnectedTo(node)).toBe(true);
    expect(node.isConnectedTo(callDest)).toBe(true);

    d.disconnectFromTransport();
    const { cleanup } = await d.monitorStream(micStream);
    const monDest = ctx.dests[1];
    expect(node.isConnectedTo(monDest)).toBe(true);
    // Peers do not hear the test...
    expect(node.isConnectedTo(callDest)).toBe(false);

    cleanup();
    d.reconnectToTransport();
    // ...and get the call back once it ends.
    expect(node.isConnectedTo(monDest)).toBe(false);
    expect(callGain.isConnectedTo(node)).toBe(true);
    expect(node.isConnectedTo(callDest)).toBe(true);
  });

  it("keeps peers muted when the mic is rebuilt mid-test", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    d.disconnectFromTransport();
    await d.monitorStream(micStream);

    await d.processStream(micStream);
    const node = nodes[0];
    const newDest = contexts[0].dests[contexts[0].dests.length - 1];
    expect(node.isConnectedTo(newDest)).toBe(false);
  });

  it("applies input gain before the model, live", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream, 1.5);
    const [gain] = contexts[0].gains;
    expect(gain.gain.value).toBe(1.5);
    d.setInputGain(0.5);
    expect(gain.gain.value).toBe(0.5);
  });

  it("suspends once both graphs are released", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    const { cleanup } = await d.monitorStream(micStream);

    d.releaseTransport();
    await Promise.resolve();
    expect(contexts[0].state).toBe("running");

    cleanup();
    await Promise.resolve();
    expect(contexts[0].state).toBe("suspended");
  });
});

describe("DfnProcessor strength", () => {
  const strength = (o: DeepFilterNetAudioWorkletOptions) => [o.speechAttenuationDb, o.pauseAttenuationDb];

  it("builds the node with the package's defaults, or the values set before first use", async () => {
    await new DfnProcessor().waitUntilReady();
    const d = new DfnProcessor();
    // Nothing built yet: nothing to retire.
    expect(d.setAttenuation(12, 30)).toBe(false);
    await d.waitUntilReady();

    expect(options.map(strength)).toEqual([[25, 45], [12, 30]]);
  });

  it("new values retire the node with its context and graphs; the next use builds one with them", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    await d.monitorStream(micStream);
    const fatal = vi.fn();
    d.onFatal(fatal);
    const [callGain] = contexts[0].gains;

    expect(d.setAttenuation(10, 40)).toBe(true);
    await Promise.resolve();
    expect(contexts[0].state).toBe("closed");
    expect(callGain.isConnectedTo(nodes[0])).toBe(false);
    // Not a failure: nobody is told the model died.
    nodes[0].post({ type: "error", message: "late" });
    expect(fatal).not.toHaveBeenCalled();

    await d.processStream(micStream);
    expect(contexts).toHaveLength(2);
    expect(strength(options[1])).toEqual([10, 40]);
  });

  it("the same values change nothing", async () => {
    const d = new DfnProcessor();
    await d.processStream(micStream);
    expect(d.setAttenuation(25, 45)).toBe(false);
    expect(contexts[0].state).toBe("running");
  });

  it("keeps both in range, pauses above speech", () => {
    const d = new DfnProcessor();
    d.setAttenuation(80, 20);
    expect(d.getAttenuation()).toEqual({ speechDb: 40, pauseDb: 43 });
    d.setAttenuation(1, 99);
    expect(d.getAttenuation()).toEqual({ speechDb: 6, pauseDb: 60 });
    d.setAttenuation(20, 21);
    expect(d.getAttenuation()).toEqual({ speechDb: 20, pauseDb: 23 });
  });
});

describe("dfnUnsupportedReason", () => {
  afterEach(() => {
    delete (globalThis as any).AudioWorkletNode;
    vi.restoreAllMocks();
  });

  it("needs 48 kHz hardware, AudioWorklet and SIMD, and names the one missing", () => {
    (globalThis as any).AudioWorkletNode = class {};
    expect(dfnUnsupportedReason(48000)).toBeNull();
    expect(dfnUnsupportedReason(44100)).toMatch(/44100 Hz, not 48 kHz/);
    expect(dfnUnsupportedReason(undefined)).not.toBeNull();

    vi.spyOn(WebAssembly, "validate").mockReturnValue(false);
    expect(dfnUnsupportedReason(48000)).toMatch(/SIMD/);
    vi.restoreAllMocks();

    delete (globalThis as any).AudioWorkletNode;
    expect(dfnUnsupportedReason(48000)).toMatch(/AudioWorklet/);
  });
});
