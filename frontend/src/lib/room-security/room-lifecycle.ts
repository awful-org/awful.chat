import type { Room } from "$lib/storage";
import { discoveryIdOf, type DiscoveryId, type RoomSecret } from "./keys";
import { storedRoomSecret } from "./invitations";
import { requireSession, didToPublicKey, onIdentityLock, type UnlockedSession } from "$lib/identity/identity";
import { pairwiseRoomSecret, pairwiseLocalId } from "./pairwise";
import { hybridPairwiseRoomSecret, parseDmPqState } from "./pq-dm";
import { ROOM_SECURITY_V2_RELEASED } from "./invitation-release";

interface RoomTransport {
  joinRoom(roomCode: string): void;
  joinSecureRoom(secret: RoomSecret): string;
  joinSecureConversation?(localId: string, secret: RoomSecret, classical?: RoomSecret, peerDid?: string): string;
  holdDmLobby?(localId: string, anchor: DiscoveryId, peerDid?: string): void;
}

// Deriving the post-quantum secret costs an ML-KEM operation, and a DM is
// (re)joined on every frame it sends. Keyed by the session object, so an
// unlock never sees another session's secrets, and emptied on lock.
let hybridCache = new WeakMap<UnlockedSession, Map<string, RoomSecret>>();
onIdentityLock(() => { hybridCache = new WeakMap(); });

/**
 * The one place a DM's wire capability is chosen.
 *
 * Without a post-quantum state it is the classical pairwise secret, as it
 * always was. With one, it is the hybrid secret, joined together with the
 * classical one as its anchor (see LibP2PTransport.joinSecureConversation),
 * and never the classical secret alone. A state that does not derive fails
 * CLOSED: the conversation is not joined at all - only its lobby is held, so
 * the next introduction with the other side can replace the state - because
 * quietly going back to the classical key is the downgrade this exists to
 * rule out.
 */
export function joinDmConversation(
  transport: RoomTransport,
  session: UnlockedSession,
  roomCode: string,
  peerDid: string,
  pq: unknown,
): void {
  if (!transport.joinSecureConversation) throw new Error("DM identity unavailable");
  const remote = didToPublicKey(peerDid);
  const classical = pairwiseRoomSecret(session.privateKey, remote);
  if (pq === undefined || pq === null) {
    transport.joinSecureConversation(roomCode, classical);
    return;
  }
  let hybrid: RoomSecret;
  try {
    const state = parseDmPqState(pq);
    const key = `${roomCode}|${peerDid}|${state.ct}|${state.ek}`;
    let cache = hybridCache.get(session);
    if (!cache) hybridCache.set(session, cache = new Map());
    hybrid = cache.get(key) ?? hybridPairwiseRoomSecret(session.privateKey, remote, state);
    if (cache.size >= 1024) cache.clear();
    cache.set(key, hybrid);
  } catch {
    transport.holdDmLobby?.(roomCode, discoveryIdOf(classical), peerDid);
    throw new Error("DM post-quantum state is unusable");
  }
  transport.joinSecureConversation(roomCode, hybrid, classical, peerDid);
}

/** Local record IDs, never invitation secrets, enter the room lifecycle. */
export function joinStoredRoom(
  transport: RoomTransport,
  roomCode: string,
  record?: Room | null,
): void {
  if (roomCode.startsWith("dm-")) {
    const did = (record as { participantDid?: string } | null)?.participantDid;
    if (!record || record.roomCode !== roomCode || !did || !transport.joinSecureConversation) {
      throw new Error("DM identity unavailable");
    }
    const session = requireSession();
    if (pairwiseLocalId(session.did, did) !== roomCode) throw new Error("DM identity mismatch");
    joinDmConversation(transport, session, roomCode, did, (record as { pq?: unknown }).pq);
    return;
  }
  if (roomCode.startsWith("r2_")) {
    throw new Error("Import the invitation before opening the room.");
  }
  if (roomCode.startsWith("rd2_")) {
    if (!record || record.roomCode !== roomCode) {
      throw new Error("Room invitation is missing. Ask a member for a new link.");
    }
    transport.joinSecureRoom(storedRoomSecret(record));
    return;
  }
  // Legacy operation stays explicit until the coordinated cutover. A malformed
  // capability-bearing record must never enter this branch.
  if (record?.roomSecret) throw new Error("Room capability mismatch");
  if (ROOM_SECURITY_V2_RELEASED) throw new Error("Legacy rooms are read-only. Create a secure room to continue.");
  transport.joinRoom(roomCode);
}
