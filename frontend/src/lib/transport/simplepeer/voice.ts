import type {
  PeerTransport,
  SimplePeerExtension,
  VoiceTransport,
  VoiceEvents,
} from "../types";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

interface RemotePeer {
  stream: MediaStream;
  audio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
}

/**
 * SimplePeer voice implementation.
 * Piggybacks audio on the existing SimplePeer RTCPeerConnection —
 * no extra WebRTC connection per peer.
 *
 * Web Audio chain (input):
 *   mic → MediaStreamSource → GainNode → MediaStreamDestination → peers
 *
 * Web Audio chain (output, per remote peer):
 *   remoteStream → MediaStreamSource → GainNode → AudioContext.destination
 *
 * Requires PeerTransport & SimplePeerExtension.
 * Will not compile with LibP2PTransport — use a different VoiceTransport impl.
 *
 * Participant lifecycle:
 *   A peer only appears in `active` (and emits trackAdded) once their audio
 *   stream actually arrives via onStream. Connecting to the room does NOT
 *   add anyone to active — only joining the call does.
 */
export class SimplePeerVoice implements VoiceTransport {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null; // raw mic stream
  private processedStream: MediaStream | null = null; // after gain node — sent to peers
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;

  private activeInputDevice: string | null = null;
  private activeOutputDevice: string | null = null;
  private currentInputGain: number = 1.0;
  private currentOutputVolume: number = 1.0;

  private remotePeers: Map<string, RemotePeer> = new Map();
  private active: Set<string> = new Set(); // peers who have sent us an audio stream
  private pendingRemoteStreams: Map<string, MediaStream> = new Map();
  private muted: boolean = false;

  private handlers: Map<keyof VoiceEvents, Set<Function>> = new Map();

  constructor(private transport: PeerTransport & SimplePeerExtension) {
    // When a new peer connects while we are already in a call:
    // The stream was already included in the peer constructor via setInitialStreams,
    // so we don't need addStream here (avoids mid-connection renegotiation).
    // Their stream will arrive via onStream when they add theirs.
    this.transport.on("connect", (_peerId) => {
      // nothing needed — stream was passed at peer creation time via setInitialStreams
    });

    // peer disconnects — clean up their audio
    this.transport.on("disconnect", (peerId) => {
      this.pendingRemoteStreams.delete(peerId);
      if (this.remotePeers.has(peerId)) {
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      }
    });

    // incoming audio stream from a remote peer — they joined the call
    this.transport.onStream((peerId, stream) => {
      if (!this.audioCtx) {
        // Peer stream can arrive before we join the call. Keep it and attach
        // once join() creates the AudioContext to avoid one-way audio races.
        this.pendingRemoteStreams.set(peerId, stream);
        return;
      }
      this.setupRemotePeer(peerId, stream);
    });
  }

  async join(_roomCode: string): Promise<void> {
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume().catch(() => {});
    }

    try {
      await this.startMic(this.activeInputDevice ?? undefined);
    } catch {
      // no mic available — join in listen-only mode
    }

    // Register our stream so any NEW peers that join the room get it at
    // connection creation time (included in the SimplePeer constructor streams[]).
    if (this.processedStream) {
      this.transport.setInitialStreams([this.processedStream]);
    }

    // Send our stream to all already-connected peers via addStream (renegotiation).
    // These peers exist before our join() call, so setInitialStreams won't help them.
    for (const peerId of this.transport.peers()) {
      if (this.processedStream) {
        this.transport.addStream(peerId, this.processedStream);
      }
    }

    // Attach any streams that arrived before we joined the call.
    for (const [peerId, stream] of this.pendingRemoteStreams) {
      this.setupRemotePeer(peerId, stream);
    }
    this.pendingRemoteStreams.clear();
  }

  leave(): void {
    // remove our stream from all peers
    for (const peerId of this.transport.peers()) {
      if (this.processedStream) {
        this.transport.removeStream(peerId, this.processedStream);
      }
    }

    // clear initial streams so future peer connections don't get stale audio
    this.transport.setInitialStreams([]);

    // tear down all remote peers
    for (const peerId of [...this.remotePeers.keys()]) {
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }

    // stop mic tracks
    this.micStream?.getTracks().forEach((t) => t.stop());

    // close audio context
    this.audioCtx?.close();

    this.audioCtx = null;
    this.micStream = null;
    this.processedStream = null;
    this.inputSource = null;
    this.inputGain = null;
    this.active.clear();
    this.pendingRemoteStreams.clear();
  }

  mute(): void {
    this.muted = true;
    this.applyMuteState();
  }

  unmute(): void {
    this.muted = false;
    this.applyMuteState();
  }

  isMuted(): boolean {
    return this.muted;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.audioCtx) {
      // not in a call — just store preference for when join() is called
      this.activeInputDevice = deviceId;
      return;
    }

    const oldStream = this.processedStream;

    // hot-swap the mic
    await this.startMic(deviceId);

    // update the initial stream for future peer connections
    if (this.processedStream) {
      this.transport.setInitialStreams([this.processedStream]);
    }

    // replace stream on all connected peers
    for (const peerId of this.transport.peers()) {
      if (oldStream) this.transport.removeStream(peerId, oldStream);
      if (this.processedStream)
        this.transport.addStream(peerId, this.processedStream);
    }

    this.activeInputDevice = deviceId;
    this.emit("deviceChanged", "input", deviceId);
  }

  async getInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  }

  getActiveInputDevice(): string | null {
    return this.activeInputDevice;
  }

  setInputGain(gain: number): void {
    // clamp to 0.0–2.5
    const clamped = Math.max(0, Math.min(2.5, gain));
    this.currentInputGain = clamped;
    if (this.inputGain) {
      // ramp smoothly over 50ms to avoid clicks
      this.inputGain.gain.linearRampToValueAtTime(
        clamped,
        this.audioCtx!.currentTime + 0.05
      );
    }
  }

  getInputGain(): number {
    return this.currentInputGain;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.activeOutputDevice = deviceId;

    // apply to all current remote audio elements
    for (const remote of this.remotePeers.values()) {
      if ("setSinkId" in remote.audio) {
        await (remote.audio as any).setSinkId(deviceId);
      }
    }

    this.emit("deviceChanged", "output", deviceId);
  }

  async getOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  }

  getActiveOutputDevice(): string | null {
    return this.activeOutputDevice;
  }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(2, volume));
    this.currentOutputVolume = clamped;

    // apply to all current remote peers
    for (const remote of this.remotePeers.values()) {
      remote.gainNode.gain.linearRampToValueAtTime(
        clamped,
        this.audioCtx!.currentTime + 0.05
      );
    }
  }

  getOutputVolume(): number {
    return this.currentOutputVolume;
  }

  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void {
    this.handlers.get(event)?.delete(handler);
  }

  activePeers(): string[] {
    return Array.from(this.active);
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  /**
   * Starts the microphone and builds the Web Audio processing chain.
   * Can be called multiple times for device hot-swap.
   */
  private async startMic(deviceId?: string): Promise<void> {
    // stop previous mic if any
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.inputSource?.disconnect();
    this.inputGain?.disconnect();

    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } }
        : AUDIO_CONSTRAINTS,
      video: false,
    };

    this.micStream = await navigator.mediaDevices.getUserMedia(constraints);

    // remember which device was actually granted
    const track = this.micStream.getAudioTracks()[0];
    this.activeInputDevice = track.getSettings().deviceId ?? null;

    // build Web Audio chain:
    // mic → source → gain → destination → processedStream
    this.inputSource = this.audioCtx!.createMediaStreamSource(this.micStream);
    this.inputGain = this.audioCtx!.createGain();
    const dest = this.audioCtx!.createMediaStreamDestination();

    this.inputGain.gain.value = this.currentInputGain;

    this.inputSource.connect(this.inputGain);
    this.inputGain.connect(dest);

    // processedStream is what gets sent to peers — gain-adjusted, not raw mic
    this.processedStream = dest.stream;

    // apply mute state to new track
    this.applyMuteState();
  }

  /**
   * Set up Web Audio chain for a remote peer's incoming stream.
   * remoteStream → source → gain → audioCtx.destination
   * Allows volume boost above 1.0 (not possible with HTMLMediaElement.volume).
   */
  private setupRemotePeer(peerId: string, stream: MediaStream): void {
    // tear down previous if re-connecting
    if (this.remotePeers.has(peerId)) {
      this.teardownRemotePeer(peerId);
    }

    const audio = new Audio();
    audio.autoplay = true;

    // apply output device preference if set
    if (this.activeOutputDevice && "setSinkId" in audio) {
      (audio as any).setSinkId(this.activeOutputDevice).catch(() => {});
    }

    // Web Audio chain for output — allows gain > 1.0 for boost
    const sourceNode = this.audioCtx!.createMediaStreamSource(stream);
    const gainNode = this.audioCtx!.createGain();
    gainNode.gain.value = this.currentOutputVolume;

    sourceNode.connect(gainNode);
    gainNode.connect(this.audioCtx!.destination);

    // HTMLAudioElement needed for setSinkId (output device routing)
    // but we route audio through Web Audio, so mute the element itself
    audio.srcObject = stream;
    audio.volume = 0; // Web Audio handles the actual output
    audio.muted = true;

    this.remotePeers.set(peerId, { stream, audio, sourceNode, gainNode });
    this.active.add(peerId);

    const [track] = stream.getAudioTracks();
    if (track) this.emit("trackAdded", peerId, track);
  }

  private teardownRemotePeer(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;

    remote.sourceNode.disconnect();
    remote.gainNode.disconnect();
    remote.audio.srcObject = null;
    remote.stream.getTracks().forEach((t) => t.stop());

    this.remotePeers.delete(peerId);
    this.active.delete(peerId);

    this.emit("trackRemoved", peerId);
  }

  /**
   * Mute by disabling the track — not by setting gain to 0.
   * Disabling the track signals silence to the browser without removing
   * the stream from peers, keeping the connection warm.
   */
  private applyMuteState(): void {
    if (!this.micStream) return;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = !this.muted;
    }
  }

  private emit<K extends keyof VoiceEvents>(
    event: K,
    ...args: Parameters<VoiceEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
