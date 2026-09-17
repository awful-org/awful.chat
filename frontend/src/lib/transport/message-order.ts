/** Stable conversation order, independent of every participant's wall clock. */
import type { Message } from "$lib/types/message";

export type MessageCursor = Pick<Message, "lamport" | "id">;

// Binary comparison matches IndexedDB's string primary-key ordering. Locale
// collation can differ across devices and must not decide distributed order.
export const compareMessages = (a: MessageCursor, b: MessageCursor): number =>
  a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function appendSorted(
  list: Message[],
  msg: Message,
  cmp: (a: Message, b: Message) => number = compareMessages
): Message[] {
  const next = [...list, msg];
  if (list.length > 0 && cmp(list[list.length - 1], msg) > 0) next.sort(cmp);
  return next;
}
