export interface DtlnMessage {
  output_gain?: number;
  noise_gate?: number;
}

export class DtlnProcessor {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ready = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private initializing = false;

  constructor() {
    this.readyPromise = new Promise((r) => (this.resolveReady = r));
    console.log("DtlnProcessor created");
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initializing) return this.readyPromise;
    this.initializing = true;

    // Create context (it will start 'suspended' if no user gesture)
    this.audioCtx = new AudioContext({ sampleRate: 16000 });

    await this.audioCtx.audioWorklet.addModule("/audio-worklet.js");

    this.workletNode = new AudioWorkletNode(
      this.audioCtx,
      "NoiseSuppressionWorker",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("DTLN ready timeout")),
        15000
      );

      this.workletNode!.port.onmessage = (event) => {
        if (event.data === "ready") {
          clearTimeout(timeout);
          this.workletNode!.port.onmessage = (e) =>
            this.handleWorkletMessage(e);
          resolve();
        }
      };
    });

    this.ready = true;
    this.resolveReady();
  }

  private handleWorkletMessage(event: MessageEvent): void {
    console.log("Message from DTLN worklet:", event.data);
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  get ctx(): AudioContext {
    if (!this.audioCtx) throw new Error("DtlnProcessor not initialized");
    return this.audioCtx;
  }

  get node(): AudioWorkletNode {
    if (!this.workletNode) throw new Error("DtlnProcessor not initialized");
    return this.workletNode;
  }

  setGain(gain: number): void {
    this.workletNode?.port.postMessage({ output_gain: gain });
  }

  setNoiseGate(threshold: number): void {
    this.workletNode?.port.postMessage({ noise_gate: threshold });
  }

  // connect a mic stream through DTLN, returns the processed MediaStream
  async processStream(micStream: MediaStream): Promise<MediaStream> {
    await this.waitUntilReady();
    const ctx = this.ctx;
    // without user gesture it will start suspended
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    this.setGain(1.0);
    const source = ctx.createMediaStreamSource(micStream);
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();

    source.connect(gain);
    gain.connect(this.node);
    this.node.connect(dest);

    return dest.stream;
  }

  // for mic test - connect to speakers directly so user can hear themselves
  async monitorStream(micStream: MediaStream): Promise<() => void> {
    await this.waitUntilReady();
    const ctx = this.ctx;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    this.setGain(1.0);
    const source = ctx.createMediaStreamSource(micStream);
    const gain = ctx.createGain();

    source.connect(gain);
    gain.connect(this.node);
    this.node.connect(ctx.destination);

    return () => {
      source.disconnect();
      gain.disconnect();
      this.node.disconnect(ctx.destination);
    };
  }
}
