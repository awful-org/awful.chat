import {
  playTransmissionEndedSound,
  playTransmissionJoinSound,
  playTransmissionLeaveSound,
} from "$lib/sounds";
import { transportState } from "./transport.svelte";
import type { MediasoupVideo } from "./mediasoup";

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
    };
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      source === "camera"
        ? { ...existing, videoTrack: track }
        : track.kind === "audio"
          ? { ...existing, screenAudioTrack: track }
          : { ...existing, screenTrack: track }
    );
    if (!transportState.sfuPeerIds.has(peerId)) {
      transportState.sfuPeerIds = new Set([
        ...transportState.sfuPeerIds,
        peerId,
      ]);
    }
  });

_video.on("trackRemoved", (peerId, source) => {
  // Handle local tracks (screen share stopped via browser button)
  if (peerId === "local") {
    if (source === "screen") {
      transportState.screenSharing = false;
      transportState.localScreenStream = null;
    }
    return;
  }
  // Handle remote tracks
  const p = transportState.participants.get(peerId);
  if (!p) return;
  transportState.participants = new Map(transportState.participants).set(
    peerId,
    source === "camera"
      ? { ...p, videoTrack: null }
      : { ...p, screenTrack: null, screenAudioTrack: null }
  );
});

  _video.on("peerJoined", (peerId) => {
    if (!transportState.sfuPeerIds.has(peerId)) {
      transportState.sfuPeerIds = new Set([
        ...transportState.sfuPeerIds,
        peerId,
      ]);
    }
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
    const next = new Set(transportState.sfuPeerIds);
    next.delete(peerId);
    transportState.sfuPeerIds = next;

    const tx = new Map(transportState.pendingTransmissions);
    tx.delete(peerId);
    transportState.pendingTransmissions = tx;

    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
    }
  });

  _video.on("transmissionAvailable", (peerId, producerId) => {
    transportState.pendingTransmissions = new Map(
      transportState.pendingTransmissions
    ).set(peerId, producerId);
    if (!transportState.sfuPeerIds.has(peerId)) {
      transportState.sfuPeerIds = new Set([
        ...transportState.sfuPeerIds,
        peerId,
      ]);
    }
  });

  _video.on("transmissionEnded", (peerId) => {
    const next = new Map(transportState.pendingTransmissions);
    next.delete(peerId);
    transportState.pendingTransmissions = next;
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

  _video.on("error", (err) => {
    transportState.error = err.message;
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

export function getTransmissionOutputVolume(): number {
  return _volume;
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
}
