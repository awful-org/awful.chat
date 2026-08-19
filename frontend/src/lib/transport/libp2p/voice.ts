import type { Libp2p } from "libp2p";
import type { Connection, Stream } from "@libp2p/interface";
import type { StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";
import type { VoiceTransport, VoiceEvents } from "../types";
import type { AppServices, LibP2PTransport } from "./transport";
import type { DtlnProcessor } from "$lib/audio/dtln-processor";
import { getIceServers } from "../ice-server-list";

const VOICE_PROTO = "/voice/1.0.0";
/** Same ceiling as the output slider in audio settings. */
export const MAX_PEER_VOLUME = 2.5;
const MAX_FRAME_BYTES = 256 * 1024; // 256 KB max frame size; signaling payloads are tiny

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const AUDIO_CONSTRAINTS_NO_DTLN: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
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
  sigStream: Stream | null;
  readBuf: Uint8Array;
  pendingCandidates: RTCIceCandidateInit[];
}

export class LibP2PVoice implements VoiceTransport {
  private node: Libp2p<AppServices> | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;
  /**
   * The node the voice handler is currently registered on. Tracked per node,
   * not as a boolean: a reconnect builds a fresh node, and a stale "already
   * registered" flag would leave the new one with no handler at all.
   */
  private handlerNode: Libp2p<AppServices> | null = null;

  private activeInputDevice: string | null = null;
  private activeOutputDevice: string | null = null;
  private currentInputGain = 1.0;
  private currentOutputVolume = 1.0;
  private muted = false;

  private remotePeers = new Map<string, RemotePeer>();
  /**
   * Per-peer listening volume, multiplied with the master output volume.
   * Kept outside RemotePeer so the setting survives that peer dropping and
   * rejoining during the same call.
   */
  private peerVolumes = new Map<string, number>();
  private active = new Set<string>();
  private signalQueues = new Map<string, VoiceSignal[]>();
  private handlers = new Map<keyof VoiceEvents, Set<Function>>();

  private dtlnEnabled = true;

  private onTransportConnect: ((peerId: string) => void) | null = null;
  private onTransportDisconnect: (peerId: string) => void | null = () => {};

  constructor(
    private transport: LibP2PTransport,
    private dtln: DtlnProcessor | null = null
  ) {}

  async join(_roomCode: string): Promise<void> {
    this.node = this.transport.p2pNode;
    if (!this.node) throw new Error("Transport not connected");

    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume().catch(() => {});
    }

    try {
      await this.startMic(this.activeInputDevice ?? undefined);
    } catch {
      // listen-only mode
    }

    if (this.handlerNode !== this.node) {
      // force: registering the same protocol twice throws "Handler already
      // registered", which used to abort the whole join. Replacing is always
      // the right outcome here - the handler only closes over `this` - so a
      // re-entrant join heals instead of failing.
      await this.node.handle(
        VOICE_PROTO,
        (stream: Stream, connection: Connection) => {
          const peerId = connection.remotePeer.toString();
          const remote = this.ensureRemotePeer(peerId);
          this.attachStream(peerId, remote, stream);
        },
        { force: true }
      );
      this.handlerNode = this.node;
    }

    this.onTransportConnect = (peerId: string) => {
      if (this.transport.isRelay(peerId)) return;
      if (this.remotePeers.has(peerId)) return;
      if (peerId > this.transport.selfId()) return;
      // always dial from both sides - ensureRemotePeer + pc state guards duplication
      this.dialAndOffer(peerId).catch((err) => {
        this.emit("status", {
          type: "voice-dial-failed",
          peerId: peerId.slice(-8),
          message:
            err instanceof Error
              ? err.message
              : "Voice dial failed on peer connect",
        });
      });
    };

    this.onTransportDisconnect = (peerId: string) => {
      if (!this.remotePeers.has(peerId)) return;
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    };

    this.transport.on("connect", this.onTransportConnect);
    this.transport.on("disconnect", this.onTransportDisconnect);

    for (const peerId of this.transport.peers()) {
      if (this.transport.isRelay(peerId)) continue;
      if (peerId < this.transport.selfId()) {
        this.dialAndOffer(peerId).catch((err) => {
          this.emit("status", {
            type: "voice-dial-failed",
            peerId: peerId.slice(-8),
            message:
              err instanceof Error ? err.message : "Voice dial failed on join",
          });
        });
      }
    }
  }

  leave(): void {
    if (this.onTransportConnect) {
      this.transport.off("connect", this.onTransportConnect);
      this.onTransportConnect = null;
    }

    if (this.onTransportDisconnect) {
      this.transport.off("disconnect", this.onTransportDisconnect);
      this.onTransportDisconnect = () => {};
    }

    for (const peerId of [...this.remotePeers.keys()]) {
      this.teardownRemotePeer(peerId);
      this.emit("peerLeft", peerId);
    }
    if (this.handlerNode) {
      // Unregister on the node it was registered on, which is not necessarily
      // the current one after a reconnect.
      this.handlerNode.unhandle(VOICE_PROTO).catch(() => {});
      this.handlerNode = null;
    }

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.dtln?.releaseTransport();
    this.audioCtx?.close();

    this.audioCtx = null;
    this.micStream = null;
    this.processedStream = null;
    this.inputSource = null;
    this.inputGain = null;
    this.active.clear();
    this.signalQueues.clear();
    this.node = null;
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

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.audioCtx) {
      this.activeInputDevice = deviceId;
      return;
    }

    await this.startMic(deviceId);

    const newTrack = this.processedStream?.getAudioTracks()[0] ?? null;
    if (!newTrack) return;
    for (const remote of this.remotePeers.values()) {
      const sender = remote.pc
        .getSenders()
        .find((s) => s.track?.kind === "audio");
      if (sender) await sender.replaceTrack(newTrack);
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
    if (this.dtlnEnabled && this.dtln) {
      this.dtln.setInputGain(clamped);
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
    this.currentOutputVolume = Math.max(0, Math.min(2, volume));
    for (const peerId of this.remotePeers.keys()) this.applyPeerGain(peerId);
  }

  /** How loud one peer is for us alone; 1 is unchanged, 0 is muted. */
  setPeerVolume(peerId: string, volume: number): void {
    this.peerVolumes.set(peerId, Math.max(0, Math.min(MAX_PEER_VOLUME, volume)));
    this.applyPeerGain(peerId);
  }

  hasPeerVolume(peerId: string): boolean {
    return this.peerVolumes.has(peerId);
  }

  getPeerVolume(peerId: string): number {
    return this.peerVolumes.get(peerId) ?? 1;
  }

  private applyPeerGain(peerId: string): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote?.gainNode || !this.audioCtx) return;
    remote.gainNode.gain.linearRampToValueAtTime(
      this.currentOutputVolume * this.getPeerVolume(peerId),
      this.audioCtx.currentTime + 0.05
    );
  }

  getOutputVolume(): number {
    return this.currentOutputVolume;
  }

  async setDtlnEnabled(enabled: boolean): Promise<void> {
    if (this.dtlnEnabled === enabled) return;
    this.dtlnEnabled = enabled;
    if (this.audioCtx) {
      await this.startMic(this.activeInputDevice ?? undefined);
    }
  }

  isDtlnEnabled(): boolean {
    return this.dtlnEnabled;
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

    const useDtln = this.dtlnEnabled && this.dtln != null;

    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? {
            ...(useDtln ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN),
            deviceId: { exact: deviceId },
          }
        : useDtln
          ? AUDIO_CONSTRAINTS
          : AUDIO_CONSTRAINTS_NO_DTLN,
      video: false,
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // The remembered mic may be unplugged by the time it is restored, and
      // `deviceId: {exact}` makes that a hard failure - fall back to whatever
      // the system offers rather than leaving the user with no audio at all.
      if (!deviceId) throw err;
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: useDtln ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN,
        video: false,
      });
    }
    const track = this.micStream.getAudioTracks()[0];
    this.activeInputDevice = track.getSettings().deviceId ?? null;

    if (useDtln) {
      await this.dtln?.waitUntilReady().catch(() => {
        console.error;
      });
      this.processedStream = await this.dtln!.processStream(
        this.micStream,
        this.currentInputGain
      );
    } else {
      // DTLN off: drop its graph so the worklet stops processing the (now
      // stopped) previous mic and peers are fed by the plain path only.
      this.dtln?.releaseTransport();
      const ctx = this.audioCtx!;
      this.inputSource = ctx.createMediaStreamSource(this.micStream);
      this.inputGain = ctx.createGain();
      this.inputGain.gain.value = this.currentInputGain;
      const dest = ctx.createMediaStreamDestination();
      this.inputSource.connect(this.inputGain);
      this.inputGain.connect(dest);
      this.processedStream = dest.stream;
    }

    const newTrack = this.processedStream.getAudioTracks()[0] ?? null;
    if (newTrack) {
      for (const remote of this.remotePeers.values()) {
        const sender = remote.pc
          .getSenders()
          .find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          remote.pc.addTrack(newTrack, this.processedStream);
        }
      }
    }

    this.applyMuteState();
  }

  private async dialAndOffer(peerId: string): Promise<void> {
    if (!this.node || this.transport.isRelay(peerId)) return;

    // if the other side already dialed us, we're done
    if (this.remotePeers.get(peerId)?.sigStream) return;

    const remote = this.ensureRemotePeer(peerId);

    let stream: Stream | null = null;
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        const pid = this.node.getPeers().find((p) => p.toString() === peerId);
        if (!pid) throw new Error("peer not in peerstore");
        stream = await this.node.dialProtocol(pid, VOICE_PROTO);
        break;
      } catch (err) {
        if (attempt === 5) {
          console.warn(`[LibP2PVoice] dial ${peerId} failed:`, err);
          this.emit("status", {
            type: "voice-dial-failed",
            peerId: peerId.slice(-8),
            message:
              err instanceof Error
                ? err.message
                : "Failed to open voice stream",
          });
          return;
        }
        this.emit("status", {
          type: "voice-dial-retrying",
          peerId: peerId.slice(-8),
          attempt: attempt + 1,
          message: `Retrying voice connection (${attempt + 1}/5)...`,
        });
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }

    if (!stream) return;

    this.attachStream(peerId, remote, stream);

    if (remote.pc.remoteDescription) {
      // Signaling channel re-established but offer/answer already exchanged; skip redundant steps
      return;
    }

    if (remote.pc.signalingState === "have-local-offer") return;

    const offer = await remote.pc.createOffer();
    await remote.pc.setLocalDescription(offer);
    this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
  }

  private attachStream(
    peerId: string,
    remote: RemotePeer,
    stream: Stream
  ): void {
    remote.sigStream = stream;

    stream.addEventListener("message", (evt: StreamMessageEvent) => {
      const chunk: Uint8Array =
        evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();

      const merged = new Uint8Array(
        remote.readBuf.byteLength + chunk.byteLength
      );
      merged.set(remote.readBuf);
      merged.set(chunk, remote.readBuf.byteLength);
      remote.readBuf = merged;

      while (remote.readBuf.byteLength >= 4) {
        const len = new DataView(
          remote.readBuf.buffer,
          remote.readBuf.byteOffset
        ).getUint32(0, false);
        // Guard against unbounded buffer growth from malicious peers
        if (len > MAX_FRAME_BYTES) {
          stream.abort(new Error("frame size exceeds maximum"));
          return;
        }
        if (remote.readBuf.byteLength < 4 + len) break;
        const payload = remote.readBuf.slice(4, 4 + len);
        remote.readBuf = remote.readBuf.slice(4 + len);
        try {
          const signal = JSON.parse(
            new TextDecoder().decode(payload)
          ) as VoiceSignal;
          this.handleSignal(peerId, signal).catch(() => {});
        } catch {}
      }
    });

    stream.addEventListener("close", (_evt: StreamCloseEvent) => {
      if (remote.sigStream !== stream) return;
      remote.sigStream = null;

      const state = remote.pc.connectionState;
      if (state !== "closed" && state !== "failed" && this.node) {
        this.dialAndOffer(peerId).catch(() => {});
      }
    });

    const queued = this.signalQueues.get(peerId) ?? [];
    this.signalQueues.delete(peerId);
    for (const sig of queued) this.sendSignal(peerId, sig);
  }

  private sendSignal(peerId: string, signal: VoiceSignal): void {
    const remote = this.remotePeers.get(peerId);
    if (!remote?.sigStream) {
      if (!this.signalQueues.has(peerId)) this.signalQueues.set(peerId, []);
      this.signalQueues.get(peerId)!.push(signal);
      return;
    }

    const payload = new TextEncoder().encode(JSON.stringify(signal));
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);

    try {
      const ok = remote.sigStream.send(frame);
      if (!ok) {
        remote.sigStream.onDrain().catch(() => {
          remote.sigStream?.abort(new Error("drain failed"));
          remote.sigStream = null;
        });
      }
    } catch (err) {
      console.warn(`[LibP2PVoice] signal send failed for ${peerId}:`, err);
      remote.sigStream = null;
    }
  }

  private ensureRemotePeer(peerId: string): RemotePeer {
    if (this.remotePeers.has(peerId)) return this.remotePeers.get(peerId)!;

    const pc = new RTCPeerConnection({
      iceCandidatePoolSize: 10,
      iceServers: getIceServers(),
    });

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
      const state = pc.connectionState;
      if (state === "connected") {
        // check if relayed via TURN
        pc.getStats()
          .then((stats) => {
            for (const report of stats.values()) {
              if (
                report.type === "candidate-pair" &&
                report.state === "succeeded"
              ) {
                const isRelay =
                  report.localCandidateType === "relay" ||
                  report.remoteCandidateType === "relay";
                this.emit("status", {
                  type: "voice-ice-connected",
                  // Full id: consumers match tiles against it; the human-
                  // readable part is the message.
                  peerId,
                  relayed: isRelay,
                  message: isRelay
                    ? "Voice connected via relay (TURN)"
                    : "Voice connected directly (P2P)",
                });
              }
            }
          })
          .catch(() => {});
      } else if (state === "failed") {
        this.emit("status", {
          type: "voice-connection-failed",
          peerId: peerId.slice(-8),
          message: `Voice connection failed for ${peerId.slice(-8)}`,
        });
        this.teardownRemotePeer(peerId);
        this.emit("peerLeft", peerId);
      } else if (state === "disconnected") {
        this.emit("status", {
          type: "voice-degraded",
          peerId: peerId.slice(-8),
          message: `Voice signal lost from ${peerId.slice(-8)} - reconnecting...`,
        });
        // attempt ICE restart if signaling stream is still alive
        if (remote.sigStream && remote.pc.signalingState === "stable") {
          remote.pc.restartIce();
          remote.pc
            .createOffer({ iceRestart: true })
            .then((offer) => {
              return remote.pc.setLocalDescription(offer).then(() => {
                this.sendSignal(peerId, { type: "offer", sdp: offer.sdp! });
              });
            })
            .catch((err) => {
              console.warn(
                `[LibP2PVoice] ICE restart failed for ${peerId}:`,
                err
              );
              this.emit("status", {
                type: "voice-connection-failed",
                peerId: peerId.slice(-8),
                message: `Voice ICE restart failed for ${peerId.slice(-8)}`,
              });
            });
        }
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
      sigStream: null,
      readBuf: new Uint8Array(0),
      pendingCandidates: [],
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
    gainNode.gain.value = this.currentOutputVolume * this.getPeerVolume(peerId);

    sourceNode.connect(gainNode);
    gainNode.connect(this.audioCtx.destination);

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
    remote.sigStream?.abort(new Error("teardown"));
    remote.pc.close();

    this.remotePeers.delete(peerId);
    this.active.delete(peerId);
    this.signalQueues.delete(peerId);

    this.emit("trackRemoved", peerId);
  }

  private async handleSignal(
    peerId: string,
    signal: VoiceSignal
  ): Promise<void> {
    const remote = this.remotePeers.get(peerId);
    if (!remote) return;

    switch (signal.type) {
      case "offer": {
        const state = remote.pc.signalingState;

        if (state === "have-local-offer") {
          // glare: higher peerId yields
          if (this.transport.selfId() > peerId) {
            await remote.pc.setLocalDescription({ type: "rollback" });
          } else {
            return;
          }
        } else if (state !== "stable") {
          // unexpected state - log and bail
          console.warn(
            `[Voice] unexpected signaling state ${state} on offer from ${peerId}`
          );
          return;
        }

        await remote.pc.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        });
        await this.drainCandidates(remote); // drain buffered ICE
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
        await this.drainCandidates(remote); // drain buffered ICE
        break;
      }
      case "ice": {
        if (!remote.pc.remoteDescription) {
          remote.pendingCandidates.push(signal.candidate);
          return;
        }
        await remote.pc.addIceCandidate(signal.candidate).catch(() => {});
        break;
      }
    }
  }

  private async drainCandidates(remote: RemotePeer): Promise<void> {
    for (const c of remote.pendingCandidates.splice(0)) {
      await remote.pc.addIceCandidate(c).catch(() => {});
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
