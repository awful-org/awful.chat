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
