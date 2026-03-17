/**
 * messaging.ts — message signing, verification, and DM encryption
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
import { hex, unhex, utf8 } from "./utils";
import { didToPublicKey, requireSession } from "./identity";
import type { Message } from "./types/message";

/**
 * Produce the canonical string that is signed and verified for a message.
 * Excludes `timestamp` — wall-clock time is untrusted and must not affect
 * signature validity.
 *
 * Both signMessage and verifyMessage must use this exact form.
 */
export function canonicalContent(
  msg: Pick<Message, "id" | "senderId" | "lamport" | "content">
): string {
  return `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`;
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
  const sig = ed25519.sign(utf8(canonicalContent(message)), privateKey);
  return { ...message, senderDid: did, sig: hex(sig) };
}

/**
 * Verify an ed25519 signature over a canonical content string.
 * Pure function — does not require an unlocked session.
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
    return ed25519.verify(unhex(sig), utf8(content), publicKey);
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
  return verifySignature(
    message.senderDid,
    message.sig,
    canonicalContent(message)
  );
}

// ── X25519 key agreement ──────────────────────────────────────────────────────

/**
 * Return the X25519 public key derived from the current identity's ed25519 key.
 * Shared with DM senders so they can encrypt messages addressed to this identity.
 * Requires an unlocked session.
 */
export function getX25519PublicKey(): Uint8Array<ArrayBuffer> {
  const { publicKey } = requireSession();
  return ed25519.utils.toMontgomery(publicKey) as Uint8Array<ArrayBuffer>;
}

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
  return x25519.getSharedSecret(
    myX25519Priv,
    theirX25519Pub
  ) as Uint8Array<ArrayBuffer>;
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
