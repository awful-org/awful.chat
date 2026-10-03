import { MessageType, type Message } from "$lib/types/message";

/** emoji -> who reacted with it, in the order they did. */
export type EmojiTally = Map<string, Set<string>>;
/** message id -> its reactions. */
export type ReactionTally = Map<string, EmojiTally>;

/**
 * Fold the reaction rows of a message list into a tally per message.
 *
 * A reaction is a message of its own, and the list is replaced whenever
 * anything lands in it, so this runs for every message that arrives. Built
 * fresh, it handed every message with reactions new Maps and Sets each time,
 * and each of them re-rendered its chips and their names for a message that
 * landed somewhere else. Given the previous tally, every message whose
 * reactions did not change gets its previous Map back.
 */
export function tallyReactions(
  messages: readonly Message[],
  /** Who a sender is, so one person's reactions cancel whichever id they
   *  carry: one added before their binding was known holds their peerId. */
  reactorOf: (senderId: string) => string,
  previous?: ReactionTally
): ReactionTally {
  const byMessage: ReactionTally = new Map();
  for (const m of messages) {
    if (m.type !== MessageType.Reaction || !m.reactionTo || !m.reactionEmoji)
      continue;
    let byEmoji = byMessage.get(m.reactionTo);
    if (!byEmoji) {
      byEmoji = new Map();
      byMessage.set(m.reactionTo, byEmoji);
    }
    let users = byEmoji.get(m.reactionEmoji);
    if (!users) {
      users = new Set();
      byEmoji.set(m.reactionEmoji, users);
    }
    const reactor = reactorOf(m.senderId);
    if (m.reactionOp === "remove") users.delete(reactor);
    else users.add(reactor);
  }
  if (!previous) return byMessage;
  for (const [id, tally] of byMessage) {
    const before = previous.get(id);
    if (before && sameTally(before, tally)) byMessage.set(id, before);
  }
  return byMessage;
}

/** The same emoji, with the same people, in the same order - the order the
 *  chips and the names in their tooltips show in. */
function sameTally(a: EmojiTally, b: EmojiTally): boolean {
  if (a.size !== b.size) return false;
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < left.length; i++) {
    const [emojiA, usersA] = left[i];
    const [emojiB, usersB] = right[i];
    if (emojiA !== emojiB || usersA.size !== usersB.size) return false;
    const whoA = [...usersA];
    const whoB = [...usersB];
    for (let j = 0; j < whoA.length; j++) if (whoA[j] !== whoB[j]) return false;
  }
  return true;
}
