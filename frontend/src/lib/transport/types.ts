export interface TransportEvents {
  connect: (peerId: string) => void;
  disconnect: (peerId: string) => void;
  message: (peerId: string, data: Uint8Array, room: string | null) => void;
  /**
   * The relay told us who is registered in a room (its PEERS reply, or a
   * PEER_JOINED). Membership is what gates telling a peer that a room exists,
   * so this is the moment history can be reconciled with them.
   */
  roomPeers: (room: string, peerIds: string[]) => void;
  status: (status: TransportStatus) => void;
  /**
   * A peer's path changed between a relay circuit and a direct connection.
   *
   * The transport knows this the moment it happens, but the UI could not:
   * isRelayed() looks inside a plain Set, so a template that calls it renders
   * a snapshot and never hears about an upgrade. This event is what turns
   * that into reactive state.
   */
  relayChanged: (peerId: string, relayed: boolean) => void;
  /**
   * A peer's outbound stream has proof the far side is reading it - the
   * first pong on THIS stream, not merely a connection reporting "open".
   * connectedPeers (and the peers this mirrors into) never gated on this,
   * so a link that connects but carries nothing rendered exactly like a
   * working one. streamLost fires when that proof is withdrawn: the
   * stream is torn down, reset, or never confirms.
   *
   * Both carry the FULL peer id, like every other peer-naming event here.
   */
  streamProven: (peerId: string) => void;
  streamLost: (peerId: string) => void;
}

/**
 * Transient banners. `peerId`, where present, is always the FULL peer id -
 * `message` may shorten it for a human, but UI code matches a peer by
 * `peerId`, and a sliced id cannot address one.
 */
export type TransportStatus =
  | { type: "app-warning"; message: string }
  | { type: "relay-connected"; message: string }
  | { type: "relay-disconnected"; message: string }
  | { type: "relay-dial-retry"; message: string }
  | { type: "relay-dial-failed"; message: string }
  | { type: "relay-reconnect-failed"; message: string }
  | { type: "relay-reconnecting"; message: string }
  | { type: "stream-open-failed"; peerId: string; message: string }
  | { type: "rendezvous-failed"; message: string }
  | { type: "rendezvous-reconnecting"; message: string }
  | { type: "reservation-timeout"; message: string }
  | { type: "voice-dial-failed"; peerId: string; message: string }
  | { type: "voice-peer-left"; peerId: string; message: string }
  | { type: "peer-dial-failed"; peerId: string; message: string }
  | { type: "voice-connection-failed"; peerId: string; message: string }
  | {
      type: "voice-ice-connected";
      peerId: string;
      relayed: boolean;
      message: string;
    }
  | { type: "voice-degraded"; peerId: string; message: string };

export interface PeerTransport {
  connect(privateKeyBytes?: Uint8Array | null): Promise<void>;
  disconnect(): void | Promise<void>;
  joinRoom(roomCode: string): void;
  leaveRoom(roomCode: string): void;
  rooms(): string[];
  /** Resolves true if the frame was handed to an open stream, false on failure. */
  send(peerId: string, data: Uint8Array): Promise<boolean>;
  broadcast(data: Uint8Array, roomCode: string): Promise<void>;
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
  /**
   * Round-trip time to a peer in milliseconds, or null when it did not
   * answer within the timeout. Null means loss, never "very slow".
   */
  measureRtt(peerId: string, timeoutMs?: number): Promise<number | null>;
}

export interface VoiceEvents {
  trackAdded: (peerId: string, track: MediaStreamTrack) => void;
  trackRemoved: (peerId: string) => void;
  peerJoined: (peerId: string) => void;
  peerLeft: (peerId: string) => void;
  deviceChanged: (kind: "input" | "output", deviceId: string) => void;
  error: (err: Error) => void;
  status: (status: TransportStatus) => void;
}

/**
 * P2P audio - piggybacks on SimplePeer connections.
 * No SFU - fully private.
 * Implemented by SimplePeerVoice.
 */
export interface VoiceTransport {
  // lifecycle
  join(roomCode: string): Promise<void>;
  leave(): void;

  // mute - disables track, connection stays warm
  mute(): void;
  unmute(): void;
  isMuted(): boolean;

  // input device
  setInputDevice(deviceId: string): Promise<void>;
  getInputDevices(): Promise<MediaDeviceInfo[]>;
  getActiveInputDevice(): string | null;

  // input gain - 0.0 to 2.0, 1.0 = unity, >1.0 = boost
  setInputGain(gain: number): void;
  getInputGain(): number;

  // output device - routes remote audio to specific speaker
  setOutputDevice(deviceId: string): Promise<void>;
  getOutputDevices(): Promise<MediaDeviceInfo[]>;
  getActiveOutputDevice(): string | null;

  // output volume - 0.0 to 2.0, 1.0 = unity, >1.0 = boost via Web Audio
  setOutputVolume(volume: number): void;
  getOutputVolume(): number;

  // events
  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void;
  off<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void;

  // introspection
  activePeers(): string[];
}

export type VideoSource = "camera" | "screen";

/**
 * User-facing SFU failure banners. They live HERE, not in mediasoup.ts,
 * because that module is dynamically imported to stay out of the boot
 * bundle - and the healed-handler must compare against them without
 * pulling the whole SFU client in.
 */
export const SFU_UNREACHABLE =
  "Video server unreachable - voice still works, retrying in the background";
export const SFU_PUBLISH_UNAVAILABLE =
  "The video server is unavailable - camera and screen share are off until it is back";

export interface VideoEvents {
  trackAdded: (
    peerId: string,
    track: MediaStreamTrack,
    source: VideoSource
  ) => void;
  /** `kind` distinguishes which underlying track ended - a peer can lose
   *  camera or screen independently while the other keeps flowing. */
  trackRemoved: (
    peerId: string,
    source: VideoSource,
    kind: "audio" | "video"
  ) => void;
  peerJoined: (peerId: string) => void;
  peerLeft: (peerId: string) => void;
  /** Fired once when getStats sees 2 consecutive stalled samples on a
   *  consumer, right before it is closed and re-consumed. A later
   *  trackAdded for the same peer/source is the recovery signal - there is
   *  no separate "recovered" event. */
  trackStalled: (peerId: string, source: VideoSource) => void;
  /** Fired when a remote peer starts a screen-share transmission (opt-in: not auto-consumed). */
  transmissionAvailable: (peerId: string, producerId: string) => void;
  /** Fired when a remote peer's transmission ends (they stopped sharing or left). */
  transmissionEnded: (peerId: string) => void;
  /** Fired when output volume changes (0.0 to 1.0). */
  outputVolumeChanged: (volume: number) => void;
  /** Fired when a full SFU handshake completes - any "unreachable,
   *  retrying" banner on screen is stale from this moment. */
  healed: () => void;
  /** Fired when someone starts watching your screen share transmission. */
  transmissionWatched: (peerId: string) => void;
  /** Fired when someone stops watching your screen share transmission. */
  transmissionWatchEnded: (peerId: string) => void;
  error: (err: Error) => void;
}

/**
 * SFU video - routes video through mediasoup server.
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

  /** Start consuming a pending transmission from a remote peer. */
  watchTransmission(peerId: string, producerId: string): Promise<void>;
  /** Stop consuming the transmission from a remote peer (closes screen consumer). */
  stopWatchingTransmission(peerId: string): void;
  /** Returns all pending (not yet watched) transmissions: peerId → producerId. */
  getPendingTransmissions(): Map<string, string>;

  on<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  off<K extends keyof VideoEvents>(event: K, handler: VideoEvents[K]): void;
  activePeers(): string[];
  /** How many OTHER peers the SFU room held at last join - a primitive for
   *  cross-checking SFU room membership against the libp2p call roster. */
  roomPeerCount(): number;
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
  /**
   * Intrinsic pixel size, when the sender could measure it. Optional because
   * an older sender does not send it and because not everything is an image;
   * both cases render the way they always did. Untrusted on arrival - see
   * isSaneDimension.
   */
  width?: number;
  height?: number;
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
