import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

class Port {
  onmessage: ((event: { data: any }) => void) | null = null;
  postMessage = vi.fn();
  start() {}
  receive(data: unknown) { this.onmessage?.({ data }); }
}
interface Bridge {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Bridge: new () => Bridge;
beforeAll(async () => {
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal("AudioWorkletProcessor", class { port = new Port(); });
  vi.stubGlobal("registerProcessor", (_name: string, processor: new () => Bridge) => { Bridge = processor; });
  await import("./dtln-bridge-worklet");
});
afterAll(() => vi.unstubAllGlobals());

function setup() {
  const bridge = new Bridge();
  const worker = new Port();
  bridge.port.receive({ workerPort: worker });
  const render = () => {
    const output = new Float32Array(128);
    expect(bridge.process([[new Float32Array(128).fill(0.25)]], [[output]])).toBe(true);
    return output;
  };
  return { bridge, worker, render };
}

describe("DTLN realtime bridge", () => {
  it("batches captured samples without doing model computation in the callback", () => {
    const { worker, render } = setup();
    for (let i = 0; i < 3; i++) expect(render().every(x => x === 0)).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
    render();
    const [message, transfers] = worker.postMessage.mock.calls[0];
    expect(message.samples).toHaveLength(512);
    expect(message.samples.every((x: number) => x === 0.25)).toBe(true);
    expect(transfers).toEqual([message.samples.buffer]);
  });

  it("buffers worker jitter and emits the processed samples in order", () => {
    const { worker, render } = setup();
    for (let i = 0; i < 12; i++) render();
    worker.receive({ generation: 0, samples: new Float32Array(512).fill(0.5) });
    worker.receive({ generation: 0, samples: new Float32Array(512).fill(0.75) });
    worker.receive({ generation: 0, samples: new Float32Array(512).fill(1) });
    for (const value of [0.5, 0.75, 1]) {
      for (let i = 0; i < 4; i++) expect(render().every(x => x === value)).toBe(true);
    }
  });

  it.each([44100, 48000, 96000])("keeps a time-based jitter cushion at %i Hz", (rate) => {
    vi.stubGlobal("sampleRate", rate);
    const { worker, render } = setup();
    vi.stubGlobal("sampleRate", 48000);
    const batches = Math.ceil(rate * 0.032 / 512);
    for (let i = 0; i < batches * 4; i++) render();
    for (let i = 0; i < batches - 1; i++) worker.receive({ generation: 0, samples: new Float32Array(512).fill(0.5) });
    expect(render().every(x => x === 0)).toBe(true);
    worker.receive({ generation: 0, samples: new Float32Array(512).fill(0.5) });
    expect(render().every(x => x === 0.5)).toBe(true);
  });

  it("bounds the input backlog and reports a stalled worker once", () => {
    const { bridge, worker, render } = setup();
    for (let i = 0; i < 48; i++) render();
    expect(worker.postMessage).toHaveBeenCalledTimes(8);
    expect(bridge.port.postMessage).toHaveBeenCalledExactlyOnceWith({ fatal: "DTLN worker cannot keep up with live audio" });
  });

  it("requests native fallback if a warmed output buffer runs dry", () => {
    const { bridge, worker, render } = setup();
    for (let i = 0; i < 12; i++) render();
    for (let i = 0; i < 3; i++) worker.receive({ generation: 0, samples: new Float32Array(512).fill(0.5) });
    for (let i = 0; i < 13; i++) render();
    expect(bridge.port.postMessage).toHaveBeenCalledExactlyOnceWith({ fatal: "DTLN worker ran out of processed audio" });
  });

  it("drops buffered and in-flight audio from a previous microphone session", () => {
    const { bridge, worker, render } = setup();
    for (let i = 0; i < 12; i++) render();
    worker.receive({ generation: 0, samples: new Float32Array(512).fill(1) });
    bridge.port.receive({ reset: true });
    for (let i = 0; i < 2; i++) worker.receive({ generation: 0, samples: new Float32Array(512).fill(1) });
    for (let i = 0; i < 12; i++) expect(render().every(x => x === 0)).toBe(true);
    for (let i = 0; i < 3; i++) worker.receive({ generation: 1, samples: new Float32Array(512).fill(0.5) });
    expect(render().every(x => x === 0.5)).toBe(true);
  });

  it("forwards readiness, model failures and gate changes between owners", () => {
    const { bridge, worker } = setup();
    worker.receive("ready");
    expect(bridge.port.postMessage).toHaveBeenCalledWith("ready");
    bridge.port.receive({ noise_gate: 0.003 });
    expect(worker.postMessage).toHaveBeenCalledWith({ noise_gate: 0.003 });
    worker.receive({ fatal: "model failed" });
    expect(bridge.port.postMessage).toHaveBeenCalledWith({ fatal: "model failed" });
  });
});
