const MAX_CALL_SOUND_SECONDS = 5;

export interface CallSoundPlayback {
  id: string;
  durationMs: number;
}

/** Owns the one stable outgoing call track. Microphone rebuilds reconnect
 * behind it; intentional clips enter after noise suppression. */
export class CallAudioMixer {
  private destination: MediaStreamAudioDestinationNode;
  private limiter: DynamicsCompressorNode;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private soundSource: AudioBufferSourceNode | null = null;
  private soundGain: GainNode;
  private monitorGain: GainNode;
  private activeId: string | null = null;
  private sequence = 0;

  constructor(private context: AudioContext) {
    this.destination = context.createMediaStreamDestination();
    this.limiter = context.createDynamicsCompressor();
    this.soundGain = context.createGain();
    this.monitorGain = context.createGain();
    this.soundGain.gain.value = 0.8;
    this.monitorGain.gain.value = 0.18;
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.destination);
    this.soundGain.connect(this.limiter);
    this.monitorGain.connect(context.destination);
  }

  outputStream(): MediaStream {
    return this.destination.stream;
  }

  connectMicrophone(stream: MediaStream | null): void {
    this.microphoneSource?.disconnect();
    this.microphoneSource = null;
    if (!stream || stream.getAudioTracks().length === 0) return;
    this.microphoneSource = this.context.createMediaStreamSource(stream);
    this.microphoneSource.connect(this.limiter);
  }

  async play(blob: Blob, options?: { volume?: number }): Promise<CallSoundPlayback> {
    const volume = options?.volume ?? 1;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new Error("Sound volume must be between 0 and 1");
    }
    if (this.context.state === "suspended") await this.context.resume();
    const encoded = await blob.arrayBuffer();
    const buffer = await this.context.decodeAudioData(encoded.slice(0));
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error("Sound is empty");
    }
    if (buffer.duration > MAX_CALL_SOUND_SECONDS) {
      throw new Error("Sound exceeds the 5 second call limit");
    }

    this.stop();
    this.soundGain.gain.value = 0.8 * volume;
    this.monitorGain.gain.value = 0.18 * volume;
    const source = this.context.createBufferSource();
    const id = `call-sound-${Date.now()}-${this.sequence++}`;
    source.buffer = buffer;
    source.connect(this.soundGain);
    source.connect(this.monitorGain);
    source.onended = () => {
      if (this.activeId !== id) return;
      source.disconnect();
      this.soundSource = null;
      this.activeId = null;
    };
    this.soundSource = source;
    this.activeId = id;
    source.start();
    return { id, durationMs: Math.round(buffer.duration * 1000) };
  }

  stop(id?: string): void {
    if (!this.soundSource || (id && id !== this.activeId)) return;
    const source = this.soundSource;
    this.soundSource = null;
    this.activeId = null;
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
  }

  dispose(): void {
    this.stop();
    this.microphoneSource?.disconnect();
    this.microphoneSource = null;
    this.soundGain.disconnect();
    this.monitorGain.disconnect();
    this.limiter.disconnect();
  }
}
