import type { DeepFilterNetAudioWorkletHandle } from "@workadventure/noise-suppression/deepfilternet";
import type { MicDenoiser } from "./dtln-processor";

/** DeepFilterNet3 runs at this rate only (the package's DEEPFILTERNET_SAMPLE_RATE). */
const DFN_SAMPLE_RATE = 48000;

/**
 * The whole load, not just the model start: a first use downloads ~23 MB
 * (WASM and model; about 12 MB on the wire, the WASM gzipped to 4 MB and the
 * 8 MB model gzip already) before the node even exists, which the package's
 * own ready timeout does not cover, and join() waits on it before dialing
 * anyone. Same budget as DTLN's. The download carries on and the package
 * keeps it, so a slow first call falls back and a later one gets DFN3.
 */
const DFN_LOAD_TIMEOUT_MS = 15_000;

/** wasm-feature-detect's SIMD probe: the DFN3 build is compiled with simd128. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

/**
 * Why DFN3 cannot run here, answered before anything downloads; null when it
 * can. `hardwareRate` is a default AudioContext's rate. DFN3's context has to
 * run at 48 kHz, and on hardware at any other rate the browser would resample
 * at the MediaStreamAudioSourceNode boundary - the robotic voice that is why
 * DtlnProcessor's context runs at the hardware rate (see its init()).
 */
export function dfnUnsupportedReason(hardwareRate: number | undefined): string | null {
  if (typeof AudioWorkletNode === "undefined") return "this browser has no AudioWorklet";
  if (typeof WebAssembly !== "object" || !WebAssembly.validate(SIMD_PROBE)) {
    return "this browser has no WebAssembly SIMD";
  }
  if (hardwareRate !== DFN_SAMPLE_RATE) {
    return `the audio hardware runs at ${hardwareRate} Hz, not 48 kHz`;
  }
  return null;
}

interface Graph {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  dest: MediaStreamAudioDestinationNode;
}

/**
 * DeepFilterNet3 (@workadventure/noise-suppression) behind DtlnProcessor's
 * contract, with the same two graphs sharing one node:
 *
 *   transport: mic -> tx.gain -> node -> tx.dest (peers)
 *   monitor:   mic -> mon.gain -> node -> mon.dest (mic test)
 *
 * One node per context, kept for the context's life: the model's WASM memory
 * is only freed when the context closes. A failure retires the whole context.
 */
export class DfnProcessor implements MicDenoiser {
  private audioCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  /** The package reports once per node, after a minute of audio. */
  private processingLoad: number | null = null;
  private inputGain = 1.0;
  private fatalHandler: ((error: Error) => void) | null = null;
  private tx: Graph | null = null;
  private mon: Graph | null = null;

  /**
   * Lazy: neither the package nor its assets load before the first use. A
   * failed load is forgotten, so the next use (the next call) retries.
   */
  waitUntilReady(): Promise<void> {
    this.ready ??= this.init().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async init(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: DFN_SAMPLE_RATE });
    this.audioCtx = ctx;
    try {
      const handle = await new Promise<DeepFilterNetAudioWorkletHandle>(
        (resolve, reject) => {
          // Started before the import: a stalled chunk fetch is part of the load.
          const timeout = setTimeout(
            () => reject(new Error("DeepFilterNet3 load timeout")),
            DFN_LOAD_TIMEOUT_MS
          );
          import("@workadventure/noise-suppression/deepfilternet")
            .then(({ createDeepFilterNetAudioWorklet }) =>
              createDeepFilterNetAudioWorklet(ctx, {
                // The package keeps an overloaded node running. Audio that
                // crackles is no better than none, so this is fatal, as
                // DTLN's processing budget is.
                onOverload: (load) =>
                  this.handleFatal(
                    new Error(`DeepFilterNet3 cannot keep up (load ${load.toFixed(2)})`)
                  ),
                onLoadReport: (report) => {
                  this.processingLoad = report.medianLoad;
                },
              })
            )
            .then(async (dfn) => {
              await dfn.ready;
              return dfn;
            })
            .then(resolve, reject)
            .finally(() => clearTimeout(timeout));
        }
      );
      // The package stops listening once ready. From here on a crash, or an
      // error that leaves the node passing the raw mic through, is ours.
      handle.node.onprocessorerror = () =>
        this.handleFatal(new Error("DeepFilterNet3 processor crashed"));
      handle.node.port.addEventListener("message", this.onNodeMessage);
      this.node = handle.node;
    } catch (err) {
      this.discardContext();
      throw err;
    }
  }

  private onNodeMessage = ({ data }: MessageEvent) => {
    if (data?.type === "error") this.handleFatal(new Error(data.message));
  };

  private handleFatal(err: Error): void {
    console.error("[DFN3]", err);
    this.discardContext();
    this.ready = null;
    this.fatalHandler?.(err);
  }

  private discardContext(): void {
    this.release(this.tx);
    this.release(this.mon);
    this.tx = null;
    this.mon = null;
    // Detached first: an error or overload the retired node already queued
    // must not retire the context that replaces it, nor report twice.
    if (this.node) {
      this.node.onprocessorerror = null;
      this.node.port.removeEventListener("message", this.onNodeMessage);
      this.node.port.close();
    }
    this.node = null;
    this.processingLoad = null;
    const ctx = this.audioCtx;
    this.audioCtx = null;
    void ctx?.close().catch(() => {});
  }

  /** Set (or clear with null) the fatal callback. One slot: one caller owns it. */
  onFatal(handler: ((error: Error) => void) | null): void {
    this.fatalHandler = handler;
  }

  getProcessingLoad(): number | null {
    return this.processingLoad;
  }

  setInputGain(gain: number): void {
    this.inputGain = gain;
    if (this.tx) this.tx.gain.gain.value = gain;
  }

  async processStream(
    micStream: MediaStream,
    inputGain = this.inputGain
  ): Promise<MediaStream> {
    await this.waitUntilReady();
    // Replace only the previous transport graph - a running mic test keeps its own.
    this.releaseTransport();
    this.inputGain = inputGain;
    // A mic test monitoring right now keeps the peer-facing edge cut; its
    // cleanup reconnects it (see DtlnProcessor.processStream).
    const tx = (this.tx = this.connect(micStream, !this.mon));
    // Resume last, unconditionally: releaseTransport() above queued a suspend.
    await this.audioCtx?.resume();
    return tx.dest.stream;
  }

  releaseTransport(): void {
    this.release(this.tx);
    this.tx = null;
    this.suspendIfIdle();
  }

  /** Stop feeding peers during a mic test without dismantling the graph. */
  disconnectFromTransport(): void {
    if (!this.tx) return;
    try {
      this.node?.disconnect(this.tx.dest);
    } catch {}
  }

  reconnectToTransport(): void {
    if (this.tx) this.node?.connect(this.tx.dest);
  }

  async monitorStream(
    micStream: MediaStream
  ): Promise<{ processedStream: MediaStream; cleanup: () => void }> {
    await this.waitUntilReady();
    // Replace only a previous monitor graph - never touch the call's path.
    this.releaseMonitor();
    const mon = (this.mon = this.connect(micStream, true));
    await this.audioCtx?.resume();
    return {
      processedStream: mon.dest.stream,
      cleanup: () => this.releaseMonitor(),
    };
  }

  private releaseMonitor(): void {
    this.release(this.mon);
    this.mon = null;
    this.suspendIfIdle();
  }

  private connect(micStream: MediaStream, live: boolean): Graph {
    const ctx = this.audioCtx;
    const node = this.node;
    if (!ctx || !node) throw new Error("DeepFilterNet3 not initialized");
    const graph: Graph = {
      source: ctx.createMediaStreamSource(micStream),
      gain: ctx.createGain(),
      dest: ctx.createMediaStreamDestination(),
    };
    graph.gain.gain.value = this.inputGain;
    graph.source.connect(graph.gain);
    graph.gain.connect(node);
    if (live) node.connect(graph.dest);
    return graph;
  }

  private release(graph: Graph | null): void {
    if (!graph) return;
    graph.source.disconnect();
    graph.gain.disconnect();
    try {
      this.node?.disconnect(graph.dest);
    } catch {}
  }

  /** Nothing to render: let the audio thread stand down until the next use. */
  private suspendIfIdle(): void {
    if (!this.tx && !this.mon) void this.audioCtx?.suspend().catch(() => {});
  }
}
