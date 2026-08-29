/**
 * Spotlight rule: which tile should the picture-in-picture panel show?
 *
 * This is a pure function, testable with fake timers and no wall-clock reads.
 * It implements the five-rule priority from the spec, with hysteresis on the
 * active speaker to prevent flickering.
 */

/**
 * Minimal tile shape: only the properties spotlight needs.
 */
/**
 * What rule 3 needs to know about speech.
 *
 * `lastSpokeAt` alone is not enough, and getting this wrong is subtle: with
 * only a last-spoke timestamp, a peer talking RIGHT NOW and a peer who fell
 * silent a moment ago look identical, so a takeover rule written against it
 * ends up selecting people shortly AFTER they stop talking rather than while
 * they are talking.
 */
export interface SpeakerState {
  /** Peers producing speech right now. */
  speaking: ReadonlySet<string>;
  /** When each speaking peer's current run began. */
  speakingSince: ReadonlyMap<string, number>;
  /** When each peer last produced speech, whether or not they still are. */
  lastSpokeAt: ReadonlyMap<string, number>;
}

export interface SpotlightTile {
  id: string;
  kind: "camera" | "screen" | "transmission" | "plugin";
  isLocal: boolean;
  peerId: string;
  videoTrack: MediaStreamTrack | null;
  /**
   * When this tile's source began, for "newest first" among simultaneous
   * screen shares. Optional: without it the caller's array order decides,
   * which is what the rule used to depend on silently - an ordering no type
   * enforced and no test covered.
   */
  startedAt?: number;
}

/**
 * Apply the spotlight rule to choose which tile the panel should show.
 *
 * Rules in order:
 * 1. Pin wins if set and the tile still exists.
 * 2. Screen share: the watched one (if any), else any remote screenTrack
 *    (newest first, never the user's own).
 * 3. Active speaker with hysteresis: the remote peer speaking most recently,
 *    but only after 1.5s of continuous speech, and holds for 2s of silence.
 *    Ties prefer a peer with camera on.
 * 4. Fallback: the previous spotlight if it still exists, else the first
 *    remote with camera, else the first remote.
 * 5. If only the user is in the call, show the local camera.
 *
 * @param tiles Array of all tiles in the call.
 * @param pin The pinned tile id, or null. Cleared when the tile disappears.
 * @param watching The peerId being watched for screen share, or null.
 * @param speakers Who is speaking, when their current run began, and when
 *   each last spoke. All three are needed: "speaking continuously for 1.5s"
 *   cannot be derived from a last-spoke timestamp alone.
 * @param previous The previous spotlight tile id, for fallback.
 * @param now The current timestamp (milliseconds), for hysteresis comparison.
 * @returns The tile id to show, or null if no valid choice.
 */
export function spotlight(
  tiles: SpotlightTile[],
  pin: string | null,
  watching: string | null,
  speakers: SpeakerState,
  previous: string | null,
  now: number
): string | null {
  // Rule 1: Pin wins if still present.
  if (pin) {
    const pinned = tiles.find((t) => t.id === pin);
    if (pinned) return pin;
  }

  // Rule 2: Screen share. Watched one has priority, then any remote screen.
  // Never show the user's own screen.
  if (watching) {
    // Look for a remote screen from the watched peer.
    const watched = tiles.find(
      (t) => t.peerId === watching && t.kind === "screen" && !t.isLocal
    );
    if (watched) return watched.id;
  }

  // Any remote screen, newest first (earlier tiles are newer in the spec's
  // intent: the tiles array is built bottom-to-top with local screen last).
  const remoteScreens = tiles
    .filter((t) => t.kind === "screen" && !t.isLocal && t.peerId !== watching)
    // Newest first when the caller dates the tiles; stable otherwise, so a
    // caller that does not set startedAt keeps its own array order.
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (remoteScreens.length > 0) return remoteScreens[0].id;

  // Rule 3: the active speaker, with hysteresis so the panel does not flicker
  // every time someone says "yeah".
  const SPEAKER_TAKEOVER_MS = 1500;
  const SPEAKER_HOLD_MS = 2000;

  // The incumbent keeps the spot while still speaking, and for a grace period
  // after falling silent - otherwise a pause for breath hands the panel to
  // whoever coughs next.
  if (previous) {
    // Remote only, like the challenger loop below and rule 4's fallback. The
    // local user's own speech legitimately appears in `speaking` when they are
    // unmuted, so without this an incumbent local tile - which rule 5 hands
    // out whenever you are briefly alone - keeps the panel to itself while a
    // remote peer talks, and the rule that says "the REMOTE peer speaking" is
    // never reached.
    const prevTile = tiles.find((t) => t.id === previous && !t.isLocal);
    if (prevTile) {
      const stillSpeaking = speakers.speaking.has(prevTile.peerId);
      const lastSpoke = speakers.lastSpokeAt.get(prevTile.peerId);
      if (
        stillSpeaking ||
        (lastSpoke !== undefined && now - lastSpoke < SPEAKER_HOLD_MS)
      ) {
        return previous;
      }
    }
  }

  // A challenger must be speaking NOW and have held it for the takeover
  // window. Measured from the start of the current run, not from the last
  // moment of speech: the latter selects people just after they stop.
  let best: { id: string; since: number; hasCamera: boolean } | null = null;
  for (const peerId of speakers.speaking) {
    const since = speakers.speakingSince.get(peerId);
    if (since === undefined || now - since < SPEAKER_TAKEOVER_MS) continue;

    const tile = tiles.find((t) => t.peerId === peerId && !t.isLocal);
    if (!tile) continue;

    const hasCamera = !!tile.videoTrack;
    // Longest continuous run wins; a tie goes to whoever has a camera on,
    // because an avatar in the panel says less than a face.
    if (
      !best ||
      since < best.since ||
      (since === best.since && hasCamera && !best.hasCamera)
    ) {
      best = { id: tile.id, since, hasCamera };
    }
  }
  if (best) return best.id;

  // Rule 4: Fallback chain.
  // Previous, if still present.
  if (previous) {
    const prev = tiles.find((t) => t.id === previous);
    if (prev && !prev.isLocal) return prev.id;
  }

  // First remote with camera.
  const remoteWithCamera = tiles.find(
    (t) => !t.isLocal && t.videoTrack !== null
  );
  if (remoteWithCamera) return remoteWithCamera.id;

  // First remote (avatar tile).
  const firstRemote = tiles.find((t) => !t.isLocal);
  if (firstRemote) return firstRemote.id;

  // Rule 5: nobody else here, so show ourselves rather than an empty panel.
  // Matched on isLocal, NOT on a tile id: keying this to the literal
  // "local-camera" made the rule depend on a naming convention nothing
  // enforces, and the failure is silent - the panel simply goes blank the
  // moment you are alone in the call.
  const localCamera = tiles.find(
    (t) => t.isLocal && t.kind === "camera" && t.videoTrack !== null
  );
  if (localCamera) return localCamera.id;
  const anyLocal = tiles.find((t) => t.isLocal);
  if (anyLocal) return anyLocal.id;

  return null;
}
