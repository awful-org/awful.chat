/** Shared user-facing strings that appear in more than one place. */

export const RELAY_TIP =
  "Relayed chat connection: this person could not be reached directly, so messages and call setup hop through the relay server. It stays encrypted end to end, the relay only passes the bytes along. Voice has its own route; a TURN badge shows when that is relayed too.";

/** A call tile's badge when that person's voice goes through a TURN server. */
export const TURN_TIP =
  "Voice via TURN: no direct path to this person was found, so their audio goes through a TURN relay. It stays encrypted, and relay use alone does not mean poor quality. The app looks for a direct path again when the network changes.";
