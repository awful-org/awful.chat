/**
 * Pure roster-reconciliation logic, split out of transport.svelte.ts so it
 * is unit testable without the whole transport (which builds a libp2p node
 * at import time - see the comment in call-error.ts).
 *
 * A join can arrive before the sender's Profile has bound their DID (see
 * _handleJoinRoom in transport.svelte.ts), so the live roster sometimes
 * admits a raw peerId as a placeholder identity. addRoomParticipant already
 * refuses to persist that shape to storage ("ghosts the member list for 7
 * days" - a leave is keyed by DID and would never match it), but nothing
 * used to come back and fix up the in-memory roster once the DID arrived:
 * the placeholder sat there for the rest of the session, showing either as
 * a duplicate of the correctly-named entry, or - if the peerId->DID mapping
 * was otherwise unresolved - as a bare did:key a later name update could
 * never reach, because that update lands on the real DID, a different
 * roster entry entirely.
 */

/**
 * Once a peerId->DID binding is proven, fold any placeholder entry for that
 * peerId into the real DID. Returns the SAME array instance when there is
 * nothing to reconcile, so a caller assigning the result into `$state` can
 * skip a reactive update.
 */
export function reconcileRoomUsers(
  roomUsers: string[],
  peerId: string,
  did: string
): string[] {
  if (peerId === did || !roomUsers.includes(peerId)) return roomUsers;
  const merged = new Set(roomUsers);
  merged.delete(peerId);
  merged.add(did);
  return [...merged];
}
