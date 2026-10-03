/**
 * Shared per-peer voice quality, fed from the transport status stream in
 * voice.svelte.ts. CallStatus used to hold this map privately, which meant
 * the ONE aggregate badge was the only feedback anywhere - a pair that
 * could not hear each other looked exactly like a healthy call on every
 * tile. Tiles read this to mark the specific peer that is degraded/failed.
 */
import {
  applyCallQualityStatus,
  noteTrackAdded,
  type CallQualityStatusEvent,
  type PeerVoiceQuality,
} from "./call-quality";

export const peerQualityState = $state({
  peers: new Map<string, PeerVoiceQuality>() as ReadonlyMap<
    string,
    PeerVoiceQuality
  >,
});

export function applyPeerQualityEvent(event: CallQualityStatusEvent): void {
  const next = applyCallQualityStatus(peerQualityState.peers, event);
  if (next !== peerQualityState.peers) peerQualityState.peers = next;
}

export function notePeerQualityTrack(peerId: string): void {
  const next = noteTrackAdded(peerQualityState.peers, peerId);
  if (next !== peerQualityState.peers) peerQualityState.peers = next;
}

/**
 * Peers whose voice RTCPeerConnection currently reads "connected". The ONE
 * answer to "is this person connected yet" for every surface - the call
 * tile's pulse and the sidebar badge each used their own proxy (an audio
 * track, which lands at the SDP handshake; a status event a component had
 * to be mounted to hear) and disagreed for seconds on every join.
 */
export const voiceLinkState = $state({
  connected: new Set<string>() as ReadonlySet<string>,
});

export function setVoiceLink(peerId: string, up: boolean): void {
  if (voiceLinkState.connected.has(peerId) === up) return;
  const next = new Set(voiceLinkState.connected);
  if (up) next.add(peerId);
  else next.delete(peerId);
  voiceLinkState.connected = next;
}

/**
 * Peers whose voice currently goes through a TURN relay, from the pair the
 * browser actually selected (voice.ts reads it from getStats). Its own set,
 * not a quality: a degraded or failed verdict says nothing about the route,
 * and a route on TURN is not a fault. Tiles badge these people.
 */
export const voiceRouteState = $state({
  turn: new Set<string>() as ReadonlySet<string>,
});

export function setVoiceTurn(peerId: string, onTurn: boolean): void {
  if (voiceRouteState.turn.has(peerId) === onTurn) return;
  const next = new Set(voiceRouteState.turn);
  if (onTurn) next.add(peerId);
  else next.delete(peerId);
  voiceRouteState.turn = next;
}

/** Call teardown: verdicts are about links that no longer exist. */
export function resetPeerQuality(): void {
  if (peerQualityState.peers.size > 0) peerQualityState.peers = new Map();
  if (voiceLinkState.connected.size > 0) voiceLinkState.connected = new Set();
  if (voiceRouteState.turn.size > 0) voiceRouteState.turn = new Set();
}
