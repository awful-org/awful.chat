/**
 * Send a message or reply uniformly, used by both text submissions and GIF/file
 * selections. Ensures all outgoing messages respect reply context consistently.
 *
 * Extracted so the logic can be tested outside the component.
 */
export function createSendOrReply(
  sendMessage: (content: string) => void,
  sendReply: (content: string, target: { id: string }) => void
) {
  return function sendOrReplyWithMessage(
    content: string,
    replyTarget: { id: string } | null
  ): void {
    // Send with reply context if set, otherwise send standalone. This prevents
    // reply targets from silently dropping when a GIF or file is selected instead
    // of text being typed.
    if (replyTarget) {
      sendReply(content, replyTarget);
    } else {
      sendMessage(content);
    }
  };
}
