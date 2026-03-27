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
