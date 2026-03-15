export interface TransportEvents {
  connect: (peerId: string) => void;
  disconnect: (peerId: string) => void;
  message: (peerId: string, data: Uint8Array) => void;
}

/**
 * Core p2p data transport interface.
 * Implemented by SimplePeerTransport and LibP2PTransport.
 * All app logic (sync, Yjs, messages) uses only this interface.
 */
export interface PeerTransport {
  connect(roomCode: string): Promise<void>;
  disconnect(): void;
  send(peerId: string, data: Uint8Array): void;
  broadcast(data: Uint8Array): void;
  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K]
  ): void;
  off<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K]
  ): void;
  peers(): string[];
  selfId(): string;
}

/**
 * WebRTC media stream extension — SimplePeer only.
 * LibP2PTransport does NOT implement this.
 *
 * SimplePeerVoice requires: PeerTransport & SimplePeerExtension
 * MediasoupVideo requires:  PeerTransport only
 *
 * The type system enforces the correct impl per transport —
 * SimplePeerVoice will not compile with LibP2PTransport.
 */
export interface SimplePeerExtension {
  addStream(peerId: string, stream: MediaStream): void;
  removeStream(peerId: string, stream: MediaStream): void;
  onStream(handler: (peerId: string, stream: MediaStream) => void): void;
}

export interface VoiceEvents {
  trackAdded: (peerId: string, track: MediaStreamTrack) => void;
  trackRemoved: (peerId: string) => void;
  peerJoined: (peerId: string) => void;
  peerLeft: (peerId: string) => void;
  deviceChanged: (kind: "input" | "output", deviceId: string) => void;
  error: (err: Error) => void;
}

/**
 * P2P audio — piggybacks on SimplePeer connections.
 * No SFU — fully private.
 * Implemented by SimplePeerVoice.
 */
export interface VoiceTransport {
  // lifecycle
  join(roomCode: string): Promise<void>;
  leave(): void;

  // mute — disables track, connection stays warm
  mute(): void;
  unmute(): void;
  isMuted(): boolean;

  // input device
  setInputDevice(deviceId: string): Promise<void>;
  getInputDevices(): Promise<MediaDeviceInfo[]>;
  getActiveInputDevice(): string | null;

  // input gain — 0.0 to 2.0, 1.0 = unity, >1.0 = boost
  setInputGain(gain: number): void;
  getInputGain(): number;

  // output device — routes remote audio to specific speaker
  setOutputDevice(deviceId: string): Promise<void>;
  getOutputDevices(): Promise<MediaDeviceInfo[]>;
  getActiveOutputDevice(): string | null;

  // output volume — 0.0 to 2.0, 1.0 = unity, >1.0 = boost via Web Audio
  setOutputVolume(volume: number): void;
  getOutputVolume(): number;

  // events
  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void;
  off<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void;

  // introspection
  activePeers(): string[];
}

export type VideoSource = "camera" | "screen";

export interface VideoEvents {
  trackAdded: (
    peerId: string,
    track: MediaStreamTrack,
    source: VideoSource
  ) => void;
  trackRemoved: (peerId: string, source: VideoSource) => void;
  peerJoined: (peerId: string) => void;
  peerLeft: (peerId: string) => void;
  error: (err: Error) => void;
}

/**
 * SFU video — routes video through mediasoup server.
 * Works with any PeerTransport for signaling.
 * Implemented by MediasoupVideo.
 *
 * Audio stays p2p via VoiceTransport.
 */
export interface VideoTransport {
  join(roomCode: string): Promise<void>;
  leave(): void;
  startCamera(): Promise<void>;
  stopCamera(): void;
  startScreenShare(): Promise<void>;
  stopScreenShare(): void;
  pauseVideo(source: VideoSource): void;
  resumeVideo(source: VideoSource): void;
  isPaused(source: VideoSource): boolean;
  isPublishing(source: VideoSource): boolean;

  // self mute — pauses all outgoing producers without stopping tracks
  mute(): void;
  unmute(): void;
  isMuted(): boolean;

  // output volume for incoming remote tracks (0.0–2.0, >1.0 = boost)
  setOutputVolume(volume: number): void;

  on<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  off<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  activePeers(): string[];
}
