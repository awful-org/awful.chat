/**
 * Pure, unit-testable tile builder for the call spotlight.
 *
 * This module turns call state into SpotlightTile[] with consistent,
 * stage-matching IDs. No transport imports, no side effects.
 */

import type { SpotlightTile } from "./spotlight";

/** A remote camera tile's id is this and the peerId, here and on the stage. */
const REMOTE_CAMERA = "remote-camera-";

export interface CallState {
  /** Map of peerId to participant state with media tracks */
  participants: Map<
    string,
    {
      audioTrack?: MediaStreamTrack | null;
      videoTrack: MediaStreamTrack | null;
      screenTrack: MediaStreamTrack | null;
      screenAudioTrack?: MediaStreamTrack | null;
    }
  >;
  /** Local camera stream if available */
  localCameraStream: MediaStream | null;
  /** Local screen stream if available */
  localScreenStream: MediaStream | null;
  /** Whether camera is off (user turned it off, not just no track) */
  cameraOff: boolean;
  /** Shares being watched (SFU): sharer peerId -> producerId */
  watchingTransmissions: ReadonlyMap<string, string>;
  /** Self's peer ID */
  selfId: string;
  /** Track start times, to preserve startedAt across rebuilds */
  trackStartTimes: Map<string, number>;
}

/**
 * Build the complete tile list for spotlight calculation.
 *
 * Tile IDs must match the stage exactly (VoiceVideoCallView.svelte):
 * - local-camera
 * - remote-camera-${peerId}
 * - local-screen
 * - remote-screen-${peerId}
 * - pending-tx-${peerId}
 *
 * One tile per source: a watched transmission creates one tile with the
 * watched share's ID, not duplicates.
 *
 * @param state Call state with tracks and options
 * @returns Array of spotlight tiles
 */
export function buildCallTiles(state: CallState): SpotlightTile[] {
  const result: SpotlightTile[] = [];

  // Local camera tile, always: the stage always has one, and rule 5 needs
  // something to show when you are alone with the camera off (the avatar).
  const localVideoTrack = state.localCameraStream?.getVideoTracks()[0] ?? null;
  result.push({
    id: "local-camera",
    kind: "camera",
    isLocal: true,
    peerId: state.selfId,
    videoTrack: localVideoTrack,
  });

  // Remote camera tiles - one per peer, regardless of track state.
  for (const [peerId, p] of state.participants) {
    result.push({
      id: `${REMOTE_CAMERA}${peerId}`,
      kind: "camera",
      isLocal: false,
      peerId,
      videoTrack: p.videoTrack ?? null,
    });
  }

  // Local screen tile
  const localScreenTrack = state.localScreenStream?.getVideoTracks()[0] ?? null;
  if (localScreenTrack) {
    const trackId = "local-screen";
    const startedAt =
      state.trackStartTimes.get(trackId) ?? performance.now();
    result.push({
      id: trackId,
      kind: "screen",
      isLocal: true,
      peerId: state.selfId,
      videoTrack: localScreenTrack,
      startedAt,
    });
  }

  // Remote screen tiles. A watched SFU share lands in screenTrack too, and
  // the stage files it under the same remote-screen id, so a pin made here
  // still matches a stage tile when the user goes back.
  for (const [peerId, p] of state.participants) {
    if (p.screenTrack) {
      const trackId = `remote-screen-${peerId}`;
      const startedAt =
        state.trackStartTimes.get(trackId) ?? performance.now();
      result.push({
        id: trackId,
        kind: "screen",
        isLocal: false,
        peerId,
        videoTrack: p.screenTrack,
        startedAt,
      });
    }
  }

  // A share we asked to watch but whose track has not arrived yet: the
  // stage's pending-tx tile. Once the track lands it is a remote-screen tile
  // above, never both.
  for (const watchedPeerId of state.watchingTransmissions.keys()) {
    if (!state.participants.get(watchedPeerId)?.screenTrack) {
      const trackId = `pending-tx-${watchedPeerId}`;
      const startedAt =
        state.trackStartTimes.get(trackId) ?? performance.now();
      result.push({
        id: trackId,
        kind: "transmission",
        isLocal: false,
        peerId: watchedPeerId,
        videoTrack: null,
        startedAt,
      });
    }
  }

  return result;
}

/**
 * The remote cameras something on screen shows, by peerId: the ones worth
 * receiving (MediasoupVideo.setWantedCameras). Every other camera can stop
 * coming in until one of these surfaces shows it again.
 *
 * @param stage Peers whose camera tile the call stage has on screen.
 * @param spotlight The spotlight tile. The floating panel and picture in
 *   picture show it, and so does the hidden video that keeps picture in
 *   picture ready to open on a tab switch.
 * @param poppedOut Ids of the tiles in a window of their own.
 */
export function wantedCameras(
  stage: Iterable<string>,
  spotlight: Pick<SpotlightTile, "kind" | "isLocal" | "peerId"> | null,
  poppedOut: Iterable<string>
): Set<string> {
  const wanted = new Set(stage);
  if (spotlight && spotlight.kind === "camera" && !spotlight.isLocal) {
    wanted.add(spotlight.peerId);
  }
  for (const id of poppedOut) {
    if (id.startsWith(REMOTE_CAMERA)) wanted.add(id.slice(REMOTE_CAMERA.length));
  }
  return wanted;
}
