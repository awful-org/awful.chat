/**
 * messaging.ts - message signing, verification, and DM encryption
 *
 * Responsible for:
 *   - Canonical message serialization (the form that gets signed)
 *   - ed25519 sign/verify over Message objects
 *   - X25519 key agreement and AES-GCM DM encryption/decryption
 *
 * All functions that operate on the private key require an unlocked session
 * (call unlockIdentity from identity.ts first).
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex, unhex, utf8 } from "./utils";
import { didToPublicKey, requireSession } from "./identity/identity";
import type { Message } from "./types/message";

/**
 * Legacy (v1) canonical form: only id/senderId/lamport/content are signed.
 * Kept for verifying messages produced before sigV 2 existed.
 */
export function canonicalContent(
  msg: Pick<Message, "id" | "senderId" | "lamport" | "content">
): string {
  return `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`;
}

type Signable = Pick<
  Message,
  | "id"
  | "senderId"
  | "lamport"
  | "content"
  | "reactionTo"
  | "reactionEmoji"
  | "reactionOp"
  | "replyTo"
  | "meta"
> & { sigV?: number; type?: Message["type"]; roomCode?: string };

/**
 * v2 canonical form - additionally covers reaction fields, the replied-to
 * message id, and file metadata (infoHashes!) so none of them can be
 * swapped in transit on a validly signed message. JSON array encoding is
 * deterministic and unambiguous regardless of content characters.
 * Excludes `timestamp` - wall-clock time is untrusted.
 */
export function canonicalContentV2(msg: Signable): string {
  return JSON.stringify([
    msg.id,
    msg.senderId,
    msg.lamport,
    msg.content,
    msg.reactionTo ?? null,
    msg.reactionEmoji ?? null,
    msg.reactionOp ?? null,
    msg.replyTo?.id ?? null,
    msg.meta?.files?.map(
      (f) => `${f.infoHash}:${f.size}:${f.mimeType}:${f.filename}`
    ) ?? null,
  ]);
}

/**
 * v3 canonical form - additionally covers `type` and `roomCode`. Without
 * them a relaying peer could flip a signed Text into a PluginUpdate, or
 * replay one room's signed history into another room's sync batch, with the
 * signature still verifying. The wire carries no roomCode (rooms are
 * topic-derived), so verifiers reconstruct this canonical with the
 * AUTHENTICATED room they are filing the message under.
 */
export function canonicalContentV3(msg: Signable): string {
  return JSON.stringify([
    3,
    msg.type ?? null,
    msg.roomCode ?? null,
    msg.id,
    msg.senderId,
    msg.lamport,
    msg.content,
    msg.reactionTo ?? null,
    msg.reactionEmoji ?? null,
    msg.reactionOp ?? null,
    msg.replyTo?.id ?? null,
    msg.meta?.files?.map(
      (f) => `${f.infoHash}:${f.size}:${f.mimeType}:${f.filename}`
    ) ?? null,
  ]);
}

/** Pick the canonical form matching the message's signature version. */
export function canonicalFor(msg: Signable): string {
  if (msg.sigV === 3) return canonicalContentV3(msg);
  return msg.sigV === 2 ? canonicalContentV2(msg) : canonicalContent(msg);
}

// ── ed25519 sign / verify ─────────────────────────────────────────────────────

/**
 * Sign a message with the current identity's private key.
 * Returns a new message object with `senderDid` and `sig` attached.
 *
 * @throws If the identity is locked.
 */
export function signMessage(message: Message): Message {
  const { privateKey, did } = requireSession();
  const sig = ed25519.sign(utf8(canonicalContentV3(message)), privateKey);
  return { ...message, senderDid: did, sig: hex(sig), sigV: 3 };
}

/**
 * The exact string a peer signs to prove that a did:key controls a libp2p
 * peerId. Domain separated so a binding proof can never be replayed as a
 * signature over anything else.
 */
export function peerBindingContent(did: string, peerId: string): string {
  return `awful:peer-binding:v1:${did}:${peerId}`;
}

/**
 * Prove that this identity owns the given libp2p peerId.
 * @throws If the identity is locked.
 */
export function signPeerBinding(peerId: string): {
  did: string;
  bindingSig: string;
} {
  const { privateKey, did } = requireSession();
  const sig = ed25519.sign(utf8(peerBindingContent(did, peerId)), privateKey);
  return { did, bindingSig: hex(sig) };
}

/**
 * Verify a peer's claim that `did` owns `peerId`.
 * The caller must pass the peerId of the *authenticated* connection the claim
 * arrived on - noise already proved the sender holds that peerId's key, so a
 * valid signature over it is what ties the two identities together.
 */
export async function verifyPeerBinding(
  did: string,
  peerId: string,
  bindingSig: string
): Promise<boolean> {
  if (!did || !peerId || !bindingSig) return false;
  return verifySignature(did, bindingSig, peerBindingContent(did, peerId));
}

/**
 * Verify an ed25519 signature over a canonical content string.
 * Pure function - does not require an unlocked session.
 * Returns false (never throws) on any verification failure.
 *
 * @param senderDid - The signer's did:key identifier.
 * @param sig       - Hex-encoded signature produced by signMessage.
 * @param content   - The exact canonical string that was signed.
 */
export async function verifySignature(
  senderDid: string,
  sig: string,
  content: string
): Promise<boolean> {
  try {
    const publicKey = didToPublicKey(senderDid);
    // `zip215: false` is load-bearing. @noble/curves defaults to ZIP215
    // (blockchain consensus) rules, which deliberately accept small-order
    // public keys: the cofactored equation [8]S*B == [8]R + [8][k]A holds for
    // ANY message when A is small order, so a did:key naming a torsion point
    // verifies an all-zero signature over arbitrary content with no private
    // key - and every peer can name that same did, so a did would stop
    // proving key possession. RFC8032/NIST186-5 rules reject small-order A
    // and non-canonical encodings, and reject nothing a real keypair emits.
    return ed25519.verify(unhex(sig), utf8(content), publicKey, {
      zip215: false,
    });
  } catch {
    return false;
  }
}

/**
 * Verify the signature on a full Message object.
 * Convenience wrapper around verifySignature.
 * Returns false if senderDid or sig are missing.
 */
export async function verifyMessage(message: Message): Promise<boolean> {
  if (!message.senderDid || !message.sig) return false;
  return verifySignature(message.senderDid, message.sig, canonicalFor(message));
}

// ── X25519 key agreement ──────────────────────────────────────────────────────

/**
 * Compute a shared X25519 secret with another peer via ECDH.
 * Requires an unlocked session.
 *
 * @param theirEd25519PubKey - Peer's raw ed25519 public key (from didToPublicKey).
 */
export function computeSharedSecret(
  theirEd25519PubKey: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> {
  const { privateKey } = requireSession();
  const myX25519Priv = ed25519.utils.toMontgomerySecret(
    privateKey
  ) as Uint8Array<ArrayBuffer>;
  const theirX25519Pub = ed25519.utils.toMontgomery(
    theirEd25519PubKey
  ) as Uint8Array<ArrayBuffer>;
  const raw = x25519.getSharedSecret(myX25519Priv, theirX25519Pub);
  // Never use raw ECDH output as a key directly - hash for key separation
  // (domain tag) and to erase the curve point's algebraic structure.
  return sha256
    .create()
    .update(utf8("awful-dm-v1"))
    .update(raw)
    .digest() as Uint8Array<ArrayBuffer>;
}

// ── DM encryption / decryption ────────────────────────────────────────────────

/**
 * Encrypt a plaintext string for a recipient identified by their did:key.
 * Derives a shared X25519 secret via ECDH, then encrypts with AES-256-GCM.
 * Requires an unlocked session.
 *
 * @param plaintext    - The UTF-8 string to encrypt.
 * @param recipientDid - The recipient's did:key identifier.
 * @returns `iv` and `ct` as lowercase hex strings for wire transmission.
 */
export async function encryptForRecipient(
  plaintext: string,
  recipientDid: string
): Promise<{ iv: string; ct: string }> {
  const sharedSecret = computeSharedSecret(didToPublicKey(recipientDid));

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    utf8(plaintext)
  );

  return { iv: hex(iv), ct: hex(new Uint8Array(ct)) };
}

/**
 * Decrypt a ciphertext produced by encryptForRecipient.
 * Derives the same shared secret from the sender's ed25519 public key.
 * Requires an unlocked session.
 *
 * @param ct        - Hex-encoded AES-GCM ciphertext.
 * @param iv        - Hex-encoded 12-byte IV.
 * @param senderDid - The sender's did:key identifier.
 */
export async function decryptFromSender(
  ct: string,
  iv: string,
  senderDid: string
): Promise<string> {
  const sharedSecret = computeSharedSecret(didToPublicKey(senderDid));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(iv) },
    aesKey,
    unhex(ct)
  );

  return new TextDecoder().decode(plaintext);
}
