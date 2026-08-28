/**
 * The authenticity gate for every chat message that arrives from the network.
 *
 * Pure on purpose: transport.svelte.ts boots libp2p at import time, so while
 * this lived there it could not be tested, and it is the single function
 * standing between a peer and a forged message in someone else's name.
 */
import { canonicalContentV3, verifySignature } from "../messaging";
import type { WireChatMessage } from "../types/message";

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

export async function verifyIncoming(
  wire: WireChatMessage,
  opts: VerifyOpts = {}
): Promise<boolean> {
  if (!wire.sig) return opts.allowUnsigned === true;
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
  if (wire.sigV !== 3) return false;
  if (!wire.senderDid) return false;
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
  if (wire.senderDid !== wire.senderId) return false;
  // v3 binds type and room. The wire carries no roomCode, so the canonical is
  // reconstructed with the AUTHENTICATED room this message is being filed
  // under - a message signed for another room (or with its type flipped in
  // transit) fails verification here.
  if (!opts.room) return false;
  return verifySignature(
    wire.senderDid,
    wire.sig,
    canonicalContentV3({ ...wire, roomCode: opts.room })
  );
}
