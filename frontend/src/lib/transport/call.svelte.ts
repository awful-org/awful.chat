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
  // The room the CALL is in, not the one on screen. Reporting the current room
  // meant that as soon as you looked at another room, everyone filtered you
  // out of the call you were actually sitting in and you vanished from it.
  const callRoom = transportState.inCall
    ? transportState.callRoomCode ?? transportState.roomCode ?? undefined
    : undefined;
  const payload = encode({
    type: MessageType.CallPresence,
    inCall: transportState.inCall,
    roomCode: callRoom,
  });
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  // Announce into the call's room, and into the room on screen when they
  // differ, so peers in either place hear about it.
  const rooms = new Set(
    [callRoom, transportState.roomCode].filter((r): r is string => !!r)
  );
  for (const room of rooms) _transport.broadcast(payload, room);
}

// Keep the screen awake for the duration of a call. The browser drops the lock
// whenever the page is hidden, so re-take it when the user comes back.
let _wakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    if (!("wakeLock" in navigator) || _wakeLock) return;
    _wakeLock = await navigator.wakeLock.request("screen");
    _wakeLock.addEventListener("release", () => {
      _wakeLock = null;
    });
  } catch {
    // Denied or unsupported - a call without a wake lock still works.
  }
}

function releaseWakeLock(): void {
  _wakeLock?.release().catch(() => {});
  _wakeLock = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && transportState.inCall) acquireWakeLock();
  });
}

/**
 * In flight join. `transportState.inCall` only flips once the awaits below
 * finish, so a second tap on "Join call" used to re-enter and race the first:
 * both registered the /voice/1.0.0 handler and libp2p threw "Handler already
 * registered", failing the whole join.
 */
let _joinPromise: Promise<void> | null = null;

export function joinCall(): Promise<void> {
  if (_joinPromise) return _joinPromise;
  if (transportState.inCall) return Promise.resolve();
  _joinPromise = _joinCall().finally(() => {
    _joinPromise = null;
  });
  return _joinPromise;
}

let _presenceHeartbeat: ReturnType<typeof setInterval> | null = null;

async function _joinCall(): Promise<void> {
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
    acquireWakeLock();
    playJoinSound();
    _sendCallPresence();
    // Heartbeat: peers expire silent roster entries after 60s, so a healthy
    // call re-announces itself well inside that window.
    _presenceHeartbeat = setInterval(() => _sendCallPresence(), 20_000);
    transportState.muted = _voice.isMuted();
    _sendCallState();
    transportState.localMicStream = _voice.getMicStream();
  } catch (err) {
    releaseWakeLock();
    if (_presenceHeartbeat) {
      clearInterval(_presenceHeartbeat);
      _presenceHeartbeat = null;
    }
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
  releaseWakeLock();
  if (_presenceHeartbeat) {
    clearInterval(_presenceHeartbeat);
    _presenceHeartbeat = null;
  }
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
  transportState.transmissionViewers = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
}

export function toggleMute(): void {
  if (_voice.isMuted()) {
    // Deafening mutes the mic too, so unmuting while deafened would leave you
    // talking to people you cannot hear. Lift the deafen as well.
    const wasDeafened = transportState.deafened;
    if (wasDeafened) setDeafened(false);
    // setDeafened restores the mute state from before the deafen, which can
    // leave the mic muted - unmuting is what was actually asked for.
    if (_voice.isMuted()) _voice.unmute();
    // The undeafen sound already played; two cues back to back is noise.
    if (!wasDeafened) playUnmuteSound();
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
