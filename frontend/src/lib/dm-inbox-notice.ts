import type { MailboxDepositResult } from "./transport/mailbox.svelte";

/**
 * The warning above a DM's composer when a message can only arrive while
 * both people are online at once.
 *
 * A DM to someone offline is queued here and, with both offline inboxes on,
 * also left sealed in their relay mailbox for them to collect. With either
 * inbox off there is no mailbox copy - ours does not deposit, theirs does not
 * collect - so it waits for the two of you to overlap. Sending still works
 * either way; this only says when it will land. Null when there is nothing to
 * warn about, including whenever they are online right now.
 */
export function dmInboxNotice(opts: {
  peerName: string;
  peerOnline: boolean;
  theirInboxOff: boolean;
  myInboxOff: boolean;
}): string | null {
  const { peerName, peerOnline, theirInboxOff, myInboxOff } = opts;
  if (peerOnline || (!theirInboxOff && !myInboxOff)) return null;
  const when = `${peerName} only gets this while you are both online.`;
  if (theirInboxOff && myInboxOff) return `Both your offline inboxes are off - ${when}`;
  if (theirInboxOff) return `${peerName} has their offline inbox off - they only get this while you are both online.`;
  return `Your offline inbox is off - ${when}`;
}

/**
 * Whether a copy left in the relay mailbox earns the single tick ("the relay
 * holds it"). Not when their offline inbox is off: their app never collects
 * it, so it only arrives while you are both online and the clock stays until
 * then. The copy is still left, in case they turn the inbox back on.
 */
export function relayCopyCounts(
  result: MailboxDepositResult,
  theirInboxOff: boolean,
): boolean {
  return result === "sent" && !theirInboxOff;
}

/** What the clock on a queued DM says, given why it is still waiting. */
export function queuedReceiptTip(opts: {
  tooLongForInbox: boolean;
  myInboxOff: boolean;
  theirInboxOff: boolean;
}): string {
  // Too large for the mailbox, so it can only ever travel peer to peer:
  // saying it is waiting in their offline inbox would be a flat lie.
  if (opts.tooLongForInbox) return "Too long for the offline inbox, sends when they are online";
  if (opts.myInboxOff) return "Queued - will send when the recipient is reachable";
  if (opts.theirInboxOff) return "Queued - their offline inbox is off, so it sends when you are both online";
  return "Queued - waiting in their offline inbox";
}
