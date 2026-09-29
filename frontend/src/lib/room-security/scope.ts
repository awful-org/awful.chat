/** Enforce v2 routing context before any application handler or side effect.
 * `channelRoom` comes from the verified transport, never from the payload.
 * This is not message-schema or signature validation; those still follow.
 */
import { ROOM_SECURITY_V2_RELEASED } from "./invitation-release";

export function acceptsRoomScope(payload: unknown, channelRoom: string | null): boolean {
  if (!payload || typeof payload !== "object") return false;
  const claimed = (payload as { roomCode?: unknown }).roomCode;
  if (typeof claimed === "string" && claimed.startsWith("r2_")) return false;
  if (channelRoom?.startsWith("r2_")) return false;
  if (channelRoom?.startsWith("rd2_") || channelRoom?.startsWith("dm-")) {
    return claimed === undefined || claimed === channelRoom;
  }
  // A verified membership on some other connection does not authenticate a
  // legacy direct frame. Public v2 IDs never grant access on their own.
  return !(ROOM_SECURITY_V2_RELEASED && (channelRoom !== null || typeof claimed === "string")) &&
    !(typeof claimed === "string" && (claimed.startsWith("rd2_") || claimed.startsWith("dm-")));
}
