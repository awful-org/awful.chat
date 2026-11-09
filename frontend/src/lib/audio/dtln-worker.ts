import { DtlnProcessingBudget } from "./dtln-processing-budget";

/** Adapt the generated, unchanged worklet bundle to a non-realtime Worker. */
interface ModelProcessor {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: object): boolean;
}

const scope = globalThis as unknown as {
  sampleRate: number;
  AudioWorkletGlobalScope: object;
  AudioWorkletProcessor: unknown;
  registerProcessor: (name: string, processor: new () => ModelProcessor) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

scope.onmessage = async ({ data: { sampleRate, moduleUrl, port } }) => {
  const channel = port as MessagePort;
  try {
    let Model: (new () => ModelProcessor) | undefined;
    scope.sampleRate = sampleRate;
    scope.AudioWorkletGlobalScope = {};
    scope.AudioWorkletProcessor = class {
      port = {
        onmessage: null,
        postMessage: (message: unknown) => channel.postMessage(message),
      };
    };
    scope.registerProcessor = (_name, processor) => { Model = processor; };
    // The embedded WASM bundle already contains the resampler and model.
    // Its content-hashed URL retains the existing service-worker cache key.
    await import(/* @vite-ignore */ moduleUrl);
    if (!Model) throw new Error("DTLN model did not register");
    const model = new Model();
    let budget = new DtlnProcessingBudget();
    let guardEnabled = false;
    let overloaded = false;
    channel.onmessage = ({ data: message }) => {
      try {
        if (overloaded) return;
        if (typeof message.processingGuard === "boolean") {
          guardEnabled = message.processingGuard;
          budget = new DtlnProcessingBudget();
          return;
        }
        if (message.samples) {
          const samples = message.samples as Float32Array;
          // Preserve the model's original render quantum and resampler state.
          // In-place processing is safe: each quantum is read before output.
          const started = performance.now();
          for (let offset = 0; offset < samples.length; offset += 128) {
            const quantum = samples.subarray(offset, offset + 128);
            model.process([[quantum]], [[quantum]], {});
          }
          const processing = guardEnabled ? budget.sample(samples.length, sampleRate, performance.now() - started) : null;
          if (processing) {
            channel.postMessage({ processing });
            if (processing.overloaded) {
              overloaded = true;
              channel.postMessage({ fatal: `DTLN processing used ${Math.round(processing.load * 100)}% of its audio time budget; using browser suppression` });
              return;
            }
          }
          channel.postMessage({ samples, generation: message.generation }, [samples.buffer]);
        } else {
          model.port.onmessage?.({ data: message });
        }
      } catch (error) {
        channel.postMessage({ fatal: String(error) });
      }
    };
    channel.start();
  } catch (error) {
    channel.postMessage({ fatal: String(error) });
  }
};
