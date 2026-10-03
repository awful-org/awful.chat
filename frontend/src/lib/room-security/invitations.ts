import { deriveRoomKeys, parseRoomSecret, type RoomSecret } from "./keys";
import { getRoom, putRoom, type Room } from "$lib/storage";
import { PLACEHOLDER_NAME_AT } from "$lib/room-name";
import { captureSessionGuard } from "$lib/identity/session-guard";
import { parseSecureInvitation, secureInvitationLink } from "./invitation-format";
export { parseSecureInvitation, secureInvitationLink } from "./invitation-format";

/** Never mistake a public discovery ID in the address bar for an invitation. */
export async function savedRoomInvitationLink(origin: string, roomCode: string): Promise<string> {
  if (roomCode.startsWith("rd2_")) {
    const room = await getRoom(roomCode);
    if (!room) throw new Error("Room invitation is missing. Ask a member for a new link.");
    return secureInvitationLink(origin, storedRoomSecret(room));
  }
  if (roomCode.startsWith("r2_")) throw new Error("Import the invitation before sharing the room.");
  throw new Error("Legacy rooms cannot issue invitations. Create a new secure room.");
}

/** The database's existing sealed rooms store protects this extra field and
 * carries it through encrypted exports. The public ID remains the record key. */
/**
 * Store the room an invitation opens. `name` is a name somebody chose (a
 * room being created); without one the room gets the "Room" placeholder,
 * which is never announced and gives way to the members' real name.
 */
export async function storeSecureInvitation(input: string, name?: string): Promise<Room> {
  const guard = captureSessionGuard();
  const roomSecret = parseSecureInvitation(input);
  const roomCode = deriveRoomKeys(roomSecret).discoveryId;
  const stored = await getRoom(roomCode);
  guard();
  if (stored?.roomSecret && stored.roomSecret !== roomSecret) throw new Error("Room capability mismatch");
  const room: Room = stored
    ? { ...stored, roomSecret }
    : {
        roomCode, roomSecret, type: "text", createdAt: Date.now(), lastSeenLamport: 0, participants: [],
        ...(name?.trim()
          ? { name: name.trim(), nameAt: Date.now() }
          : { name: "Room", nameAt: PLACEHOLDER_NAME_AT }),
      };
  await putRoom(room, guard);
  guard();
  // putRoom may have raised a new room's generation above a leave marker.
  return (await getRoom(roomCode)) ?? room;
}

export function storedRoomSecret(room: Room): RoomSecret {
  if (!room.roomSecret) throw new Error("Room invitation is missing. Ask a member for a new link.");
  const secret = parseRoomSecret(room.roomSecret);
  if (deriveRoomKeys(secret).discoveryId !== room.roomCode) throw new Error("Room capability mismatch");
  return secret;
}
