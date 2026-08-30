import { AUDIO_PREF_DEFAULTS } from "$lib/transport/audio-prefs";
import { WORKLET_URL } from "./worklet-url";

export interface DtlnMessage {
  noise_gate?: number;
}

export class DtlnProcessor {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ready = false;
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private initializing = false;
  private noiseGate = AUDIO_PREF_DEFAULTS.noiseGate;
  private inputGain = 1.0;
  /**
   * Told once when the worklet dies after init (finding 1 of the voice
   * audit): RTP keeps flowing on a track fed by a suspended context - the
   * sender transmits digital silence forever, with connectionState reading
   * "connected" on both ends the whole time. LibP2PVoice uses this to
   * rebuild the mic instead of leaving that peer permanently unheard.
   */
  private fatalHandler: (() => void) | null = null;

  /**
   * The one compensation for the model's attenuation. The worklet itself is
   * unity gain, so this constant is the only boost in the chain.
   */
  static readonly OUTPUT_COMPENSATION = 3.0;

  // Two independent graphs share the single DTLN worklet node:
  //
  //   transport: mic -> txInputGain -> worklet -> txOutputGain -> dest (peers)
  //   monitor:   mic -> monGain -> worklet -> monOutGain -> dest (speakers)
  //
  // They are tracked separately so a mic test can never tear down the audio
  // path of a live call (and vice versa).
  private txSource: MediaStreamAudioSourceNode | null = null;
  private txInputGain: GainNode | null = null;
  private txOutputGain: GainNode | null = null;
  private transportDest: MediaStreamAudioDestinationNode | null = null;

  private monSource: MediaStreamAudioSourceNode | null = null;
  private monGain: GainNode | null = null;
  private monOutGain: GainNode | null = null;
  private monDest: MediaStreamAudioDestinationNode | null = null;

  constructor() {
    this.armReadyPromise();
  }

  private armReadyPromise(): void {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Nobody may be awaiting at the moment init fails; that must not surface
    // as an unhandled rejection.
    this.readyPromise.catch(() => {});
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initializing) return this.readyPromise;
    this.initializing = true;

    try {
      // Create context (it will start 'suspended' if no user gesture).
      //
      // At the HARDWARE rate, never { sampleRate: 16000 }. The worklet
      // carries its own resampler - it reads the context rate, anti-alias
      // filters, feeds the model at 16k and upsamples the result back - so a
      // 16k context turned that into dead code (ratio 1) and pushed the
      // resampling to the browser's MediaStreamAudioSourceNode boundary
      // instead, whose behaviour in a context that doesn't match the mic's
      // native rate is glitchy on some platforms (Linux/PipeWire worst).
      // That was the "my voice is robotic for everyone else when I enable
      // DTLN" that only some machines produced. Native rate also means the
      // track handed to Opus is wideband instead of a 16k narrowband one.
      this.audioCtx ??= new AudioContext();

      await this.audioCtx.audioWorklet.addModule(WORKLET_URL);

      const node = new AudioWorkletNode(
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
        // The worklet posts "ready" once its WASM runtime is up and the
        // denoiser exists; a processor that crashes instead rejects in
        // milliseconds rather than eating the whole timeout.
        const timeout = setTimeout(
          () => reject(new Error("DTLN ready timeout")),
          15000
        );
        node.onprocessorerror = () => {
          clearTimeout(timeout);
          reject(new Error("DTLN processor crashed during init"));
        };
        node.port.onmessage = (event) => {
          if (event.data === "ready") {
            clearTimeout(timeout);
            resolve();
          }
        };
      });

      node.onprocessorerror = () =>
        this.handleFatal(new Error("DTLN processor crashed"));
      this.workletNode = node;
      this.ready = true;
      node.port.postMessage({
        noise_gate: this.noiseGate,
      } satisfies DtlnMessage);
      this.resolveReady();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.initializing = false;
      this.rejectReady(e);
      // Re-arm so a later voice start can retry instead of seeing the same
      // stale rejection forever (e.g. first visit offline, then back online).
      this.armReadyPromise();
      throw e;
    }
    this.initializing = false;
  }

  /**
   * A processor that dies after init would otherwise be a silent zombie for
   * the rest of the session. Drop it so the next voice start rebuilds.
   */
  private handleFatal(err: Error): void {
    console.error("[DTLN]", err);
    this.releaseTransport();
    this.releaseMonitor();
    this.workletNode = null;
    this.ready = false;
    this.initializing = false;
    this.armReadyPromise();
    this.fatalHandler?.();
  }

  /** Set (or clear with null) the fatal callback. One slot: one caller owns it. */
  onFatal(handler: (() => void) | null): void {
    this.fatalHandler = handler;
  }

  /**
   * Resolves once the worklet is usable, rejecting if it cannot be loaded.
   * Also the lazy entry point: nothing pays for the 8 MB worklet until the
   * first voice use calls this.
   */
  waitUntilReady(): Promise<void> {
    // Snapshot first: a synchronously-failing init() rejects and re-arms
    // readyPromise before this function returns, and the caller must get
    // the rejected one, not the fresh forever-pending one.
    const p = this.readyPromise;
    if (!this.ready && !this.initializing) void this.init().catch(() => {});
    return p;
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

  /**
   * Mic gain, applied before the model.
   *
   * Remembered, and applied to the live node: the slider used to drive the
   * worklet's own output gain while dragging but this node when the mic was
   * rebuilt, so the same slider position meant two different loudnesses
   * depending on when you last restarted the mic - and a gain restored on
   * startup, before the worklet exists, was dropped entirely.
   */
  setInputGain(gain: number): void {
    this.inputGain = gain;
    if (this.txInputGain) this.txInputGain.gain.value = gain;
  }

  getInputGain(): number {
    return this.inputGain;
  }

  setNoiseGate(threshold: number): void {
    // Remembered so a threshold set before the worklet exists (restored on
    // startup, while init() is still running) is not silently dropped.
    this.noiseGate = threshold;
    this.workletNode?.port.postMessage({ noise_gate: threshold });
  }

  getNoiseGate(): number {
    return this.noiseGate;
  }

  // connect a mic stream through DTLN, returns the processed MediaStream
  async processStream(
    micStream: MediaStream,
    inputGain = this.inputGain
  ): Promise<MediaStream> {
    await this.waitUntilReady();
    const ctx = this.ctx;

    // Replace only the previous transport graph - a running mic test keeps its own.
    this.releaseTransport();

    const source = ctx.createMediaStreamSource(micStream);
    const inputGainNode = ctx.createGain();
    const outputGainNode = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();

    // Set initial gain values
    this.inputGain = inputGain;
    inputGainNode.gain.value = inputGain;
    outputGainNode.gain.value = DtlnProcessor.OUTPUT_COMPENSATION;

    source.connect(inputGainNode);
    inputGainNode.connect(this.node);
    this.node.connect(outputGainNode);
    // If a mic test is monitoring right now, leave the peer-facing edge cut:
    // the test's cleanup reconnects it, so rebuilding the mic mid-test does
    // not start broadcasting the test to the call.
    if (!this.monDest) outputGainNode.connect(dest);

    this.txSource = source;
    this.txInputGain = inputGainNode;
    this.txOutputGain = outputGainNode;
    this.transportDest = dest;

    // Resume last, unconditionally: releaseTransport() above queues a
    // suspend whose state change lands asynchronously, so ctx.state still
    // reads "running" here. Control messages process in order - a resume
    // queued now overrides it, and is a no-op on a running context.
    await ctx.resume();
    return dest.stream;
  }

  /**
   * Tear the peer-facing graph down entirely. Call when rebuilding the mic,
   * when DTLN is switched off, or when a call ends, so the worklet stops
   * chewing CPU on a dead mic.
   */
  releaseTransport(): void {
    this.txSource?.disconnect();
    this.txInputGain?.disconnect();
    this.txOutputGain?.disconnect();
    if (this.txOutputGain && this.workletNode) {
      try {
        this.workletNode.disconnect(this.txOutputGain);
      } catch {}
    }
    this.txSource = null;
    this.txInputGain = null;
    this.txOutputGain = null;
    this.transportDest = null;
    this.suspendIfIdle();
  }

  /**
   * Temporarily stop feeding peers without dismantling the graph, so a mic
   * test is not broadcast to everyone in the call. The cut is made at
   * outputGain -> dest, which is the edge that actually exists.
   */
  disconnectFromTransport(): void {
    if (!this.txOutputGain || !this.transportDest) return;
    try {
      this.txOutputGain.disconnect(this.transportDest);
    } catch {}
  }

  reconnectToTransport(): void {
    if (!this.txOutputGain || !this.transportDest) return;
    try {
      this.txOutputGain.connect(this.transportDest);
    } catch {}
  }

  // for mic test - connect to speakers directly so user can hear themselves
  async monitorStream(
    micStream: MediaStream
  ): Promise<{ processedStream: MediaStream; cleanup: () => void }> {
    await this.waitUntilReady();
    const ctx = this.ctx;

    // Replace only a previous monitor graph - never touch the call's path.
    this.releaseMonitor();

    const source = ctx.createMediaStreamSource(micStream);
    const gain = ctx.createGain();
    // Mirror the transport chain (input gain, model, compensation) so the
    // test plays what peers actually hear - it previewed a flat 1x while the
    // call path boosted, which made every gain complaint harder to place.
    gain.gain.value = this.inputGain;
    const outGain = ctx.createGain();
    outGain.gain.value = DtlnProcessor.OUTPUT_COMPENSATION;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(this.node);
    this.node.connect(outGain);
    outGain.connect(dest);

    this.monSource = source;
    this.monGain = gain;
    this.monOutGain = outGain;
    this.monDest = dest;

    // Resume last, unconditionally - releaseMonitor() above may have queued
    // a suspend whose state change has not landed yet (see processStream).
    await ctx.resume();

    return {
      processedStream: dest.stream,
      cleanup: () => this.releaseMonitor(),
    };
  }

  private releaseMonitor(): void {
    this.monSource?.disconnect();
    this.monGain?.disconnect();
    // The worklet now feeds monOutGain (not dest directly); detach that edge
    // or every mic test leaves another dangling branch on the shared worklet.
    if (this.monOutGain && this.workletNode) {
      try {
        this.workletNode.disconnect(this.monOutGain);
      } catch {}
    }
    this.monOutGain?.disconnect();
    this.monSource = null;
    this.monGain = null;
    this.monOutGain = null;
    this.monDest = null;
    this.suspendIfIdle();
  }

  /**
   * With no call and no mic test the context has nothing to render - suspend
   * it so the audio thread and the OS audio stream stand down instead of
   * ticking for the rest of the session. Resumed on the next use.
   */
  private suspendIfIdle(): void {
    if (!this.txSource && !this.monSource) {
      void this.audioCtx?.suspend().catch(() => {});
    }
  }
}
