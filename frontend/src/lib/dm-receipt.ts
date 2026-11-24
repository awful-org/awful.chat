import type { Message, MessageStatus } from "./types/message";

/**
 * Statuses a reply from the other person makes obvious: they wrote after
 * our message, so a message that reached them was seen. "sending" and
 * "sent" are not among them - their reply does not prove that one arrived,
 * and a receipt saying it has not is the one worth keeping.
 */
const ANSWERED: ReadonlySet<MessageStatus> = new Set(["delivered", "read"]);

/**
 * Which own messages show a receipt: the last of each run with one status.
 * Other people's messages sit between runs without breaking them, so
 * `read, read, delivered, delivered` marks the second read and the second
 * delivered, and `read, delivered, read` marks all three: a message whose
 * status differs from its neighbours is never covered by a later one.
 *
 * And none on a message the other person has answered: a delivered or read
 * message of ours before their latest message needs no tick to say they
 * got it.
 */
export function dmReceiptIds(
  messages: readonly Message[],
  isOwn: (senderId: string) => boolean,
): string[] {
  let lastTheirs = -1;
  messages.forEach((msg, index) => {
    if (!isOwn(msg.senderId)) lastTheirs = index;
  });
  const own = messages
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => isOwn(msg.senderId) && msg.status);
  return own
    .filter(({ msg }, i) => own[i + 1]?.msg.status !== msg.status)
    .filter(({ msg, index }) => !(index < lastTheirs && ANSWERED.has(msg.status!)))
    .map(({ msg }) => msg.id);
}
