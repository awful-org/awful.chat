import type { Message } from "./types/message";

/**
 * Delivery and read receipts cascade by Lamport order, so the newest own
 * status summarizes every older message too. Keep that one visible instead
 * of repeating the same tick down the whole conversation. A pending newest
 * message intentionally replaces an older read tick with its own pending
 * state: that is the only outstanding delivery the reader needs to see.
 */
export function latestDmReceiptId(
  messages: readonly Message[],
  isOwn: (senderId: string) => boolean,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isOwn(msg.senderId) && msg.status) return msg.id;
  }
  return null;
}
