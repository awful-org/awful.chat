import type { Message } from "./types/message";

const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Show the newest own status, and - only when the sequence has a hole - the
 * oldest earlier status behind a later one. Uniform and normally progressing
 * histories get one receipt. `read → delivered → read` keeps the delivered
 * message visible too, so simplifying the UI cannot hide an unsent gap.
 */
export function dmReceiptIds(
  messages: readonly Message[],
  isOwn: (senderId: string) => boolean,
): string[] {
  const own = messages.filter((msg) => isOwn(msg.senderId) && msg.status);
  if (!own.length) return [];
  const latest = own[own.length - 1];
  let highestBefore = -1;
  const anomaly = own.find((msg) => {
    const rank = RANK[msg.status!] ?? 0;
    const behind = rank < highestBefore;
    highestBefore = Math.max(highestBefore, rank);
    return behind;
  });
  return anomaly && anomaly.id !== latest.id ? [anomaly.id, latest.id] : [latest.id];
}
