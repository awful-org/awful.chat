/**
 * Message ids bound to their sender.
 *
 * Storage keys a message by its bare id, and a message we already hold is
 * never replaced (see _handleSyncBatch). Both rules are right, and together
 * they made an id a thing you could squat: a room member who saw your
 * message's id could sign a row of its own under that id - its own DID, so
 * the signature verifies honestly - and push it to a peer who did not have
 * yours yet (someone offline, a reinstall, a late joiner). That peer then
 * refused your real message as an id reuse, for good, and a squat sent as a
 * reaction to nothing rendered nowhere: silent censorship. The same trick on
 * a plugin card's id made the squatter the card's owner.
 *
 * So an id now opens with a digest of its sender's DID, and a receiver
 * refuses a row whose bound id names somebody else. Squatting your id would
 * take a second preimage of 96 bits of SHA-256.
 *
 * Ids written before this (bare UUIDs) carry no binding and are still
 * accepted: history already on the wire has to keep syncing.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** "m" + 24 hex (96 bits of SHA-256(senderDid)) + "-" + a random UUID. */
const BOUND_ID = /^m([0-9a-f]{24})-/;

const prefixCache = new Map<string, string>();

function senderPrefix(senderId: string): string {
  let prefix = prefixCache.get(senderId);
  if (prefix === undefined) {
    const digest = sha256(new TextEncoder().encode(senderId));
    prefix = Array.from(digest.subarray(0, 12), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    if (prefixCache.size > 1024) prefixCache.clear();
    prefixCache.set(senderId, prefix);
  }
  return prefix;
}

/** A fresh message id for a message `senderId` is about to sign. */
export function newMessageId(senderId: string): string {
  return `m${senderPrefix(senderId)}-${crypto.randomUUID()}`;
}

/**
 * Whether a row claiming `senderId` may carry `id`: a bound id must name that
 * sender; an unbound (older) id is accepted from anyone. Never the empty id,
 * which nothing honest makes: storage reads it like any other key, but the
 * checks that ask whether an id is held already skip it, so a conversation
 * was made for a row under it and then found the id taken - an empty
 * request, charged to the session's new conversations, per minted identity.
 */
export function messageIdAllowedFor(id: string, senderId: string): boolean {
  if (typeof id !== "string" || !id || typeof senderId !== "string") return false;
  const bound = BOUND_ID.exec(id);
  return !bound || bound[1] === senderPrefix(senderId);
}
