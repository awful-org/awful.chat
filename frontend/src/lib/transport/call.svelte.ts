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
import { keepScreenAwake } from "$lib/screen-awake";
import { MessageType } from "$lib/types/message";
import { encode } from "$lib/utils";
import {
  _syncVoiceRoster,
  _transport,
  _video,
  _voice,
  connect,
  sendCallCard,
  transportState,
} from "./transport.svelte";
import {
  _sendWatchPresence,
  setTransmissionOutputVolume,
} from "./transmission.svelte";
import {
  buildShareOptions,
  classifyShareAudio,
  shareVideoEncoding,
} from "./share-audio";
import { loadAudioPrefs, saveAudioPrefs } from "./audio-prefs";
import { cameraCaptureConstraints, isHandheld, openCamera } from "./camera-quality";
import { openCameraPicker, openSharePicker } from "$lib/ui-state.svelte";
import { resetPeerQuality } from "$lib/call-peer-quality.svelte";
import {
  cancelErrorClear,
  describeMediaError,
  describeShareError,
  setErrorWithAutoClear,
} from "./call-error";
import { foldCallCards, newCallId, type CallCardPayload } from "$lib/call-card";
import { callStartSeen, noteDmCallJoined } from "$lib/dm-call-joined";
import { wireCallStatus } from "$lib/call-status";
import { ownCallStatus } from "$lib/call-status.svelte";
import {
  DEFAULT_VOICE_CHANNEL,
  callPresenceFields,
  isVoiceChannel,
  peersInCall,
  roomHasVoiceChannels,
} from "./voice-channel";
import { restorePicture } from "$lib/camera-picture";

let _voiceOutputBeforeDeafen = 1;
let _videoOutputBeforeDeafen = 1;
let _mutedBeforeDeafen = false;
export function _sendCallState(peerId?: string): void {
  const secureCallRoom = transportState.callRoomCode ?? transportState.roomCode;
  if (secureCallRoom && _transport.isSecureRoom(secureCallRoom)) {
    const payload = encode({
      type: MessageType.CallState,
      muted: transportState.muted,
      deafened: transportState.deafened,
      status: wireCallStatus(ownCallStatus()),
    });
    if (peerId) void _transport.sendRoom(peerId, secureCallRoom, payload);
    else _transport.broadcast(payload, secureCallRoom);
    return;
  }
  const payload = encode({
    type: MessageType.CallState,
    muted: transportState.muted,
    deafened: transportState.deafened,
  });
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  // Same lesson _sendCallPresence learned: the state belongs to the CALL's
  // room, not the room on screen. Muting while looking at another room
  // broadcast into the wrong topic, so everyone in the call - and the call
  // preview - kept the stale mute/deafen badge until a reconnect.
  const rooms = new Set(
    [transportState.callRoomCode, transportState.roomCode].filter(
      (r): r is string => !!r
    )
  );
  for (const room of rooms) _transport.broadcast(payload, room);
  // ...and directly, for the reason _sendCallPresence spells out below. This
  // one never got that half, so a mute that lost its gossip frame stayed
  // wrong on everyone else's screen. The 20s heartbeat did not save it: a
  // frame is not dropped at random, it is dropped because the sender is in
  // nobody's mesh for that topic, and repeating a broadcast down a path that
  // is not there just fails again every 20 seconds.
  for (const pid of _directTargets(rooms)) _transport.send(pid, payload);
}

/**
 * The peers a direct copy of a call frame may go to: the members, per the
 * relay, of the rooms the same frame is being broadcast into.
 *
 * These loops used to walk _transport.peers() - EVERY peer holding a
 * connection to us, and any peer that knows our permanent peerId can open
 * one. A CallPresence frame carries the call's room code, and a room code is
 * that room's entire membership secret (gossipsub topic, rendezvous key, SFU
 * join key), so the belt-and-braces direct copy quietly handed it to
 * strangers 20 seconds at a time.
 */
function _directTargets(rooms: Set<string>): Set<string> {
  const targets = new Set<string>();
  for (const room of rooms) {
    for (const pid of _transport.peersInRoom(room)) targets.add(pid);
  }
  return targets;
}

/**
 * `leftRoom` is for the leave: by the time it goes out callRoomCode is already
 * cleared, and without it the leave was sent to the room on screen - so
 * hanging up from another room (the PiP panel's button) left everyone in the
 * call with a ghost of us until the 60s sweep.
 */
export function _sendCallPresence(peerId?: string, leftRoom?: string | null): void {
  // The room the CALL is in, not the one on screen. Reporting the current room
  // meant that as soon as you looked at another room, everyone filtered you
  // out of the call you were actually sitting in and you vanished from it.
  const callRoom = transportState.inCall
    ? transportState.callRoomCode ?? transportState.roomCode ?? undefined
    : undefined;
  // The voice channel rides in the same frame, so it reaches exactly the
  // people the room code does - the members of the call's room - and nobody
  // outside the room learns who sits in which channel.
  const payload = encode({
    type: MessageType.CallPresence,
    ...callPresenceFields(callRoom ? { roomCode: callRoom, voiceChannel: transportState.callVoiceChannel } : null),
  });
  const secureCallRoom = leftRoom ?? transportState.callRoomCode ?? transportState.roomCode;
  if (secureCallRoom && _transport.isSecureRoom(secureCallRoom)) {
    if (peerId) void _transport.sendRoom(peerId, secureCallRoom, payload);
    else _transport.broadcast(payload, secureCallRoom);
    return;
  }
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  // Announce into the call's room, and into the room on screen when they
  // differ, so peers in either place hear about it.
  const rooms = new Set(
    [callRoom, leftRoom, transportState.roomCode].filter((r): r is string => !!r)
  );
  for (const room of rooms) _transport.broadcast(payload, room);
  // ...and directly to everyone we hold a connection to. Broadcast alone is
  // gossipsub, which is best effort and needs a formed mesh - somebody who has
  // just joined the topic may not be in anyone's mesh yet, so their "I am in
  // the call" could be dropped and not retried until the 20s heartbeat. Nobody
  // can dial a voice link to a peer they have not heard is in the call, so a
  // lost announcement is dead air for everyone else. The direct streams are
  // confirmed and already open; the frame is a few bytes.
  for (const pid of _directTargets(rooms)) _transport.send(pid, payload);
}

// Keep the screen awake for the duration of a call.
let _releaseScreen: (() => void) | null = null;

function keepCallScreenAwake(): void {
  _releaseScreen ??= keepScreenAwake();
}

function releaseCallScreen(): void {
  _releaseScreen?.();
  _releaseScreen = null;
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

// ── DM call cards (call-card.ts) ───────────────────────────────────────────

/** The DM call this device is in, for its end card. One call at a time. */
let _dmCall: { roomCode: string; callId: string; startedAt: number; joinedAt: number } | null = null;

/**
 * A call's length as this device measures it, on its own clock only. From
 * when it saw the call start (its own start, or a start card arriving live);
 * a call already running before this device heard of it is counted from
 * the card's time, the caller's clock - but never as shorter than the time
 * this device was in it.
 */
function _measuredLength(call: { startedAt: number; joinedAt: number }, endedAt: number): number {
  return Math.max(0, endedAt - call.startedAt, endedAt - call.joinedAt);
}

/** Someone other than us is in this DM's call right now. A DM has only its
 *  default voice channel, so that is the one asked about. */
function _othersInCall(roomCode: string): boolean {
  const call = { roomCode, voiceChannel: DEFAULT_VOICE_CHANNEL };
  return peersInCall(transportState.callPeerRooms, transportState.callPeerVoiceChannels, call).length > 0;
}

/** The newest started call in this DM with no end card yet, from the view. */
function _openCallCard(roomCode: string): CallCardPayload | null {
  const rows = transportState.messages.filter((m) => m.roomCode === roomCode);
  return foldCallCards(rows, MessageType.CallEvent).open?.card ?? null;
}

/**
 * Joining a DM call: alone in it, this starts a call and posts its card;
 * with the other side already in, it joins theirs. Either way this device
 * took part, so its card will never read "missed" here. `openAtStart` is the
 * open card as the join began: the view may have moved to another room
 * during the join's awaits, taking this DM's rows with it.
 */
function _noteDmCallJoin(roomCode: string, openAtStart: CallCardPayload | null): void {
  if (!roomCode.startsWith("dm-")) return;
  if (_othersInCall(roomCode)) {
    const open = _openCallCard(roomCode) ?? openAtStart;
    if (!open) return;
    _dmCall = { roomCode, callId: open.callId, startedAt: callStartSeen(open.callId) ?? open.at, joinedAt: Date.now() };
    noteDmCallJoined(open.callId);
    return;
  }
  const callId = newCallId();
  const startedAt = Date.now();
  _dmCall = { roomCode, callId, startedAt, joinedAt: startedAt };
  noteDmCallJoined(callId);
  void sendCallCard(roomCode, { v: 1, callId, phase: "start", at: startedAt }).catch(() => {});
}

/**
 * A DM call this device left while someone was still in it. If they never
 * post its end - they hung up at the same moment, so each still saw the
 * other; their app crashed or the tab closed - whoever notices it empty
 * posts it instead, on the presence update that shows it so. Both sides
 * doing so is harmless: the view keeps the earliest end.
 */
let _leftOpenDmCall: { roomCode: string; callId: string; startedAt: number; joinedAt: number; leftAt: number } | null = null;

/** Leaving a DM call: the last one out posts its end card. */
function _noteDmCallLeave(roomCode: string): void {
  const call = _dmCall?.roomCode === roomCode ? _dmCall : null;
  _dmCall = null;
  if (!call) return;
  if (_othersInCall(roomCode)) {
    _leftOpenDmCall = { ...call, leftAt: Date.now() };
    return;
  }
  const now = Date.now();
  void sendCallCard(roomCode, { v: 1, callId: call.callId, phase: "end", at: now, duration: _measuredLength(call, now) }).catch(() => {});
}

// Event-driven, not timed: re-checked on every change to who is in which
// call. Ends as soon as the call it watches is seen empty, or we rejoin.
$effect.root(() => {
  $effect(() => {
    const presence = transportState.callPeerRooms;
    const left = _leftOpenDmCall;
    if (!left) return;
    if (transportState.inCall && transportState.callRoomCode === left.roomCode) {
      _leftOpenDmCall = null;
      return;
    }
    if ([...presence.values()].includes(left.roomCode)) return;
    _leftOpenDmCall = null;
    // The moment the last of them was seen gone is when we left at the
    // latest: the end reads when we hung up, which is when it ended for us.
    void sendCallCard(left.roomCode, { v: 1, callId: left.callId, phase: "end", at: left.leftAt, duration: _measuredLength(left, left.leftAt) }).catch(() => {});
  });
});

/** The voice channel the join or switch in flight is for. */
let _joinTarget = DEFAULT_VOICE_CHANNEL;
/**
 * Bumped by every leaveCall. A join for another channel pressed while one is
 * still in flight waits for that one to land; if the user hung up meanwhile,
 * the hang-up was the later wish and the waiting join must not undo it.
 */
let _leaveCount = 0;

/**
 * Join a voice channel of the room on screen: the room's default call when
 * none is named, as it always was.
 *
 * Already in a call in this same room, in another channel: moves there, as
 * one step (switchVoiceChannel) - the microphone, mute and deafen carry
 * over, and the transport room is never left. Already in a call in another
 * room: a no-op, as it always was; callers hang up first, on purpose, since
 * that is leaving a room's call for another room's.
 *
 * A malformed channel id is refused, and so is any channel but the default
 * in a DM: a DM has only its one call.
 */
export function joinCall(voiceChannel: string = DEFAULT_VOICE_CHANNEL): Promise<void> {
  if (!isVoiceChannel(voiceChannel)) return Promise.reject(new Error("Invalid voice channel"));
  if (_joinPromise) {
    if (_joinTarget === voiceChannel) return _joinPromise;
    // Event-driven: the next step starts when the one in flight settles.
    // Only in the room it was pressed in: a channel id is one room's, and
    // once another room is on screen the waiting join would land in a
    // channel of that room nobody chose (the first join having failed).
    const leaves = _leaveCount;
    const room = transportState.roomCode;
    return _joinPromise
      .catch(() => {})
      .then(() =>
        leaves === _leaveCount && transportState.roomCode === room ? joinCall(voiceChannel) : undefined
      );
  }
  if (transportState.inCall) {
    if (
      transportState.callRoomCode &&
      transportState.callRoomCode === transportState.roomCode &&
      transportState.callVoiceChannel !== voiceChannel
    ) {
      return switchVoiceChannel(voiceChannel);
    }
    return Promise.resolve();
  }
  const room = transportState.roomCode;
  if (voiceChannel !== DEFAULT_VOICE_CHANNEL && !_channelsAllowedIn(room)) {
    return Promise.reject(new Error("This conversation has no voice channels"));
  }
  _joinAbandoned = false;
  _joinTarget = voiceChannel;
  transportState.joiningCall = true;
  _joinPromise = _joinCall(voiceChannel).finally(() => {
    _joinPromise = null;
    transportState.joiningCall = false;
  });
  return _joinPromise;
}

/**
 * Voice channels need a protected group room: a DM has one call, and a
 * legacy room's SFU id is its own code, the same for every channel.
 */
function _channelsAllowedIn(room: string | null): room is string {
  return !!room && roomHasVoiceChannels(room) && _transport.isSecureRoom(room);
}

/**
 * Move our call to another voice channel of the room it is in.
 *
 * The voice mesh is not rebuilt: its links follow the roster, so changing
 * which channel the roster is for tears down the old channel's links and
 * dials the new one's, with the same microphone, mute and deafen. The SFU is
 * left and joined again, since each channel has its own SFU room - so a
 * camera or a screen share, published into the old one, is stopped, and
 * whatever we watched there is gone.
 *
 * Nobody is left with a ghost of us: the presence that says where we are now
 * also says where we are not, and everyone in the room gets it. One that
 * goes missing is repaired by the 20s heartbeat, long before the 60s sweep.
 *
 * Not in a call, or asked for the channel we are in: does what joinCall does.
 */
export function switchVoiceChannel(voiceChannel: string): Promise<void> {
  if (!isVoiceChannel(voiceChannel)) return Promise.reject(new Error("Invalid voice channel"));
  if (_joinPromise || !transportState.inCall) return joinCall(voiceChannel);
  if (transportState.callVoiceChannel === voiceChannel) return Promise.resolve();
  const room = transportState.callRoomCode;
  if (voiceChannel !== DEFAULT_VOICE_CHANNEL && !_channelsAllowedIn(room)) {
    return Promise.reject(new Error("This conversation has no voice channels"));
  }
  _joinAbandoned = false;
  _joinTarget = voiceChannel;
  transportState.joiningCall = true;
  _joinPromise = _switchVoiceChannel(room ?? "", voiceChannel).finally(() => {
    _joinPromise = null;
    transportState.joiningCall = false;
  });
  return _joinPromise;
}

async function _switchVoiceChannel(room: string, voiceChannel: string): Promise<void> {
  cancelErrorClear();
  transportState.error = null;
  // Published into the old channel's SFU room, which we are about to leave
  // (and leaving it stops their tracks anyway): stop them properly, so the
  // state and the browser's capture indicator agree.
  if (!transportState.cameraOff) stopCamera();
  if (transportState.screenSharing) stopScreenShare();
  _video.leave();
  // Per-peer voice verdicts are about links that are about to go.
  resetPeerQuality();
  transportState.callVoiceChannel = voiceChannel;
  // The roster now names the new channel: the old channel's links go down
  // here, before the presence below lets anyone in it think we still answer.
  _syncVoiceRoster();
  transportState.participants = new Map();
  transportState.pendingTransmissions = new Map();
  transportState.transmissionViewers = new Map();
  transportState.watchingTransmissions = new Map();
  _sendCallPresence();
  _sendWatchPresence();
  playJoinSound();
  try {
    await _video.join(room, _transport.selfId(), voiceChannel);
  } catch {
    // As in a join: the call stands without the SFU, which heals behind it.
    _video.ensureLive();
  }
  if (_joinAbandoned) {
    // Hung up while the SFU join was out: leaveCall has unwound everything
    // else already, and left a session it did not know was coming.
    _video.leave();
    return;
  }
  _syncVoiceRoster();
  _sendCallPresence();
}

/** Thrown to unwind a join the user has already left. Never surfaced. */
const ABANDONED = Symbol("join abandoned");

function throwIfAbandoned(): void {
  if (_joinAbandoned) throw ABANDONED;
}

let _presenceHeartbeat: ReturnType<typeof setInterval> | null = null;

async function _joinCall(voiceChannel: string): Promise<void> {
  // Browsing another room while connect/microphone permission is pending
  // must not split voice, presence and video across different rooms.
  const callRoom = transportState.roomCode;
  const openCallAtStart = callRoom?.startsWith("dm-") ? _openCallCard(callRoom) : null;
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
    await _voice.join(callRoom ?? "");
    throwIfAbandoned();
    // Set before the first roster sync below: _syncVoiceRoster reads inCall
    // and callRoomCode to know who belongs in this call. Setting them AFTER
    // _video.join() used to hand the voice layer an empty roster (default-
    // deny, nobody admitted) for that whole network round trip - every
    // offer arriving in that window was silently dropped, sometimes for the
    // full 30s setup deadline (finding 6). Voice is peer-to-peer and does
    // not depend on the SFU, so there is no reason this waits for it.
    transportState.inCall = true;
    transportState.callRoomCode = callRoom;
    transportState.callVoiceChannel = voiceChannel;
    if (callRoom) _noteDmCallJoin(callRoom, openCallAtStart);
    _syncVoiceRoster();
    // Announce BEFORE the SFU join: presence is what lets everyone else
    // dial us, voice is P2P and does not need the SFU - and a dead or slow
    // media server used to sit its full request timeout between us joining
    // and anyone learning we had.
    _sendCallPresence();
    // Heartbeat: peers expire silent roster entries after 60s, so a healthy
    // call re-announces itself well inside that window. Watch presence and
    // mute/deafen state ride along: both are one-shot gossipsub broadcasts
    // otherwise, and one lost frame left the "who is watching" list or a
    // badge wrong until that peer's next change. Idempotent, so replaying
    // them every beat costs nothing and makes the lists self-healing.
    _presenceHeartbeat = setInterval(() => {
      _sendCallPresence();
      _sendCallState();
      _sendWatchPresence();
    }, 20_000);
    // Voice is peer-to-peer; only camera and screen share go through the SFU.
    // Awaiting this unguarded meant a media server that was down (or a VPS
    // whose DNS had moved) failed the whole join, taking out calls that never
    // needed it. Keep the call, say what is missing, heal in the background.
    try {
      await _video.join(callRoom ?? "", _transport.selfId(), voiceChannel);
      // Presence is announced before SFU join, so even a zero-peer snapshot
      // cannot prove node misplacement. Transport failures have their own
      // error/recovery path; do not turn a normal join race into a fatal warning.
    } catch {
      // The error event already put a readable message on transportState;
      // all that is left is to keep trying in the background.
      _video.ensureLive();
    }
    throwIfAbandoned();
    // Peers already in this call are known from their presence heartbeats -
    // sync again in case one arrived while _video.join() was in flight.
    _syncVoiceRoster();
    keepCallScreenAwake();
    playJoinSound();
    // A second announce after the SFU join: cheap, and covers a peer whose
    // first one raced the transport still settling.
    _sendCallPresence();
    transportState.muted = _voice.isMuted();
    _sendCallState();
    transportState.localVoiceStream = _voice.getSentStream();
  } catch (err) {
    releaseCallScreen();
    if (_presenceHeartbeat) {
      clearInterval(_presenceHeartbeat);
      _presenceHeartbeat = null;
    }
    _voice.leave();
    _video.leave();
    transportState.inCall = false;
    transportState.callRoomCode = null;
    transportState.callVoiceChannel = DEFAULT_VOICE_CHANNEL;
    transportState.muted = false;
    transportState.localCameraStream = null;
    transportState.localScreenStream = null;
    transportState.localVoiceStream = null;
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
  _leaveCount++;
  // Clear any pending error auto-clear timer and the error itself. Once the
  // user leaves the call, any call-related error (like a permission denial
  // during camera startup) becomes stale.
  cancelErrorClear();
  transportState.error = null;

  // Close any open browser PiP window when the call ends.
  if (typeof document !== "undefined" && document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }

  releaseCallScreen();
  if (_presenceHeartbeat) {
    clearInterval(_presenceHeartbeat);
    _presenceHeartbeat = null;
  }
  // Per-peer voice verdicts are about links that no longer exist.
  resetPeerQuality();
  if (transportState.inCall) {
    playLeaveSound();
    const leftRoom = transportState.callRoomCode;
    transportState.inCall = false;
    transportState.callRoomCode = null;
    transportState.callVoiceChannel = DEFAULT_VOICE_CHANNEL;
    _sendCallPresence(undefined, leftRoom);
    if (leftRoom) _noteDmCallLeave(leftRoom);
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
  transportState.callVoiceChannel = DEFAULT_VOICE_CHANNEL;
  transportState.muted = false;
  transportState.deafened = false;
  transportState.participants = new Map();
  transportState.localCameraStream = null;
  transportState.localScreenStream = null;
  transportState.localVoiceStream = null;
  transportState.cameraOff = true;
  transportState.screenSharing = false;
  transportState.pendingTransmissions = new Map();
  transportState.transmissionViewers = new Map();
  transportState.watchingTransmissions = new Map();
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

/** Set by cameras.svelte, which cannot be imported here without a cycle. */
let _onCameraStarted: (() => void) | null = null;

export function onCameraStarted(fn: () => void): void {
  _onCameraStarted = fn;
}

export async function startCamera(): Promise<void> {
  // Clear any pending error timeout and reset the error state. Attempting
  // the operation again makes any stale error irrelevant.
  cancelErrorClear();
  transportState.error = null;
  try {
    // The chosen camera, or whatever is there if it has since been unplugged
    // (or an iPhone stopped offering itself), rather than no video at all.
    // 1080p on a computer, 720p on a phone: see camera-quality.ts.
    const stream = await openCamera(
      loadAudioPrefs().cameraDevice,
      cameraCaptureConstraints(isHandheld())
    );
    // What was chosen for this camera's picture last time (camera-picture.ts),
    // before anyone sees it.
    const cameraTrack = stream.getVideoTracks()[0];
    if (cameraTrack) await restorePicture(cameraTrack);
    transportState.localCameraStream = stream;
    transportState.cameraOff = false;
    // Permission has just been granted, if it had not been before, so the
    // device labels the browser was withholding are now readable. Told
    // rather than polled, and deliberately not imported: cameras.svelte
    // imports THIS module to restart a camera, so a direct call would be a
    // cycle.
    _onCameraStarted?.();
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

/**
 * What every "Turn on camera" button does: stop if already on, otherwise
 * open the device picker, which starts the camera itself once one is
 * chosen. Mirrors shareScreenPressed below.
 */
export function cameraOnPressed(): void {
  if (!transportState.cameraOff) void toggleCamera();
  else openCameraPicker();
}

/**
 * What every "Share screen" button does: stop if sharing, otherwise open
 * the quality picker, which starts the share itself.
 */
export function shareScreenPressed(): void {
  if (transportState.screenSharing) void toggleScreenShare();
  else openSharePicker();
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

/**
 * Starts (or accepts a pre-captured) screen share, then decides whether its
 * audio track is safe to send.
 *
 * `stream` lets a caller that already ran getDisplayMedia hand the result
 * straight in - the VideoTransport interface has always supported this (see
 * types.ts) to avoid a second capture prompt. Either way the resulting
 * track's REAL settings get classified: what we asked for and what the
 * platform actually did can differ, and only the actual settings say
 * whether the echo is really gone.
 */
export async function startScreenShare(stream?: MediaStream): Promise<void> {
  // Clear any pending error timeout and reset the error state. Attempting
  // the operation again makes any stale error irrelevant.
  cancelErrorClear();
  transportState.error = null;
  if (!stream && !navigator.mediaDevices.getDisplayMedia) {
    throw new Error("Screen sharing is not supported on this device");
  }
  try {
    const prefs = loadAudioPrefs();
    const captured =
      stream ??
      (await navigator.mediaDevices.getDisplayMedia(
        buildShareOptions(navigator.mediaDevices.getSupportedConstraints(), prefs)
      ));

    // Content hints complement FPS/resolution caps: they tell the encoder
    // which to favor when CPU or bandwidth cannot sustain both.
    for (const track of captured.getVideoTracks()) {
      if ("contentHint" in track) track.contentHint = prefs.shareContentHint;
    }
    // Keep loopback audio out of speech-oriented processing.
    for (const track of captured.getAudioTracks())
      track.contentHint = "music";

    // windowAudio degrades to system audio SILENTLY, and
    // getSupportedConstraints().restrictOwnAudio lies on platforms (Linux)
    // that can never honour it - so classify what the live tracks actually
    // report, never what was requested.
    const videoTrack = captured.getVideoTracks()[0];
    let audioTrack: MediaStreamTrack | null =
      captured.getAudioTracks()[0] ?? null;
    const verdict = classifyShareAudio(
      videoTrack?.getSettings() ?? {},
      audioTrack?.getSettings() ?? null
    );

    if (verdict.kind === "echo-risk" && audioTrack) {
      if (prefs.shareAudioDespiteEchoRisk) {
        _transport.announce({
          type: "app-warning",
          message: `${verdict.message} Sending it anyway - "Send screen-share audio despite echo risk" is on in Settings > Audio.`,
        });
      } else {
        // Default to safety: withhold the track so nobody hears themselves.
        // Stop it too, or the OS-level capture session for audio nobody
        // gets stays alive for the rest of the share.
        audioTrack.stop();
        captured.removeTrack(audioTrack);
        audioTrack = null;
        _transport.announce({
          type: "app-warning",
          message: verdict.message,
        });
      }
    }

    if (audioTrack) {
      // The spec mandates a muted track when own-audio suppression leaves
      // nothing to send, and a default-output-device change mid-share is a
      // known real cause (crbug 1432877) - either way, tell the sharer
      // rather than let the share go silently dead.
      audioTrack.onmute = () => {
        _transport.announce({
          type: "app-warning",
          message:
            "This share's audio went silent - often caused by switching audio output devices mid-share.",
        });
      };
      audioTrack.onunmute = () => {
        _transport.announce({
          type: "app-warning",
          message: "This share's audio is back.",
        });
      };
    }

    transportState.localScreenStream = captured;
    transportState.screenSharing = true;
    playScreenShareStartSound();
    videoTrack.onended = () => stopScreenShare();
    try {
      await _video.startScreenShare(captured, shareVideoEncoding(prefs));
    } catch (err) {
      // As with the camera: otherwise we advertise a transmission that does
      // not exist and the browser keeps the capture indicator up.
      captured.getTracks().forEach((t) => t.stop());
      transportState.localScreenStream = null;
      transportState.screenSharing = false;
      throw err;
    }
  } catch (err) {
    // Set error with auto-clear: permission errors should not persist
    // indefinitely on screen. The user is still in the call after screen share
    // startup fails, so the error clears when they retry or when the timer
    // expires. A closed picker is no error at all (describeShareError).
    const message = describeShareError(err);
    if (message) setErrorWithAutoClear(transportState, message);
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

/**
 * The sharer's device-local choice to send screen-share audio even when it
 * could not be confirmed echo-free. Off by default (see startScreenShare) -
 * this never travels to the room, it only decides what THIS device
 * publishes on its next share.
 */
export function getShareAudioDespiteEchoRisk(): boolean {
  return loadAudioPrefs().shareAudioDespiteEchoRisk;
}

export function setShareAudioDespiteEchoRisk(enabled: boolean): void {
  saveAudioPrefs({ shareAudioDespiteEchoRisk: enabled });
}

export function setDeafened(deafened: boolean): void {
  if (deafened) {
    // Every plugin's call sounds, not just one: deafening means silence.
    _voice.stopCallAudio();
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
