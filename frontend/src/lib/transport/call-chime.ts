import { sameCall, type CallTag } from "./voice-channel";

/**
 * Should somebody else joining or leaving a call make a sound for us?
 *
 * Pure so the awkward parts are testable: presence is rebroadcast to every
 * peer on connect, so without the transition check a late joiner would set off
 * one chime per person already in the call, and calls in other rooms - or in
 * the other voice channels of our room - must stay silent.
 *
 * Asked as "were they in OUR call, and are they now", not "were they in a
 * call": moving between two voice channels keeps somebody in a call the whole
 * time, and is a join for one channel and a leave for the other.
 */
export interface PeerCallChimeInput {
  /** Are we in a call at all? Nothing chimes if we are not. */
  imInCall: boolean;
  /** Our own call: its room and voice channel. */
  myCall: CallTag | null;
  /** The call they were in before this message, if any. */
  before: CallTag | null;
  /** The call they are in after it, if any. */
  after: CallTag | null;
}

export function peerCallChime(
  input: PeerCallChimeInput
): "join" | "leave" | null {
  if (!input.imInCall || !input.myCall) return null;
  const was = sameCall(input.before, input.myCall);
  const now = sameCall(input.after, input.myCall);
  if (now && !was) return "join";
  if (was && !now) return "leave";
  return null;
}
