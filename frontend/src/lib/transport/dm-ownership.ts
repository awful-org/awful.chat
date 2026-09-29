import { requireSession } from "$lib/identity/identity";
import { MessageType, type WireChatMessage } from "$lib/types/message";

/** Capture the object, not the DID: locking and unlocking the same key revokes work. */
export function captureDmOwnership(): () => void {
  const session = requireSession();
  return () => {
    if (requireSession() !== session) throw new Error("Identity changed");
  };
}

export function allowsUnsignedDmHistory(
  row: WireChatMessage, author: string | null, live: boolean,
): boolean {
  return !live && author !== null && (author === "*" || row.senderId === author) &&
    [MessageType.Text, MessageType.Reply, MessageType.Reaction].includes(row.type as MessageType.Text) &&
    !row.meta?.files?.length;
}
