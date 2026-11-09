/** Only buffers and transfers samples; the model runs on a dedicated Worker. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare const sampleRate: number;

const BATCH = 512;
const CAPACITY = BATCH * 32;

class DtlnBridge extends AudioWorkletProcessor {
  private workerPort: MessagePort | null = null;
  private input = new Float32Array(BATCH);
  private inputAt = 0;
  private spare: Float32Array<ArrayBuffer>[] = [];
  private pending = 0;
  private maxPending = Math.ceil(sampleRate * 0.085 / BATCH);
  private prebuffer = Math.ceil(sampleRate * 0.032 / BATCH) * BATCH;
  private generation = 0;
  private output = new Float32Array(CAPACITY);
  private readAt = 0;
  private writeAt = 0;
  private available = 0;
  private playing = false;
  private failed = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.workerPort) {
        this.workerPort = data.workerPort;
        this.workerPort!.onmessage = ({ data: reply }) => {
          if (reply.samples) {
            const samples = reply.samples as Float32Array<ArrayBuffer>;
            if (reply.generation !== this.generation) {
              this.spare.push(samples);
              return;
            }
            this.pending--;
            if (this.available + samples.length > CAPACITY) {
              this.fail("DTLN output queue overflow");
              return;
            }
            for (const sample of samples) {
              this.output[this.writeAt] = sample;
              this.writeAt = (this.writeAt + 1) % CAPACITY;
            }
            this.available += samples.length;
            this.spare.push(samples);
          } else {
            // Initialization and failures reach the existing main-thread owner.
            this.port.postMessage(reply);
          }
        };
        this.workerPort!.start();
      } else if (data.reset) {
        this.generation++;
        this.inputAt = 0;
        this.pending = 0;
        this.available = 0;
        this.readAt = 0;
        this.writeAt = 0;
        this.playing = false;
      } else {
        this.workerPort?.postMessage(data);
      }
    };
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.port.postMessage({ fatal: message });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (!input || !this.workerPort || this.failed) return true;

    for (const sample of input) {
      this.input[this.inputAt++] = sample;
      if (this.inputAt === BATCH) {
        // A stalled worker must not accumulate unbounded audio or latency.
        if (this.pending >= this.maxPending) {
          this.fail("DTLN worker cannot keep up with live audio");
          return true;
        }
        this.workerPort.postMessage({ samples: this.input, generation: this.generation }, [this.input.buffer]);
        this.pending++;
        this.input = this.spare.pop() ?? new Float32Array(BATCH);
        this.inputAt = 0;
      }
    }

    if (!this.playing && this.available >= this.prebuffer) this.playing = true;
    if (!this.playing) return true;
    if (this.available < output.length) {
      // The warm-up cushion was exhausted: prefer native suppression to
      // repeatedly emitting choppy speech on an overloaded machine.
      this.fail("DTLN worker ran out of processed audio");
      return true;
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.output[this.readAt];
      this.readAt = (this.readAt + 1) % CAPACITY;
    }
    this.available -= output.length;
    return true;
  }
}

registerProcessor("DtlnBridge", DtlnBridge);
