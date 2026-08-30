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
  _syncVoiceRoster,
  _transport,
  _video,
  _voice,
  connect,
  transportState,
} from "./transport.svelte";
import { setTransmissionOutputVolume } from "./transmission.svelte";
import {
  cancelErrorClear,
  describeMediaError,
  setErrorWithAutoClear,
} from "./call-error";

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
  // ...and directly to everyone we hold a connection to. Broadcast alone is
  // gossipsub, which is best effort and needs a formed mesh - somebody who has
  // just joined the topic may not be in anyone's mesh yet, so their "I am in
  // the call" could be dropped and not retried until the 20s heartbeat. Nobody
  // can dial a voice link to a peer they have not heard is in the call, so a
  // lost announcement is dead air for everyone else. The direct streams are
  // confirmed and already open; the frame is a few bytes.
  for (const pid of _transport.peers()) _transport.send(pid, payload);
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
 * finish, so a second tap on "Join call" used to re-enter and race the first,
 * building two audio pipelines against one microphone.
 */
let _joinPromise: Promise<void> | null = null;
/**
 * Set when the user leaves while a join is still in flight.
 *
 * leaveCall() only unwinds `if (transportState.inCall)`, which is false until
 * the very end of _joinCall - so pressing join then leave landed the user in a
 * call they had already backed out of, with the leave's own cleanup having run
 * first. The join checks this after each await and unwinds itself instead.
 */
let _joinAbandoned = false;

export function joinCall(): Promise<void> {
  if (_joinPromise) return _joinPromise;
  if (transportState.inCall) return Promise.resolve();
  _joinAbandoned = false;
  transportState.joiningCall = true;
  _joinPromise = _joinCall().finally(() => {
    _joinPromise = null;
    transportState.joiningCall = false;
  });
  return _joinPromise;
}

/** Thrown to unwind a join the user has already left. Never surfaced. */
const ABANDONED = Symbol("join abandoned");

function throwIfAbandoned(): void {
  if (_joinAbandoned) throw ABANDONED;
}

let _presenceHeartbeat: ReturnType<typeof setInterval> | null = null;

async function _joinCall(): Promise<void> {
  // Clear any pending error timeout and reset the error state. Attempting
  // the operation again makes any stale error irrelevant.
  cancelErrorClear();
  transportState.error = null;
  try {
    // Ensure transport is connected before joining voice
    if (!transportState.relayConnected) {
      await connect();
    }
    // Joining a call is the clearest signal there is that this person wants to
    // reach the others RIGHT NOW, so drop any accumulated dial backoff and
    // reconcile. A peer whose earlier dials failed sits in a wait that doubles
    // to a minute, and no voice link can exist before the peer connection
    // does - which is how hopping into a call ended up connecting to one
    // person immediately and the rest a couple of minutes later.
    throwIfAbandoned();
    _transport.reconcileNow();
    await _voice.join(transportState.roomCode ?? "");
    throwIfAbandoned();
    // Set before the first roster sync below: _syncVoiceRoster reads inCall
    // and callRoomCode to know who belongs in this call. Setting them AFTER
    // _video.join() used to hand the voice layer an empty roster (default-
    // deny, nobody admitted) for that whole network round trip - every
    // offer arriving in that window was silently dropped, sometimes for the
    // full 30s setup deadline (finding 6). Voice is peer-to-peer and does
    // not depend on the SFU, so there is no reason this waits for it.
    transportState.inCall = true;
    transportState.callRoomCode = transportState.roomCode; // Track which room the call is in
    _syncVoiceRoster();
    // Voice is peer-to-peer; only camera and screen share go through the SFU.
    // Awaiting this unguarded meant a media server that was down (or a VPS
    // whose DNS had moved) failed the whole join, taking out calls that never
    // needed it. Keep the call, say what is missing, heal in the background.
    try {
      await _video.join(transportState.roomCode ?? "", _transport.selfId());
    } catch {
      // The error event already put a readable message on transportState;
      // all that is left is to keep trying in the background.
      _video.ensureLive();
    }
    throwIfAbandoned();
    // Peers already in this call are known from their presence heartbeats -
    // sync again in case one arrived while _video.join() was in flight.
    _syncVoiceRoster();
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
    // An abandoned join is not a failure - the user left on purpose, and the
    // unwinding above is exactly the cleanup they asked for.
    if (err === ABANDONED) return;
    // Set error with auto-clear: transient permission errors should not persist
    // indefinitely on screen. If the join fails for another reason, the error
    // still clears after 10 seconds or when the user attempts to join again.
    setErrorWithAutoClear(transportState, describeMediaError(err));
    throw err;
  }
}

export function leaveCall(): void {
  // Tell any in-flight join to unwind. Without this the join runs to
  // completion after the user has left and puts them back in the call.
  if (_joinPromise) _joinAbandoned = true;
  // Clear any pending error auto-clear timer and the error itself. Once the
  // user leaves the call, any call-related error (like a permission denial
  // during camera startup) becomes stale.
  cancelErrorClear();
  transportState.error = null;

  // Close any open browser PiP window when the call ends.
  if (typeof document !== "undefined" && document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }

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
  // Deafened, then left: setOutputVolume(0) zeroed _voice's persisted gain
  // and leave() never resets it, so the NEXT join seeded every peer's gain
  // node at 0 while the deafen icon read normal (finding 5). setDeafened(
  // false) restores it to what it was before deafening; guarded so a
  // non-deafened leave (the common path) does not play the undeafen chime.
  if (transportState.deafened) setDeafened(false);
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
  // Clear any pending error timeout and reset the error state. Attempting
  // the operation again makes any stale error irrelevant.
  cancelErrorClear();
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
    try {
      await _video.startCamera(stream);
    } catch (err) {
      // Publishing can fail for real now that a call survives a dead SFU. The
      // state was set before the await, so without this the camera light stays
      // on and the UI says you are on camera while nobody receives anything.
      stream.getTracks().forEach((t) => t.stop());
      transportState.localCameraStream = null;
      transportState.cameraOff = true;
      throw err;
    }
  } catch (err) {
    // Set error with auto-clear: permission errors should not persist
    // indefinitely on screen. The user is still in the call after camera
    // startup fails, so the error clears when they retry or when the timer
    // expires.
    setErrorWithAutoClear(transportState, describeMediaError(err));
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

/**
 * In-flight guards for the media toggles.
 *
 * startCamera/startScreenShare await getUserMedia/getDisplayMedia, which can
 * sit for seconds behind a permission prompt. Nothing stopped a second press
 * in that window, so a start and a stop could interleave and leave the flag
 * and the actual track disagreeing.
 */
let _cameraPromise: Promise<void> | null = null;
let _screenPromise: Promise<void> | null = null;

export function toggleCamera(): Promise<void> {
  if (_cameraPromise) return _cameraPromise;
  transportState.cameraPending = true;
  _cameraPromise = (async () => {
    if (transportState.cameraOff) await startCamera();
    else stopCamera();
  })()
    .catch(() => {
      // startCamera already reported it through transportState.error.
    })
    .finally(() => {
      _cameraPromise = null;
      transportState.cameraPending = false;
    });
  return _cameraPromise;
}

export function toggleScreenShare(): Promise<void> {
  if (_screenPromise) return _screenPromise;
  transportState.screenSharePending = true;
  _screenPromise = (async () => {
    if (transportState.screenSharing) stopScreenShare();
    else await startScreenShare();
  })()
    .catch(() => {
      // startScreenShare already reported it through transportState.error.
    })
    .finally(() => {
      _screenPromise = null;
      transportState.screenSharePending = false;
    });
  return _screenPromise;
}

export async function startScreenShare(): Promise<void> {
  // Clear any pending error timeout and reset the error state. Attempting
  // the operation again makes any stale error irrelevant.
  cancelErrorClear();
  transportState.error = null;
  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new Error("Screen sharing is not supported on this device");
  }
  try {
    // Game and media audio verbatim: mic-style processing (AEC, noise
    // suppression, AGC) mangles music and adds nothing to a loopback
    // capture. The extra hints are Chromium-only and ignored elsewhere:
    // they surface the audio checkbox for screens, hide our own tab from
    // the picker, and let the sharer switch surfaces mid-share.
    const options = {
      video: { frameRate: { ideal: 30 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Stereo at full rate: without asking, Chromium hands over mono.
        channelCount: 2,
        sampleRate: 48000,
      },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    } as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getDisplayMedia(options);
    // Whole-screen audio loops the call itself back into the stream, so
    // everyone hears their own voice with a delay. Window audio (Chrome or
    // Edge on Windows) carries only that app's sound - tell the sharer.
    const surface = stream
      .getVideoTracks()[0]
      ?.getSettings?.().displaySurface;
    if (surface === "monitor" && stream.getAudioTracks().length > 0) {
      _transport.announce({
        type: "app-warning",
        message:
          "Sharing the whole screen sends ALL system audio - people will hear themselves. Share the game window instead (with 'Also share audio') to send only its sound.",
      });
    }
    // "music" keeps the browser's encoder from treating loopback audio as
    // speech. Video hint stays unset: "motion" would smooth games but smear
    // shared text, and we cannot know which this share is.
    for (const track of stream.getAudioTracks()) track.contentHint = "music";
    transportState.localScreenStream = stream;
    transportState.screenSharing = true;
    playScreenShareStartSound();
    stream.getVideoTracks()[0].onended = () => stopScreenShare();
    try {
      await _video.startScreenShare(stream);
    } catch (err) {
      // As with the camera: otherwise we advertise a transmission that does
      // not exist and the browser keeps the capture indicator up.
      stream.getTracks().forEach((t) => t.stop());
      transportState.localScreenStream = null;
      transportState.screenSharing = false;
      throw err;
    }
  } catch (err) {
    // Set error with auto-clear: permission errors should not persist
    // indefinitely on screen. The user is still in the call after screen share
    // startup fails, so the error clears when they retry or when the timer
    // expires.
    setErrorWithAutoClear(transportState, describeMediaError(err));
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
