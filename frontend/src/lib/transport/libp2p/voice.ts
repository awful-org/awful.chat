import type { Libp2p } from "libp2p";
import type { VoiceTransport, VoiceEvents } from "../types";

const VOICE_PROTO = "/voice/1.0.0";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

type VoiceSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

interface RemotePeer {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  audio: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
}

/**
 * Voice over libp2p.
 *
 * Each peer pair gets one RTCPeerConnection managed independently.
 * Signaling (offer/answer/ICE) is exchanged over a persistent libp2p
 * protocol stream on /voice/1.0.0.
 *
 * Web Audio chain (input):  mic → source → gain → destination → pc.addTrack
 * Web Audio chain (output): remoteTrack → source → gain → ctx.destination
 *
 * The libp2p node is injected — this class does not own it.
 */
export class LibP2PVoice implements VoiceTransport {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;

  private activeInputDevice: string | null = null;
  private activeOutputDevice: string | null = null;
  private currentInputGain = 1.0;
  private currentOutputVolume = 1.0;
  private muted = false;

  private remotePeers = new Map<string, RemotePeer>();
  private active = new Set<string>();
  // Outbound signal queues — buffered while the stream is being dialed.
  private signalQueues = new Map<string, VoiceSignal[]>();
  // Open write streams to remote peers.
  private signalStreams = new Map<
    string,
    WritableStreamDefaultWriter<Uint8Array>
  >();

  private handlers = new Map<keyof VoiceEvents, Set<Function>>();

  constructor(private node: Libp2p) {}

  async join(_roomCode: string): Promise<void> {
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume().catch(() => {});
    }

    try {
      await this.startMic(this.activeInputDevice ?? undefined);
    } catch {
      // listen-only mode — no mic
    }

    // Handle incoming /voice/1.0.0 streams (remote peer dialed us).
    this.node.handle(VOICE_PROTO, async ({ stream, connection }: any) => {
      const peerId = connection.remotePeer.toString();
      this.ensureRemotePeer(peerId);
      this.readSignals(peerId, stream);
    });

    // For each peer already connected — dial them and offer.
    for (const peer of this.node.getPeers()) {
      const peerId = peer.toString();
      await this.dialAndOffer(peerId);
    }

    // When a new peer connects while we are in a call — dial and offer.
    this.node.addEventListener("peer:connect", async (evt) => {
      const peerId = evt.detail.toString();
      if (this.remotePeers.has(peerId)) return;
      if (this.audioCtx) await this.dialAndOffer(peerId);
    });

    // Peer disconnect cleanup.
    this.node.addEventListener("peer:disconnect", (evt) => {
      const peerId = evt.detail.toString();
      if (this.remotePeers.has(peerId)) {
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      }
    });
  }

  leave(): void {
    for (const peerId of [...this.remotePeers.keys()]) {
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }

    this.node.unhandle(VOICE_PROTO);

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();

    this.audioCtx = null;
    this.micStream = null;
    this.processedStream = null;
    this.inputSource = null;
    this.inputGain = null;
    this.active.clear();
    this.signalQueues.clear();
    this.signalStreams.clear();
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
      this.activeInputDevice = deviceId;
      return;
    }

    await this.startMic(deviceId);

    // Replace track on all active RTCPeerConnections.
    const newTrack = this.processedStream?.getAudioTracks()[0] ?? null;
    if (newTrack) {
      for (const remote of this.remotePeers.values()) {
        const sender = remote.pc
          .getSenders()
          .find((s) => s.track?.kind === "audio");
        if (sender) await sender.replaceTrack(newTrack);
      }
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
    const clamped = Math.max(0, Math.min(2.5, gain));
    this.currentInputGain = clamped;
    if (this.inputGain) {
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
    for (const remote of this.remotePeers.values()) {
      if (remote.gainNode) {
        remote.gainNode.gain.linearRampToValueAtTime(
          clamped,
          this.audioCtx!.currentTime + 0.05
        );
      }
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

  // ─── internals ────────────────────────────────────────────────────────────

  private async startMic(deviceId?: string): Promise<void> {
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

    const track = this.micStream.getAudioTracks()[0];
    this.activeInputDevice = track.getSettings().deviceId ?? null;

    this.inputSource = this.audioCtx!.createMediaStreamSource(this.micStream);
    this.inputGain = this.audioCtx!.createGain();
    const dest = this.audioCtx!.createMediaStreamDestination();

    this.inputGain.gain.value = this.currentInputGain;
    this.inputSource.connect(this.inputGain);
    this.inputGain.connect(dest);

    this.processedStream = dest.stream;
    this.applyMuteState();
  }

  /**
   * Dial a remote peer on /voice/1.0.0 and send them an offer.
   * We are always initiator when we dial.
   */
  private async dialAndOffer(peerId: string): Promise<void> {
    const remote = this.ensureRemotePeer(peerId);

    try {
      const stream = await this.node.dialProtocol(
        this.node.getPeers().find((p) => p.toString() === peerId)!,
        VOICE_PROTO
      );
      this.readSignals(peerId, stream);
      this.openWriteStream(peerId, stream);
    } catch (err) {
      console.warn(`[LibP2PVoice] dial ${peerId} failed:`, err);
      return;
    }

    const offer = await remote.pc.createOffer();
    await remote.pc.setLocalDescription(offer);
    this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
  }

  private ensureRemotePeer(peerId: string): RemotePeer {
    if (this.remotePeers.has(peerId)) return this.remotePeers.get(peerId)!;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Add our processed audio track if we have one.
    if (this.processedStream) {
      for (const track of this.processedStream.getAudioTracks()) {
        pc.addTrack(track, this.processedStream);
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.sendSignal(peerId, { type: "ice", candidate: candidate.toJSON() });
      }
    };

    pc.ontrack = ({ track, streams }) => {
      if (track.kind !== "audio") return;
      const stream = streams[0] ?? new MediaStream([track]);
      this.setupRemoteAudio(peerId, stream, track);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      }
    };

    const audio = new Audio();
    audio.autoplay = true;
    if (this.activeOutputDevice && "setSinkId" in audio) {
      (audio as any).setSinkId(this.activeOutputDevice).catch(() => {});
    }

    const remote: RemotePeer = {
      pc,
      stream: null,
      audio,
      sourceNode: null,
      gainNode: null,
    };
    this.remotePeers.set(peerId, remote);
    return remote;
  }

  private setupRemoteAudio(
    peerId: string,
    stream: MediaStream,
    track: MediaStreamTrack
  ): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote || !this.audioCtx) return;

    remote.sourceNode?.disconnect();
    remote.gainNode?.disconnect();

    const sourceNode = this.audioCtx.createMediaStreamSource(stream);
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = this.currentOutputVolume;

    sourceNode.connect(gainNode);
    gainNode.connect(this.audioCtx.destination);

    // HTMLAudioElement needed only for setSinkId — Web Audio handles actual output.
    remote.audio.srcObject = stream;
    remote.audio.volume = 0;
    remote.audio.muted = true;

    remote.stream = stream;
    remote.sourceNode = sourceNode;
    remote.gainNode = gainNode;

    this.active.add(peerId);
    this.emit("trackAdded", peerId, track);
  }

  private teardownRemotePeer(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;

    remote.sourceNode?.disconnect();
    remote.gainNode?.disconnect();
    remote.audio.srcObject = null;
    remote.stream?.getTracks().forEach((t) => t.stop());
    remote.pc.close();

    this.remotePeers.delete(peerId);
    this.active.delete(peerId);
    this.signalStreams
      .get(peerId)
      ?.close()
      .catch(() => {});
    this.signalStreams.delete(peerId);
    this.signalQueues.delete(peerId);

    this.emit("trackRemoved", peerId);
  }

  /**
   * Read incoming signals from a /voice/1.0.0 stream.
   * The stream is shared for both reading and writing when the remote dialed us
   * (answerer path); when we dialed (initiator path) we read from our own outbound stream.
   */
  private async readSignals(peerId: string, stream: any): Promise<void> {
    try {
      for await (const chunk of stream.source) {
        const raw =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(
                chunk.subarray ? chunk.subarray() : chunk
              );
        const signal = JSON.parse(raw) as VoiceSignal;
        await this.handleSignal(peerId, signal);
      }
    } catch {
      // stream closed
    }
  }

  private openWriteStream(peerId: string, stream: any): void {
    // Wrap the libp2p stream sink in a writable we can push to later.
    const writer = {
      write: (data: Uint8Array) => stream.sink([data]),
      close: () => stream.close(),
    };
    // Store a simple object that matches what sendSignal needs.
    (this.signalStreams as any).set(peerId, writer);

    // Flush queued signals.
    const queue = this.signalQueues.get(peerId) ?? [];
    this.signalQueues.delete(peerId);
    for (const sig of queue) {
      this.sendSignal(peerId, sig);
    }
  }

  private sendSignal(peerId: string, signal: VoiceSignal): void {
    const writer = (this.signalStreams as any).get(peerId);
    if (!writer) {
      if (!this.signalQueues.has(peerId)) this.signalQueues.set(peerId, []);
      this.signalQueues.get(peerId)!.push(signal);
      return;
    }
    const data = new TextEncoder().encode(JSON.stringify(signal));
    writer.write(data).catch(() => {});
  }

  private async handleSignal(
    peerId: string,
    signal: VoiceSignal
  ): Promise<void> {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;

    switch (signal.type) {
      case "offer": {
        await remote.pc.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        });
        const answer = await remote.pc.createAnswer();
        await remote.pc.setLocalDescription(answer);
        this.sendSignal(peerId, { type: "answer", sdp: answer.sdp! });
        break;
      }
      case "answer": {
        await remote.pc.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        });
        break;
      }
      case "ice": {
        await remote.pc.addIceCandidate(signal.candidate).catch(() => {});
        break;
      }
    }
  }

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
