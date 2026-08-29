/**
 * dm-codec.ts - pure encode/decode for the DM wire envelopes and the
 * deterministic DM room-code hash. No transport or Svelte dependencies,
 * so it is unit-testable in isolation.
 *
 * Envelope layout: 1 tag byte + payload.
 *   0x01 chat  - JSON { id, text, ts }
 *   0x02 ack   - raw messageId string (delivery receipt)
 *   0x03 read  - JSON string[] of messageIds (read receipt)
 */

export interface DmReplyTo {
  id: string;
  senderName: string;
  content: string;
}

export interface DmReaction {
  to: string;
  emoji: string;
  op: "add" | "remove";
}

export interface DmPayload {
  id: string;
  text: string;
  ts: number;
  /**
   * Optional: the sender's assigned lamport for this message. Both sides
   * store the SAME value so their sync watermarks stay comparable. Absent
   * from older clients - receivers fall back to ts.
   */
  lamport?: number;
  /** Optional: this message quotes another. Older clients ignore it. */
  replyTo?: DmReplyTo;
  /**
   * Optional: this is a reaction, not a chat line. The emoji is ALSO sent as
   * `text`, so an older client renders it as a plain emoji message instead
   * of dropping it silently.
   */
  reaction?: DmReaction;
}

/**
 * Same floor as verify-incoming's MAX_CHAT_CONTENT_LENGTH: no client-side cap
 * on the composer body itself, so this is a generous multiple that still
 * stops a peer wedging a pathological amount of text into a DM envelope.
 */
export const MAX_DM_TEXT_LENGTH = 16_384;

export const DM_CHAT_TAG = 0x01;
export const DM_ACK_TAG = 0x02;
export const DM_READ_TAG = 0x03;

const DM_ROOM_PREFIX = "dm-";
const _dmRoomCodeCache = new Map<string, string>();

/**
 * Generate a stable, deterministic DM room code from two DIDs.
 * - Sort the two DIDs alphabetically
 * - Hash them to create a short stable identifier
 * - Prefix with "dm-" for easy identification
 */
export async function hashDmRoomCode(
  did1: string,
  did2: string
): Promise<string> {
  const input = [did1, did2].sort().join("|");
  const cached = _dmRoomCodeCache.get(input);
  if (cached) return cached;

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  // First 20 bytes (40 hex chars) + "dm-" prefix = 43 chars total
  const hashHex = Array.from(new Uint8Array(hashBuffer).slice(0, 20))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const roomCode = `${DM_ROOM_PREFIX}${hashHex}`;
  _dmRoomCodeCache.set(input, roomCode);
  return roomCode;
}

function tagged(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

export function encodeDmChatEnvelope(payload: DmPayload): Uint8Array {
  return tagged(DM_CHAT_TAG, new TextEncoder().encode(JSON.stringify(payload)));
}

export function encodeDmAckEnvelope(messageId: string): Uint8Array {
  return tagged(DM_ACK_TAG, new TextEncoder().encode(messageId));
}

export function encodeDmReadEnvelope(messageIds: string[]): Uint8Array {
  return tagged(
    DM_READ_TAG,
    new TextEncoder().encode(JSON.stringify(messageIds))
  );
}

export function parseDmEnvelope(
  data: Uint8Array
):
  | { type: "chat"; payload: DmPayload }
  | { type: "ack"; messageId: string }
  | { type: "read"; messageIds: string[] }
  | null {
  if (data.byteLength < 1) return null;
  const tag = data[0];
  const payload = data.subarray(1);
  try {
    if (tag === DM_CHAT_TAG) {
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as DmPayload;
      if (
        typeof parsed?.id !== "string" ||
        typeof parsed?.text !== "string" ||
        parsed.text.length > MAX_DM_TEXT_LENGTH ||
        typeof parsed?.ts !== "number"
      ) {
        return null;
      }
      if (
        parsed.lamport !== undefined &&
        (typeof parsed.lamport !== "number" || !Number.isFinite(parsed.lamport))
      ) {
        delete parsed.lamport;
      }
      // Optional fields are stripped when malformed rather than rejecting
      // the whole message - the text still stands on its own.
      if (
        parsed.replyTo &&
        (typeof parsed.replyTo.id !== "string" ||
          typeof parsed.replyTo.senderName !== "string" ||
          typeof parsed.replyTo.content !== "string")
      ) {
        delete parsed.replyTo;
      }
      if (
        parsed.reaction &&
        (typeof parsed.reaction.to !== "string" ||
          typeof parsed.reaction.emoji !== "string" ||
          (parsed.reaction.op !== "add" && parsed.reaction.op !== "remove"))
      ) {
        delete parsed.reaction;
      }
      return { type: "chat", payload: parsed };
    }
    if (tag === DM_ACK_TAG) {
      return { type: "ack", messageId: new TextDecoder().decode(payload) };
    }
    if (tag === DM_READ_TAG) {
      const ids = JSON.parse(new TextDecoder().decode(payload));
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        return null;
      }
      return { type: "read", messageIds: ids };
    }
  } catch {
    return null;
  }
  return null;
}
