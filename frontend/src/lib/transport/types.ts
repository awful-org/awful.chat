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
  isRelayed(peerId: string): boolean;
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
  /** Fired when someone starts watching your screen share transmission. */
  transmissionWatched: (peerId: string) => void;
  /** Fired when someone stops watching your screen share transmission. */
  transmissionWatchEnded: (peerId: string) => void;
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

export type FileTransferStatus =
  | "pending"
  | "seeding"
  | "downloading"
  | "complete"
  | "failed";

export interface FileDescriptor {
  infoHash: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface FileTransferSnapshot extends FileDescriptor {
  status: FileTransferStatus;
  progress: number;
  done: boolean;
  seeding: boolean;
  peers: number;
  seeders: number;
  blobURL?: string;
  error?: string;
}

export type FileSignalEnvelope =
  | {
      kind: "file-seeder";
      file: FileDescriptor;
    }
  | {
      kind: "file-wt-signal";
      infoHash: string;
      signal: unknown;
    };

export interface FileTransferEvents {
  signal: (peerId: string, envelope: FileSignalEnvelope) => void;
  transfer: (snapshot: FileTransferSnapshot) => void;
  downloaded: (infoHash: string, blob: Blob) => void;
}

export interface FileTransferTransport {
  seedFiles(files: File[]): Promise<FileDescriptor[]>;
  registerSeeder(file: FileDescriptor, seederPeerId: string): void;
  ensureDownload(file: FileDescriptor): void;
  handleSignal(fromPeerId: string, envelope: FileSignalEnvelope): void;
  onPeerConnect(peerId: string): void;
  onPeerDisconnect(peerId: string): void;
  getTransfer(infoHash: string): FileTransferSnapshot | undefined;
  getTransfers(): FileTransferSnapshot[];
  on<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void;
  off<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void;
  destroy(): void;
}
