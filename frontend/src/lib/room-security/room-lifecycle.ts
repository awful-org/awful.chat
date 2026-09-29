import type { Room } from "$lib/storage";
import type { RoomSecret } from "./keys";
import { storedRoomSecret } from "./invitations";
import { requireSession, didToPublicKey } from "$lib/identity/identity";
import { pairwiseRoomSecret, pairwiseLocalId } from "./pairwise";
import { ROOM_SECURITY_V2_RELEASED } from "./invitation-release";

interface RoomTransport {
  joinRoom(roomCode: string): void;
  joinSecureRoom(secret: RoomSecret): string;
  joinSecureConversation?(localId: string, secret: RoomSecret): string;
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
    transport.joinSecureConversation(roomCode, pairwiseRoomSecret(session.privateKey, didToPublicKey(did)));
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
