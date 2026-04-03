import {
  playCameraOffSound,
  playCameraOnSound,
  playDeafenSound,
  playJoinSound,
  playLeaveSound,
  playMuteSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
  playUndeafenSound,
  playUnmuteSound,
} from "$lib/sounds";
import { MessageType } from "$lib/types/message";
import { encode } from "$lib/utils";
import {
  _transport,
  _video,
  _voice,
  connect,
  transportState,
} from "./transport.svelte";
import type { VideoSource } from "./types";
import { setTransmissionOutputVolume } from "./transmission.svelte";

let _voiceOutputBeforeDeafen = 1;
let _videoOutputBeforeDeafen = 1;
let _mutedBeforeDeafen = false;

export function _sendCallState(peerId?: string): void {
  const payload = encode({
    type: MessageType.CallState,
    muted: transportState.muted,
    deafened: transportState.deafened,
  });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

export function _sendCallPresence(peerId?: string): void {
  const payload = encode({
    type: MessageType.CallPresence,
    inCall: transportState.inCall,
    roomCode: transportState.inCall ? transportState.roomCode ?? undefined : undefined,
  });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

export async function joinCall(): Promise<void> {
  transportState.error = null;
  try {
    // Ensure transport is connected before joining voice
    if (!transportState.relayConnected) {
      await connect();
    }
    await _voice.join(transportState.roomCode ?? "");
    await _video.join(transportState.roomCode ?? "", _transport.selfId());
    transportState.inCall = true;
    transportState.callRoomCode = transportState.roomCode; // Track which room the call is in
    playJoinSound();
    _sendCallPresence();
    transportState.muted = _voice.isMuted();
    _sendCallState();
    transportState.localMicStream = _voice.getMicStream();
  } catch (err) {
    _voice.leave();
    _video.leave();
    transportState.inCall = false;
    transportState.callRoomCode = null;
    transportState.muted = false;
    transportState.localCameraStream = null;
    transportState.localScreenStream = null;
    transportState.localMicStream = null;
    transportState.cameraOff = true;
    transportState.screenSharing = false;
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function leaveCall(): void {
  if (transportState.inCall) {
    playLeaveSound();
    transportState.inCall = false;
    transportState.callRoomCode = null;
    _sendCallPresence();
  }
  stopCamera();
  stopScreenShare();
  _voice.leave();
  _video.leave();
  transportState.inCall = false;
  transportState.callRoomCode = null;
  transportState.muted = false;
  transportState.deafened = false;
  transportState.participants = new Map();
  transportState.localCameraStream = null;
  transportState.localScreenStream = null;
  transportState.localMicStream = null;
  transportState.cameraOff = true;
  transportState.screenSharing = false;
  transportState.sfuPeerIds = new Set();
  transportState.pendingTransmissions = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
}

export function toggleMute(): void {
  if (_voice.isMuted()) {
    _voice.unmute();
    playUnmuteSound();
  } else {
    _voice.mute();
    playMuteSound();
  }
  transportState.muted = _voice.isMuted();
  _sendCallState();
}

export async function startCamera(): Promise<void> {
  transportState.error = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    transportState.localCameraStream = stream;
    transportState.cameraOff = false;
    playCameraOnSound();
    await _video.startCamera(stream);
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopCamera(): void {
  transportState.localCameraStream?.getTracks().forEach((t) => t.stop());
  transportState.localCameraStream = null;
  transportState.cameraOff = true;
  playCameraOffSound();
  _video.stopCamera();
}

export async function toggleCamera(): Promise<void> {
  if (transportState.cameraOff) await startCamera();
  else stopCamera();
}

export async function startScreenShare(): Promise<void> {
  transportState.error = null;
  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new Error("Screen sharing is not supported on this device");
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: true,
    });
    transportState.localScreenStream = stream;
    transportState.screenSharing = true;
    playScreenShareStartSound();
    stream.getVideoTracks()[0].onended = () => stopScreenShare();
    await _video.startScreenShare(stream);
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopScreenShare(): void {
  transportState.localScreenStream?.getTracks().forEach((t) => t.stop());
  transportState.localScreenStream = null;
  transportState.screenSharing = false;
  playScreenShareStopSound();
  _video.stopScreenShare();
}

export function pauseVideo(source: VideoSource): void {
  _video.pauseVideo(source);
}
export function resumeVideo(source: VideoSource): void {
  _video.resumeVideo(source);
}

export function setDeafened(deafened: boolean): void {
  if (deafened) {
    // Save current states before deafening
    _voiceOutputBeforeDeafen = _voice.getOutputVolume();
    _videoOutputBeforeDeafen = transportState.transmissionOutputVolume;
    _mutedBeforeDeafen = transportState.muted;
    // Deafen (mute output)
    _voice.setOutputVolume(0);
    transportState.transmissionOutputVolume = 0;
    setTransmissionOutputVolume(0);
    // Also mute input if not already muted
    if (!_voice.isMuted()) {
      _voice.mute();
      transportState.muted = true;
    }
    transportState.deafened = true;
    playDeafenSound();
  } else {
    // Undeafen (restore output)
    _voice.setOutputVolume(_voiceOutputBeforeDeafen);
    transportState.transmissionOutputVolume = _videoOutputBeforeDeafen;
    setTransmissionOutputVolume(_videoOutputBeforeDeafen);
    // Restore mute state: unmute only if we weren't muted before deafening
    if (!_mutedBeforeDeafen && _voice.isMuted()) {
      _voice.unmute();
      transportState.muted = false;
    }
    transportState.deafened = false;
    playUndeafenSound();
  }
  _sendCallState();
}

export function toggleDeafen(): void {
  setDeafened(!transportState.deafened);
}
