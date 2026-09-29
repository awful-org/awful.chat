import { getMessage, getAttachmentsByMessage, putAttachment } from "$lib/storage";

/** Reconcile only the immutable, admitted message in storage, never a replay's
 * replacement descriptor. Also repairs partially missing attachment sets. */
export async function ensureMessageAttachmentOwnership(id: string, guard: () => void): Promise<void> {
  const message = await getMessage(id);
  guard();
  if (!message?.meta?.files?.length) return;
  const existing = await getAttachmentsByMessage(id);
  guard();
  for (const file of message.meta.files) {
    if (existing.some(row => row.roomCode === message.roomCode && row.infoHash === file.infoHash)) continue;
    await putAttachment({
      id: `message-file:${id}:${file.infoHash}`, roomCode: message.roomCode,
      messageId: id, filename: file.filename, mimeType: file.mimeType,
      size: file.size, infoHash: file.infoHash, encryption: file.encryption,
      width: file.width, height: file.height, status: "pending", createdAt: message.timestamp,
    }, guard);
    guard();
  }
}
