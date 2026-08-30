import { describe, expect, it, vi } from "vitest";
import { CallAudioMixer } from "./call-audio-mixer";

class NodeMock {
  connections: unknown[] = [];
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect(node: unknown) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
}

class SourceMock extends NodeMock {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

function context(duration = 1) {
  const destination = new NodeMock() as NodeMock & { stream: MediaStream };
  destination.stream = { getAudioTracks: () => [{ id: "stable" }] } as unknown as MediaStream;
  const sources: SourceMock[] = [];
  const gains: NodeMock[] = [];
  const ctx = {
    state: "running",
    destination: new NodeMock(),
    createMediaStreamDestination: () => destination,
    createDynamicsCompressor: () => new NodeMock(),
    createGain: () => {
      const gain = new NodeMock();
      gains.push(gain);
      return gain;
    },
    createMediaStreamSource: () => new NodeMock(),
    createBufferSource: () => {
      const source = new SourceMock();
      sources.push(source);
      return source;
    },
    decodeAudioData: vi.fn(async () => ({ duration })),
    resume: vi.fn(async () => undefined),
  } as unknown as AudioContext;
  return { ctx, sources, gains };
}

describe("CallAudioMixer", () => {
  it("keeps one stable output stream while microphone inputs change", () => {
    const { ctx } = context();
    const mixer = new CallAudioMixer(ctx);
    const stable = mixer.outputStream();
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    mixer.connectMicrophone(stream);
    mixer.connectMicrophone(stream);
    expect(mixer.outputStream()).toBe(stable);
  });

  it("plays one decoded source and stops it when another starts", async () => {
    const { ctx, sources } = context(2.5);
    const mixer = new CallAudioMixer(ctx);
    const blob = new Blob([new Uint8Array([1])]);
    const first = await mixer.play(blob);
    const second = await mixer.play(blob);
    expect(first.durationMs).toBe(2500);
    expect(second.id).not.toBe(first.id);
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[1].start).toHaveBeenCalledOnce();
  });

  it("accepts a clip exactly five seconds long", async () => {
    const { ctx, sources } = context(5);
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]))).resolves.toMatchObject({ durationMs: 5000 });
    expect(sources).toHaveLength(1);
  });

  it("applies the requested volume to outgoing and monitored sound", async () => {
    const { ctx, gains } = context();
    const mixer = new CallAudioMixer(ctx);
    await mixer.play(new Blob(["x"]), { volume: 0.25 });
    expect(gains[0].gain.value).toBe(0.2);
    expect(gains[1].gain.value).toBe(0.045);
  });

  it.each([-0.01, 1.01, Number.NaN])("rejects invalid volume %s", async (volume) => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]), { volume })).rejects.toThrow("between 0 and 1");
    expect(sources).toHaveLength(0);
  });

  it("rejects decoded clips even one millisecond over five seconds", async () => {
    const { ctx, sources } = context(5.001);
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]))).rejects.toThrow("5 second");
    expect(sources).toHaveLength(0);
  });

  it("stops active playback on dispose", async () => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    await mixer.play(new Blob(["x"]));
    mixer.dispose();
    expect(sources[0].stop).toHaveBeenCalledOnce();
  });
});
