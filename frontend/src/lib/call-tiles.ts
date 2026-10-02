/**
 * Pure, unit-testable tile builder for the call spotlight.
 *
 * This module turns call state into SpotlightTile[] with consistent,
 * stage-matching IDs. No transport imports, no side effects.
 */

import type { SpotlightTile } from "./spotlight";

const REMOTE_CAMERA = "remote-camera-";

/**
 * A remote camera tile's id, here and on the stage. wantedCameras reads
 * popped-out windows back by it, so a stage tile named any other way would
 * have its window's camera parked and the picture freeze.
 */
export function remoteCameraTileId(peerId: string): string {
  return `${REMOTE_CAMERA}${peerId}`;
}

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
      id: remoteCameraTileId(peerId),
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

/** Everything that shows remote cameras, or is about to: see wantedCameras. */
export interface CameraSurfaces {
  /** Peers whose camera tile the call stage has on screen. */
  stage: Iterable<string>;
  /**
   * The spotlight tile. The floating panel and picture in picture show it,
   * and so does the hidden video that keeps picture in picture ready to
   * open on a tab switch. Null where nothing computes one: a quick call
   * (/qc) has no AppView, so no panel and no picture in picture.
   */
  spotlight: Pick<SpotlightTile, "id" | "kind" | "isLocal" | "peerId"> | null;
  /** The tile the user pinned (callFocus), or null. */
  pinnedTileId: string | null;
  /** Ids of the tiles in a window of their own. */
  poppedOut: Iterable<string>;
  /** Peers speaking right now (speakers.speaking), ourselves included. */
  speaking: Iterable<string>;
  /** Our own id, as the speaker set names us. */
  selfId: string;
}

/**
 * The remote cameras something on screen shows, by peerId: the ones worth
 * receiving (MediasoupVideo.setWantedCameras). Every other camera can stop
 * coming in until one of these surfaces shows it again.
 */
export function wantedCameras(shown: CameraSurfaces): Set<string> {
  const { spotlight } = shown;
  const wanted = new Set(shown.stage);
  if (spotlight && spotlight.kind === "camera" && !spotlight.isLocal) {
    wanted.add(spotlight.peerId);
  }
  // Whoever is talking may be the spotlight in a moment: rule 3 hands it
  // over after SPEAKER_TAKEOVER_MS of speech (spotlight.ts). A parked camera
  // takes a round trip and a keyframe to come back, so one first asked for
  // at the switch put a black picture in the floating panel and picture in
  // picture on most changes of speaker. Asked for at the first word, it is
  // playing by then, for as long as the takeover stays well above that
  // round trip (call-tiles.test.ts holds it to that). Not while a pin or a
  // watched share holds the spotlight (rules 1 and 2), when no speaker can
  // take it, nor where there is no spotlight to take: in a quick call only
  // the stage shows cameras, and it says which itself.
  const held =
    spotlight === null ||
    spotlight.id === shown.pinnedTileId ||
    (spotlight.kind === "screen" && !spotlight.isLocal);
  if (!held) {
    for (const peerId of shown.speaking) {
      if (peerId !== shown.selfId) wanted.add(peerId);
    }
  }
  for (const id of shown.poppedOut) {
    if (id.startsWith(REMOTE_CAMERA)) wanted.add(id.slice(REMOTE_CAMERA.length));
  }
  return wanted;
}
