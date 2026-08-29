import { SvelteMap } from "svelte/reactivity";
/**
 * Speaker detection and active speaker tracking for the call.
 *
 * Extracted from VoiceVideoCallView.svelte (lines 242-370), this module runs
 * the analyser loop that detects audio and tracks who is speaking. It must
 * run while the call is active, not just when the stage is mounted, so that
 * the floating panel and browser PiP can use the speaker state after the user
 * navigates away from the call room.
 *
 * This module is deliberately a leaf: it takes participant state as arguments
 * rather than importing the transport, so it can be tested without bootstrapping
 * media streams.
 *
 * The analyser loop itself (reading FFT bins and updating speaking state) is
 * not unit-testable without real audio, per the spec - but the add/remove
 * bookkeeping is tested. Wave 2 will drive start/stop via an effect that
 * watches `inCall` and `participants`.
 */

export interface SpeakersState {
  /** Peers actively speaking right now (recently enough to hold the speaking ring). */
  speaking: Set<string>;
  /**
   * SvelteMap, not Map. Svelte's proxy only deep-wraps plain objects and
   * arrays, so a bare Map held on a $state object is handed back raw: .set()
   * updates the data but notifies nothing, and a reader depending only on this
   * map never re-runs. This loop writes on every poll tick, so a reactive
   * container beats rebuilding the map ten times a second.
   */
  /** When each peer last produced enough audio to be considered speaking. */
  lastSpokeAt: SvelteMap<string, number>;
  /**
   * When each peer's CURRENT speaking run began, cleared when they stop.
   *
   * lastSpokeAt alone cannot express "has been speaking for 1.5s" - it only
   * says when speech was last seen, so a peer talking right now and a peer who
   * stopped a moment ago are indistinguishable by it. The spotlight's takeover
   * rule needs the duration of the current run, which is what this carries.
   */
  speakingSince: SvelteMap<string, number>;
}

export const speakers = $state<SpeakersState>({
  speaking: new Set(),
  lastSpokeAt: new SvelteMap(),
  speakingSince: new SvelteMap(),
});

// ── Internal state (module-level, lives for the app lifetime) ──────────────

/** Analyser nodes for each peer, with their audio source. */
const analysers = new Map<
  string,
  {
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    track: MediaStreamTrack;
  }
>();

/** Shared AudioContext, one for all peers. Multiple contexts would hit browser caps. */
let sharedCtx: AudioContext | null = null;

/** Animation frame handle for the polling loop. */
let rafId: number | null = null;

/** Reusable buffer for FFT data (allocated once per session, not per frame). */
const speakerBuf = new Uint8Array(512);

/**
 * Hysteresis tuning: speech has gaps between syllables, so holding briefly
 * after each loud frame keeps the ring from strobing. Turning on takes a
 * higher threshold than staying on (hysteresis), and the hold window is
 * shorter than the silence window.
 */
const SPEAKING_HOLD_MS = 500; // How long to hold after the last loud frame
const SPEAKING_ON = 3; // Threshold to turn speaking on
const SPEAKING_OFF = 1; // Threshold to keep speaking on (lower = hysteresis)
const SPEAKER_POLL_MS = 100; // Poll FFT every 100ms (10Hz), not every frame (60Hz)

/** When each peer last had audio above the threshold. */
const lastLoudAt = new Map<string, number>();

/** Next time to poll speakers (throttles the FFT reads). */
let nextSpeakerPollAt = 0;

// ── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Get or create the shared AudioContext. Resumed on visibility change
 * (backgrounded tabs suspend the context, causing silence).
 */
function speakerCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === "suspended") {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

/**
 * Set up speech detection on an audio track.
 *
 * If the analyser already exists for this peer, this is a no-op (same track,
 * still live) or a teardown + setup (track was restarted). For remote peers,
 * this is called when the audio track arrives. For the local mic, it is called
 * after unmuting.
 */
function startSpeakerDetection(peerId: string, track: MediaStreamTrack): void {
  const existing = analysers.get(peerId);
  if (existing) {
    // Same track and live: nothing to do.
    if (existing.track === track && track.readyState === "live") return;
    // Track changed (mic restarted) or died: clean up the old one first.
    stopSpeakerDetection(peerId);
  }

  if (track.readyState !== "live") return;

  try {
    const ctx = speakerCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);
    analysers.set(peerId, { analyser, source, track });
  } catch {
    // Ignore errors (e.g., too many concurrent contexts). The ring just
    // won't work for that peer.
  }
}

/**
 * Stop monitoring audio for a peer.
 */
function stopSpeakerDetection(peerId: string): void {
  const entry = analysers.get(peerId);
  if (!entry) return;
  entry.source.disconnect();
  analysers.delete(peerId);
  lastLoudAt.delete(peerId);
  speakers.speaking = new Set([...speakers.speaking].filter((p) => p !== peerId));
  speakers.speakingSince.delete(peerId);
  // lastSpokeAt was the one map never pruned here, so every peer who spoke and
  // then left kept an entry for the life of the call. Harmless for spotlight()
  // itself, which only reads peers that still have a tile, but it is a leak
  // and it would mislead any consumer that iterates these keys directly.
  speakers.lastSpokeAt.delete(peerId);
}

/**
 * The RAF-driven FFT polling loop.
 *
 * Reads frequency data every SPEAKER_POLL_MS, checks if each peer is audibly
 * speaking, and updates the speakers state. Only publishes when the set
 * actually changes to avoid re-rendering every consumer.
 */
function pollSpeakers(): void {
  const pollNow = performance.now();

  // Throttle FFT reads to SPEAKER_POLL_MS. The rAF loop pauses in hidden
  // tabs (by design - no speaking state changes while backgrounded), but
  // the FFT is expensive, so we skip it until it is time.
  if (pollNow < nextSpeakerPollAt) {
    rafId = requestAnimationFrame(pollSpeakers);
    return;
  }

  nextSpeakerPollAt = pollNow + SPEAKER_POLL_MS;

  // Resume the context if it was suspended while the tab was hidden.
  if (sharedCtx?.state === "suspended") {
    sharedCtx.resume().catch(() => {});
  }

  const now = performance.now();
  const buf = speakerBuf;
  const next = new Set<string>();

  // Check each analyser's current frequency profile.
  for (const [peerId, { analyser }] of analysers) {
    analyser.getByteFrequencyData(buf);

    // Average the byte frequencies (0-255 scale). Noisy but fast; DTLN
    // upstream (noise suppression) keeps the floor near zero, so a low
    // threshold is safe and catches quiet talkers.
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const avg = sum / buf.length;

    // Hysteresis: use a different threshold to stay on than to turn on.
    const threshold = speakers.speaking.has(peerId) ? SPEAKING_OFF : SPEAKING_ON;
    if (avg > threshold) {
      lastLoudAt.set(peerId, now);
      // Update the spotlight's hysteresis state with the current time.
      speakers.lastSpokeAt.set(peerId, now);
    }

    // Hold is relative to the last loud frame, not the threshold. If it has
    // been less than SPEAKING_HOLD_MS since the last loud sound, they are
    // still considered speaking (fills the gaps between syllables).
    if (now - (lastLoudAt.get(peerId) ?? -Infinity) < SPEAKING_HOLD_MS) {
      next.add(peerId);
    }
  }

  // Track the START of each speaking run. A peer entering `next` who was not
  // speaking before begins a run now; one who drops out ends theirs. Without
  // this the spotlight cannot tell "talking for two seconds" from "said one
  // word two seconds ago", and its takeover rule degenerates.
  for (const peerId of next) {
    if (!speakers.speakingSince.has(peerId)) {
      speakers.speakingSince.set(peerId, now);
    }
  }
  for (const peerId of [...speakers.speakingSince.keys()]) {
    if (!next.has(peerId)) speakers.speakingSince.delete(peerId);
  }

  // Only publish when the set actually changed, so consumers do not re-render
  // 10 times a second for no change.
  const changed =
    next.size !== speakers.speaking.size ||
    [...next].some((peerId) => !speakers.speaking.has(peerId));

  if (changed) {
    speakers.speaking = next;
  }

  rafId = requestAnimationFrame(pollSpeakers);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Update the list of peers to monitor for speech.
 *
 * Call this whenever the participant list changes (track events) or mute state
 * changes. The function compares the desired set against what is already
 * active and only adds/removes what is needed.
 *
 * Wave 2 will call this in an effect that watches `participants`, `muted`,
 * `localMicStream`, and `selfId`.
 */
export function updateSpeakerTracks(
  participants: Map<
    string,
    {
      audioTrack?: MediaStreamTrack;
      videoTrack?: MediaStreamTrack;
      screenTrack?: MediaStreamTrack;
      screenAudioTrack?: MediaStreamTrack;
    }
  >,
  muted: boolean,
  localMicStream: MediaStream | null,
  selfId: string
): void {
  const desiredPeers = new Set<string>();

  // Add remote peers with audio tracks.
  for (const [peerId, p] of participants) {
    if (p.audioTrack) {
      desiredPeers.add(peerId);
    }
  }

  // Add self's audio if not muted.
  if (!muted && localMicStream) {
    const track = localMicStream.getAudioTracks()[0];
    if (track) {
      desiredPeers.add(selfId);
    }
  }

  // Create/update analysers for desired peers.
  for (const peerId of desiredPeers) {
    const track =
      peerId === selfId
        ? localMicStream?.getAudioTracks()[0]
        : participants.get(peerId)?.audioTrack;
    if (track) {
      startSpeakerDetection(peerId, track);
    }
  }

  // Remove analysers for peers no longer desired.
  for (const peerId of [...analysers.keys()]) {
    if (!desiredPeers.has(peerId)) {
      stopSpeakerDetection(peerId);
    }
  }

  // Start the RAF loop if needed.
  if (!rafId && desiredPeers.size > 0) {
    rafId = requestAnimationFrame(pollSpeakers);
  }

  // Stop the RAF loop if we have no one to monitor.
  if (rafId && desiredPeers.size === 0) {
    cancelAnimationFrame(rafId);
    rafId = null;
    nextSpeakerPollAt = 0;
  }
}

/**
 * Stop all speaker detection and tear down the analyser loop.
 *
 * Call this when the call ends (inCall becomes false). The AudioContext is
 * closed and will be recreated on the next call if needed.
 *
 * Wave 2 will call this in the cleanup of an effect that watches `inCall`.
 */
export function stopAllSpeakers(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  for (const peerId of [...analysers.keys()]) {
    stopSpeakerDetection(peerId);
  }

  sharedCtx?.close().catch(() => {});
  sharedCtx = null;
  nextSpeakerPollAt = 0;
  speakers.speaking = new Set();
  speakers.speakingSince.clear();
  speakers.lastSpokeAt.clear();
}

/**
 * Resume the shared AudioContext when visibility changes.
 *
 * The browser suspends the context when the tab is backgrounded (low power).
 * When the user returns to the tab, resume it so the analyser loop picks up
 * speech again. This is called by a visibility event handler somewhere in
 * wave 2 (or can be called manually from the transport's visibility handler).
 */
export function resumeAudioContextOnVisibilityChange(): void {
  if (sharedCtx?.state === "suspended") {
    sharedCtx.resume().catch(() => {});
  }
}

