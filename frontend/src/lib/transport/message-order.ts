/**
 * How the message timeline is ordered.
 *
 * Its own module because it is pure: importing it must not drag the whole
 * transport - and its libp2p dependencies - into anything that only wants to
 * know which of two messages comes first.
 */
import type { Message } from "$lib/types/message";

/**
 * Wall-clock order, which is the order a person reads in.
 *
 * A lamport clock orders causally, not chronologically: two peers who have
 * not heard from each other advance their counters independently, so a
 * message sent today by a peer whose counter is behind sorts above one sent
 * yesterday by a peer whose counter is ahead. Correct for causality, wrong
 * for someone reading down a screen - it put a message under "Today" above a
 * message under "Yesterday".
 *
 * Lamport stays the tiebreaker, so messages inside the same millisecond keep
 * a stable causal order, and senderId settles the rest so two peers never
 * render the same history differently.
 *
 * This is deliberately NOT what plugin updates fold through: those use
 * foldComparator in plugins/state.svelte.ts, where causal order is the point
 * and a peer's clock must not be able to reorder a reducer.
 *
 * DM rooms already worked this way - nextDmLamport assigns wall-clock ms
 * precisely because a small room counter filed messages before conversations
 * they came after.
 */
export const compareMessages = (a: Message, b: Message): number =>
  a.timestamp !== b.timestamp
    ? a.timestamp - b.timestamp
    : a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId);

/**
 * Messages almost always arrive in order, so appending is the common case;
 * only fall back to a full sort when the newcomer actually lands out of
 * order. Re-sorting the whole history per incoming message scaled with room
 * size.
 */
export function appendSorted(
  list: Message[],
  msg: Message,
  cmp: (a: Message, b: Message) => number = compareMessages
): Message[] {
  const next = [...list, msg];
  if (list.length > 0 && cmp(list[list.length - 1], msg) > 0) next.sort(cmp);
  return next;
}
