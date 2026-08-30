/**
 * Pure reducer for which peers have a proven voice ICE link.
 *
 * Split out of VoiceVideoCallView.svelte so the prune logic is unit
 * testable without mounting Svelte. The set only self-heals if insert and
 * delete agree on the same key: a torn-down peer that is added under one id
 * shape and removed under another never leaves the set, and then renders as
 * a healthy, connected tile forever (voice-audit finding 8).
 */

export interface VoiceLinkStatusEvent {
  type: string;
  peerId?: string;
}

/**
 * Apply one transport status event to the set of peers with a proven voice
 * ICE link.
 *
 * Returns the SAME set instance when the event does not change membership,
 * so a caller assigning the result into `$state` can skip a reactive update
 * on every unrelated status event.
 */
export function applyVoiceLinkStatus(
  connected: ReadonlySet<string>,
  event: VoiceLinkStatusEvent
): ReadonlySet<string> {
  if (event.type === "voice-ice-connected" && event.peerId) {
    if (connected.has(event.peerId)) return connected;
    return new Set([...connected, event.peerId]);
  }
  if (
    (event.type === "voice-peer-left" ||
      event.type === "voice-connection-failed") &&
    event.peerId
  ) {
    if (!connected.has(event.peerId)) return connected;
    const next = new Set(connected);
    next.delete(event.peerId);
    return next;
  }
  return connected;
}
