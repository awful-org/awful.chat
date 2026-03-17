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
  /**
   * Called by VoiceTransport to register a stream that should be included
   * when a NEW peer connection is created (i.e. when peer-joined fires while
   * already in a call). Avoids mid-connection renegotiation via addStream.
   */
  setInitialStreams(streams: MediaStream[]): void;
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
  /** Fired when a remote peer starts a screen-share transmission (opt-in: not auto-consumed). */
  transmissionAvailable: (peerId: string, producerId: string) => void;
  /** Fired when a remote peer's transmission ends (they stopped sharing or left). */
  transmissionEnded: (peerId: string) => void;
  /** Fired when output volume changes (0.0 to 1.0). */
  outputVolumeChanged: (volume: number) => void;
  error: (err: Error) => void;
}

/**
 * SFU video — routes video through mediasoup server.
 * Connects directly to the SFU via its own WebSocket (VITE_SFU_URL).
 * Implemented by MediasoupVideo.
 *
 * Audio stays p2p via VoiceTransport.
 *
 * Screen shares are opt-in transmissions:
 *   - Remote screen-share producers emit `transmissionAvailable` instead of auto-consuming.
 *   - Call `watchTransmission(peerId, producerId)` to start consuming.
 *   - Call `stopWatchingTransmission(peerId)` to stop.
 *   - Max 1 transmission watched simultaneously (enforced by the caller).
 */
export interface VideoTransport {
  join(roomCode: string, peerId: string): Promise<void>;
  leave(): void;
  /** If `stream` is provided, publish it directly (avoids a second getUserMedia call). */
  startCamera(stream?: MediaStream): Promise<void>;
  stopCamera(): void;
  /** If `stream` is provided, publish it directly (avoids a second getDisplayMedia call). */
  startScreenShare(stream?: MediaStream): Promise<void>;
  stopScreenShare(): void;
  pauseVideo(source: VideoSource): void;
  resumeVideo(source: VideoSource): void;
  isPaused(source: VideoSource): boolean;
  isPublishing(source: VideoSource): boolean;

  /** Start consuming a pending transmission from a remote peer. */
  watchTransmission(peerId: string, producerId: string): Promise<void>;
  /** Stop consuming the transmission from a remote peer (closes screen consumer). */
  stopWatchingTransmission(peerId: string): void;
  /** Returns all pending (not yet watched) transmissions: peerId → producerId. */
  getPendingTransmissions(): Map<string, string>;

  getAudioTrack(peerId: string): MediaStreamTrack | null;

  on<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  off<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  activePeers(): string[];
}
