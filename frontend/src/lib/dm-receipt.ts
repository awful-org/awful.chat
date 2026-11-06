import type { Message } from "./types/message";

/**
 * Which own messages show a receipt: the last of each run with one status.
 * Other people's messages sit between runs without breaking them, so
 * `read, read, delivered, delivered` marks the second read and the second
 * delivered, and `read, delivered, read` marks all three: a message whose
 * status differs from its neighbours is never covered by a later one.
 */
export function dmReceiptIds(
  messages: readonly Message[],
  isOwn: (senderId: string) => boolean,
): string[] {
  const own = messages.filter((msg) => isOwn(msg.senderId) && msg.status);
  return own
    .filter((msg, index) => own[index + 1]?.status !== msg.status)
    .map((msg) => msg.id);
}
