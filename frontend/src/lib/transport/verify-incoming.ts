/**
 * The authenticity gate for every chat message that arrives from the network.
 *
 * Pure on purpose: transport.svelte.ts boots libp2p at import time, so while
 * this lived there it could not be tested, and it is the single function
 * standing between a peer and a forged message in someone else's name.
 */
import { canonicalContentV3, verifySignature } from "../messaging";
import type { WireChatMessage } from "../types/message";

/**
 * ChatView has no client-side max on the composer body, so this is a floor
 * picked to stop a peer wedging a pathological amount of data into storage
 * under an otherwise-valid signature, not a multiple of some existing cap.
 */
export const MAX_CHAT_CONTENT_LENGTH = 16_384;

/**
 * Attachments per message.
 *
 * The composer has no count limit of its own (only per-file byte thresholds),
 * so this is a floor picked the same way MAX_CHAT_CONTENT_LENGTH was. It is
 * not cosmetic: every entry becomes an attachment row, a file transfer, a
 * seeder registration and a candidate WebRTC link, and the signed canonical
 * covers the list contents but never its length - so one signed message could
 * ask every recipient for thousands of them.
 */
export const MAX_MESSAGE_FILES = 16;

export interface VerifyOpts {
  /** The AUTHENTICATED room this message is being filed under. */
  room?: string | null;
  /**
   * Only ever true for DM sync batches from the authenticated counterparty
   * (or our own paired device), where receiver-stored history predates
   * signing. Never for live traffic.
   */
  allowUnsigned?: boolean;
}

export type VerifyReason =
  | "content-type"
  | "content-oversize"
  | "too-many-files"
  | "unsigned"
  | "sig-version"
  | "no-did"
  | "did-mismatch"
  | "no-room"
  | "bad-signature";

export type VerifyVerdict = { ok: true } | { ok: false; reason: VerifyReason };

export async function verifyIncoming(
  wire: WireChatMessage,
  opts: VerifyOpts = {}
): Promise<VerifyVerdict> {
  // Ahead of everything else, signed or not: a valid signature (or an
  // allowUnsigned sync batch from a trusted counterparty) only proves who
  // sent it, never that it is a reasonable size to store and render.
  if (typeof wire.content !== "string") {
    return { ok: false, reason: "content-type" };
  }
  if (wire.content.length > MAX_CHAT_CONTENT_LENGTH) {
    return { ok: false, reason: "content-oversize" };
  }
  // Same rule, the other axis: a signature says who attached the list, never
  // that its length is one a client should act on.
  const files = wire.meta?.files;
  if (Array.isArray(files) && files.length > MAX_MESSAGE_FILES) {
    return { ok: false, reason: "too-many-files" };
  }
  if (!wire.sig) {
    return opts.allowUnsigned === true
      ? { ok: true }
      : { ok: false, reason: "unsigned" };
  }
  // v3 ONLY, as of the 2026-08-28 sunset.
  //
  // v1's canonical left reaction/reply/file fields unsigned, so a relay could
  // swap an infoHash or an emoji undetected. v2 fixed that but signed neither
  // the message TYPE nor the ROOM, which left a live hole: a peer holding any
  // legitimately v2-signed message could republish it into a different room,
  // and because a message id is globally unique and storage puts by id, the
  // receiver's original was MOVED there rather than copied - the victim's
  // message destroyed where it belonged, still under their signature.
  //
  // The cost of the sunset is that history written before v3 (2026-08-26) no
  // longer syncs BETWEEN PEERS. Messages already stored stay put, and device
  // sync transfers the database wholesale rather than re-verifying it, so
  // nothing already on a device is lost - a peer simply cannot backfill a
  // room's pre-v3 past to a device that never had it.
  if (wire.sigV !== 3) return { ok: false, reason: "sig-version" };
  if (!wire.senderDid) return { ok: false, reason: "no-did" };
  // The signing DID must BE the claimed sender, always. This was once checked
  // only when senderId was already in did:key form, so a senderId in any
  // other shape - notably a libp2p peerId, which every peer in the mesh can
  // read and which the UI resolves back to that peer's identity - was
  // accepted with a signature from ANY key. The message then rendered under
  // the victim's name, avatar and colour for everyone, and as the victim's
  // OWN message, with no notification. Signing proves authorship only if the
  // signer is the author. Every validly signed message carries
  // senderDid === senderId: signMessage() needs an unlocked session and sets
  // both from it.
  if (wire.senderDid !== wire.senderId) {
    return { ok: false, reason: "did-mismatch" };
  }
  // v3 binds type and room. The wire carries no roomCode, so the canonical is
  // reconstructed with the AUTHENTICATED room this message is being filed
  // under - a message signed for another room (or with its type flipped in
  // transit) fails verification here.
  if (!opts.room) return { ok: false, reason: "no-room" };
  const valid = await verifySignature(
    wire.senderDid,
    wire.sig,
    canonicalContentV3({ ...wire, roomCode: opts.room })
  );
  return valid ? { ok: true } : { ok: false, reason: "bad-signature" };
}
