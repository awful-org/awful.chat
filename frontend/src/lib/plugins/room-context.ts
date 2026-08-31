/**
 * host.roomContext()'s filtering and bounding, split out pure so the rules
 * are testable. The host feeds it decrypted messages from ONE room; this
 * module decides what a plugin may see of them and how much.
 *
 * A plugin gets human conversation only: text, replies, file captions and
 * image METADATA. Never plugin cards or updates (a bot reading its own
 * protocol is a feedback loop), never presence/sync/system rows, and never
 * more than the caps below - a plugin that wants the whole history does not
 * get to have it.
 */
import { MessageType, type Message } from "$lib/types/message";

export interface RoomContextImage {
  infoHash: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface RoomContextMessage {
  id: string;
  senderDid: string;
  senderName: string;
  timestamp: number;
  /** Trimmed to ROOM_CONTEXT_MAX_CHARS. */
  text: string;
  replyTo?: { id: string; text: string };
  /** Image attachments only - metadata, never bytes. Resolve bytes through
   *  host.resolveRoomImage. */
  images: RoomContextImage[];
}

export const ROOM_CONTEXT_DEFAULT_MESSAGES = 50;
export const ROOM_CONTEXT_MAX_MESSAGES = 200;
export const ROOM_CONTEXT_MAX_CHARS = 2_000;
export const ROOM_CONTEXT_REPLY_CHARS = 200;
/** Total image entries across the whole result. */
export const ROOM_CONTEXT_MAX_IMAGES = 32;

const CONTEXT_TYPES = new Set([
  MessageType.Text,
  MessageType.Reply,
  MessageType.File,
]);

function trim(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Filter and bound `messages` (ascending, one room) into plugin-safe
 * context. `limit` counts MESSAGES KEPT, newest-first, returned ascending.
 */
export function buildRoomContext(
  messages: readonly Message[],
  options?: { limit?: number }
): RoomContextMessage[] {
  const limit = Math.max(
    1,
    Math.min(
      ROOM_CONTEXT_MAX_MESSAGES,
      options?.limit ?? ROOM_CONTEXT_DEFAULT_MESSAGES
    )
  );
  const out: RoomContextMessage[] = [];
  let imageBudget = ROOM_CONTEXT_MAX_IMAGES;

  // Walk newest-first so the caps keep the RECENT conversation.
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const msg = messages[i];
    if (!CONTEXT_TYPES.has(msg.type)) continue;
    const text =
      typeof msg.content === "string"
        ? trim(msg.content, ROOM_CONTEXT_MAX_CHARS)
        : "";

    const images: RoomContextImage[] = [];
    for (const file of msg.meta?.files ?? []) {
      if (imageBudget <= 0) break;
      if (!file.mimeType?.startsWith("image/")) continue;
      imageBudget -= 1;
      images.push({
        infoHash: file.infoHash,
        filename: file.filename ?? "",
        mimeType: file.mimeType,
        width: file.width,
        height: file.height,
      });
    }

    // A row with nothing a plugin can use (no text, no images) is noise.
    if (!text && images.length === 0) continue;

    out.push({
      id: msg.id,
      senderDid: msg.senderDid || msg.senderId,
      senderName: msg.senderName,
      timestamp: msg.timestamp,
      text,
      ...(msg.replyTo && typeof msg.replyTo.content === "string"
        ? {
            replyTo: {
              id: msg.replyTo.id,
              text: trim(msg.replyTo.content, ROOM_CONTEXT_REPLY_CHARS),
            },
          }
        : {}),
      images,
    });
  }

  out.reverse();
  return out;
}
