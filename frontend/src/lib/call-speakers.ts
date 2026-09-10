/**
 * The bridge between call state and speaker detection.
 *
 * speakers.svelte.ts is deliberately a leaf - it takes participant state as
 * arguments rather than importing the transport, so it can be tested without
 * bootstrapping media streams - which means somebody has to feed it. That was
 * an effect inside AppView, and /qc does not mount AppView: it renders
 * ChatView directly. So a quick call had every part of the speaking indicator
 * except the thing that drives it, and nobody's ring ever lit up.
 *
 * Living here rather than being copied into the second shell: there is one
 * correct way to feed the analyser and it should not be written twice.
 */

import {
  _trackedSpeakers,
  resumeAudioContextOnVisibilityChange,
  speakers,
  stopAllSpeakers,
  updateSpeakerTracks,
} from "$lib/speakers.svelte";
import { selfId, transportState } from "$lib/transport/transport.svelte";
import { callPipPanel } from "$lib/call-pip.svelte";
import { exitBrowserPip } from "$lib/call-spotlight.svelte";

/**
 * Hand the analyser whoever is currently in the call.
 *
 * Call this from an `$effect` in whichever shell is mounted; every read below
 * registers as a dependency, so it re-runs when the roster, the mute state or
 * the local mic changes. Detection follows the CALL, not the stage: the tiles
 * unmount when the user navigates away from the call room, and the floating
 * panel still has to show who is talking.
 */
export function syncSpeakersFromCall(): void {
  if (!transportState.inCall) {
    stopAllSpeakers();
    return;
  }
  // null to undefined, for the leaf module's narrower argument type.
  const participants = new Map(
    Array.from(transportState.participants).map(([peerId, p]) => [
      peerId,
      {
        audioTrack: p.audioTrack ?? undefined,
        videoTrack: p.videoTrack ?? undefined,
        screenTrack: p.screenTrack ?? undefined,
        screenAudioTrack: p.screenAudioTrack ?? undefined,
      },
    ])
  );
  updateSpeakerTracks(
    participants,
    transportState.muted,
    transportState.localMicStream,
    selfId()
  );
}

let watching = false;

/**
 * Resume the audio context when the tab comes back, and close the browser PiP
 * the tab switch opened - the call is on screen again.
 *
 * Idempotent, and never removed: it is one listener for the life of the page,
 * and two shells that both mount would otherwise register two.
 */
export function watchVisibilityForCall(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !transportState.inCall) return;
    resumeAudioContextOnVisibilityChange();
    if (callPipPanel.browserPip) void exitBrowserPip();
  });
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle. Whether the ring lights up is only observable with a
  // real microphone and a real call, which is what the e2e browsers have.
  (window as unknown as Record<string, unknown>).__speakers = () => ({
    speaking: [...speakers.speaking],
    tracked: _trackedSpeakers(),
  });
}
