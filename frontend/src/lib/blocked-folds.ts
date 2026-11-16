/** One folded run: how many messages, and their ids for "Show". */
export interface BlockedFold {
  count: number;
  ids: string[];
}

/**
 * A soft-blocked person's messages, folded: each unbroken run of them becomes
 * one line, keyed by the run's first message, and the rest of the run maps to
 * null (drawn as nothing). Messages are kept, not removed, so replies and
 * reactions to them still point at something. Your own never fold, and a run
 * a reader opened (`revealed`) shows as it is.
 */
export function foldBlocked(
  messages: readonly { id: string; senderId: string }[],
  blockedSender: (senderId: string) => string | null,
  isSelf: (senderId: string) => boolean,
  revealed: ReadonlySet<string>,
): Map<string, BlockedFold | null> {
  const folds = new Map<string, BlockedFold | null>();
  let run: BlockedFold | null = null;
  let runSender = "";
  for (const m of messages) {
    const who = isSelf(m.senderId) || revealed.has(m.id) ? null : blockedSender(m.senderId);
    if (!who) {
      run = null;
      continue;
    }
    if (run && runSender === who) {
      run.count += 1;
      run.ids.push(m.id);
      folds.set(m.id, null);
    } else {
      run = { count: 1, ids: [m.id] };
      runSender = who;
      folds.set(m.id, run);
    }
  }
  return folds;
}
