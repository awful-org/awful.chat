/**
 * Are we on the same SFU node as the people we are in a call with?
 *
 * The SFU keeps its rooms in an in-process map and does not cascade between
 * instances (see sfu-pool.ts: "a room has to live ENTIRELY on one SFU"). A
 * room split across two nodes is therefore two rooms, and no camera or screen
 * share can ever cross between them.
 *
 * The client has always been able to see this - the server reports how many
 * peers its copy of the room holds - and has never looked. That makes it the
 * worst kind of failure: voice still works (it is peer to peer), the roster is
 * correct, every status reads connected, and the tiles stay empty forever.
 *
 * The comparison is only valid at ONE instant. `roomPeerCount` is a snapshot
 * taken during the join handshake and never updated, so checking it against a
 * roster that has grown since would accuse the peer who simply arrived first.
 */

export const SFU_MISPLACED_MESSAGE =
  "Video server put this call on a different node - voice works, camera and screen share will not. Leaving and rejoining usually lands everyone together.";

export interface PlacementReading {
  /** Peers presence already placed in this call room, when we joined the SFU. */
  expectedOthers: number;
  /** Whether the SFU session is actually usable; a dead one proves nothing. */
  sessionLive: boolean;
  /** What the SFU said its room held, in the same breath. */
  reportedByServer: number;
}

/**
 * True only when the two disagree in the one direction that can mean nothing
 * else: we know somebody is here, and the server that is supposed to be
 * carrying their media says its room is empty.
 *
 * Deliberately silent in every ambiguous case. The first person into a call
 * legitimately sees zero. A server that reports FEWER than we expect - two of
 * three, say - can be a peer mid-join rather than a split, and crying wolf on
 * that would make the real signal worthless.
 */
export function isMisplaced(r: PlacementReading): boolean {
  if (r.expectedOthers < 1) return false;
  if (!r.sessionLive) return false;
  return r.reportedByServer === 0;
}
