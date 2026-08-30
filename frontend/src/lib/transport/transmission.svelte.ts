import {
  playTransmissionEndedSound,
  playScreenShareStartSound,
  playTransmissionJoinSound,
  playTransmissionLeaveSound,
} from "$lib/sounds";
import { transportState, _transport } from "./transport.svelte";
import { encode } from "../utils";
import { MessageType } from "../types/message";
import type { MediasoupVideo } from "./mediasoup";
import { cancelErrorClear, setErrorWithAutoClear } from "./call-error";

let _video: MediasoupVideo | null = null;
let _volume = 1;
let _initialized = false;

export function initTransmission(video: MediasoupVideo): void {
  if (_initialized) return;
  _initialized = true;
  _video = video;

  _video.on("trackAdded", (peerId, track, source) => {
    const existing = transportState.participants.get(peerId) ?? {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
      screenAudioTrack: null,
      videoStalled: false,
      screenStalled: false,
    };
    // A landed track is the only recovery signal trackStalled gets (no
    // separate "recovered" event) - clear the stall for the source that
    // just produced a track, never the other one.
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      source === "camera"
        ? { ...existing, videoTrack: track, videoStalled: false }
        : track.kind === "audio"
          ? { ...existing, screenAudioTrack: track, screenStalled: false }
          : { ...existing, screenTrack: track, screenStalled: false }
    );
  });

  _video.on("trackStalled", (peerId, source) => {
    const p = transportState.participants.get(peerId);
    if (!p) return;
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      source === "camera"
        ? { ...p, videoStalled: true }
        : { ...p, screenStalled: true }
    );
  });

_video.on("trackRemoved", (peerId, source, kind) => {
  // Handle local tracks (screen share stopped via browser button)
  if (peerId === "local") {
    if (source === "screen") {
      transportState.screenSharing = false;
      transportState.localScreenStream = null;
    } else if (source === "camera") {
      transportState.cameraOff = true;
      transportState.localCameraStream = null;
    }
    return;
  }
  // Handle remote tracks. `kind` distinguishes which underlying track
  // ended - closing the screen AUDIO producer must not also null the
  // screen VIDEO track (sfu-audit finding 4: it used to tear down the
  // viewer's whole watch and leave a dead "click to watch" tile behind).
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    source === "camera"
      ? { ...p, videoTrack: null }
      : kind === "audio"
        ? { ...p, screenAudioTrack: null }
        : { ...p, screenTrack: null }
  );
});

  _video.on("peerLeft", (peerId) => {
    const p = transportState.participants.get(peerId);
    if (p) {
      transportState.participants = new Map(transportState.participants).set(
        peerId,
        {
          ...p,
          videoTrack: null,
          screenTrack: null,
          screenAudioTrack: null,
        }
      );
    }

    const tx = new Map(transportState.pendingTransmissions);
    tx.delete(peerId);
    transportState.pendingTransmissions = tx;

    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
    }
  });

  _video.on("transmissionAvailable", (peerId, producerId) => {
    // A share appearing is news to everyone in the call - same idea as the
    // join chime. Only on a NEW share, not on producer-id churn.
    if (
      transportState.inCall &&
      peerId !== _transport.selfId() &&
      !transportState.pendingTransmissions.has(peerId)
    ) {
      playScreenShareStartSound();
    }
    transportState.pendingTransmissions = new Map(
      transportState.pendingTransmissions
    ).set(peerId, producerId);
  });

  _video.on("transmissionEnded", (peerId) => {
    const next = new Map(transportState.pendingTransmissions);
    next.delete(peerId);
    transportState.pendingTransmissions = next;
    if (transportState.transmissionViewers.has(peerId)) {
      const viewers = new Map(transportState.transmissionViewers);
      viewers.delete(peerId);
      transportState.transmissionViewers = viewers;
    }
    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
      playTransmissionEndedSound();
    }
  });

  _video.on("transmissionWatched", () => {
    playTransmissionJoinSound();
  });

  _video.on("transmissionWatchEnded", () => {
    playTransmissionLeaveSound();
  });

  let _videoErrorMessage: string | null = null;
  _video.on("error", (err) => {
    _videoErrorMessage = err.message;
    setErrorWithAutoClear(transportState, err.message);
  });

  // Video quietly healing must take its OWN banner with it, whatever the
  // message was - string-matching two fixed constants missed every
  // sfuRefusalMessage() variant and both transport-failure strings that the
  // client and server can produce (sfu-audit finding 15).
  _video.on("healed", () => {
    if (_videoErrorMessage !== null && transportState.error === _videoErrorMessage) {
      cancelErrorClear();
      transportState.error = null;
    }
    _videoErrorMessage = null;
  });
}

function getVideo(): MediasoupVideo {
  if (!_video)
    throw new Error("Video not initialized. Call initTransmission() first.");
  return _video;
}

export function setTransmissionOutputVolume(volume: number): void {
  const next = Math.max(0, Math.min(1, volume));
  transportState.transmissionOutputVolume = next;
  _volume = next;
  document
    .querySelectorAll<HTMLAudioElement>("audio[data-remote]")
    .forEach((el) => {
      el.volume = next;
    });
}

/** Tell the call who we are watching (or that we stopped: watching null). */
export function _sendWatchPresence(peerId?: string): void {
  const payload = encode({
    type: MessageType.WatchPresence,
    watching: transportState.watchingTransmissionPeerId,
  });
  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }
  const rooms = new Set(
    [transportState.callRoomCode, transportState.roomCode].filter(
      (r): r is string => !!r
    )
  );
  for (const room of rooms) _transport.broadcast(payload, room);
}

export async function watchTransmission(
  peerId: string,
  producerId: string
): Promise<void> {
  transportState.error = null;
  try {
    await getVideo().watchTransmission(peerId, producerId);
    transportState.watchingTransmissionPeerId = peerId;
    transportState.watchingTransmissionProducerId = producerId;
    _sendWatchPresence();
    const next = new Map(transportState.pendingTransmissions);
    next.delete(peerId);
    transportState.pendingTransmissions = next;
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function stopWatchingTransmission(): void {
  const peerId = transportState.watchingTransmissionPeerId;
  const producerId = transportState.watchingTransmissionProducerId;
  if (!peerId || !producerId) return;
  getVideo().stopWatchingTransmission(peerId);
  transportState.pendingTransmissions = new Map(
    transportState.pendingTransmissions
  ).set(peerId, producerId);
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
  _sendWatchPresence();
}
