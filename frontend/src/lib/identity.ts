/**
 * identity.ts — DID identity, keypair derivation, and session lifecycle
 *
 * Responsible for:
 *   - BIP39 mnemonic generation and validation
 *   - ed25519 keypair derivation
 *   - did:key encoding/decoding
 *   - Encrypted storage of the mnemonic in IndexedDB
 *   - In-memory session (private key held only while unlocked)
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  getKeypairRecord,
  getMnemonicRecord,
  putIdentityRecord,
} from "./storage";
import { utf8 } from "./utils";

/** 2-byte multicodec prefix for ed25519 public keys in did:key. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

export interface MnemonicRecord {
  id: "mnemonic";
  /** Random 16-byte PBKDF2 salt. */
  salt: Uint8Array<ArrayBuffer>;
  /** Random 12-byte AES-GCM IV. */
  iv: Uint8Array<ArrayBuffer>;
  /** AES-GCM ciphertext of the BIP39 mnemonic phrase. */
  encrypted: ArrayBuffer;
}

export interface KeypairRecord {
  id: "keypair";
  /** did:key identifier — permanent, deterministic public identity. */
  did: string;
  /** Cached ed25519 public key bytes (32 bytes). */
  publicKey: Uint8Array<ArrayBuffer>;
  // privateKey is intentionally NOT stored — derived at unlock, held in memory only.
}

/** In-memory session. Private key exists only while unlocked. */
export interface UnlockedSession {
  /** ed25519 raw private key scalar (32 bytes). Zeroed on lockIdentity(). */
  privateKey: Uint8Array<ArrayBuffer>;
  /** ed25519 public key (32 bytes). */
  publicKey: Uint8Array<ArrayBuffer>;
  /** did:key identifier corresponding to publicKey. */
  did: string;
}

// ── session ───────────────────────────────────────────────────────────────────

let session: UnlockedSession | null = null;

/**
 * Return the active session or throw if the identity is locked.
 * Used internally by messaging.ts — do not call from UI code.
 */
export function requireSession(): UnlockedSession {
  if (!session) {
    throw new Error("Identity is locked. Call unlockIdentity first.");
  }
  return session;
}

/** Returns true if the identity is currently unlocked (private key in memory). */
export function isUnlocked(): boolean {
  return session !== null;
}

// ── mnemonic helpers ──────────────────────────────────────────────────────────

/** Generate a fresh 12-word BIP39 mnemonic (128 bits of entropy). */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(wordlist, 128);
}

/** Return true if the mnemonic is a valid BIP39 phrase. */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}

// ── keypair derivation ────────────────────────────────────────────────────────

/**
 * Derive a deterministic ed25519 keypair from a BIP39 mnemonic.
 * Uses the first 32 bytes of the BIP39 seed as the private scalar.
 */
export function deriveKeypairFromMnemonic(mnemonic: string): {
  privateKey: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
} {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const privateKey = seed.slice(0, 32) as Uint8Array<ArrayBuffer>;
  const publicKey = ed25519.getPublicKey(privateKey) as Uint8Array<ArrayBuffer>;
  return { privateKey, publicKey };
}

// ── did:key encoding ──────────────────────────────────────────────────────────

/**
 * Encode a raw ed25519 public key as a did:key identifier.
 * Prepends the 0xed01 multicodec prefix before base58btc-encoding.
 */
export function publicKeyToDid(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(publicKey, ED25519_MULTICODEC.length);
  return "did:key:" + base58.encode(prefixed);
}

/**
 * Decode a did:key back to the raw ed25519 public key bytes.
 * Strips the 2-byte multicodec prefix.
 *
 * @throws If the string is not a valid did:key.
 */
export function didToPublicKey(did: string): Uint8Array<ArrayBuffer> {
  if (!did.startsWith("did:key:")) {
    throw new Error(`Invalid did:key: ${did}`);
  }
  const prefixed = base58.decode(did.slice("did:key:".length));
  return prefixed.slice(ED25519_MULTICODEC.length) as Uint8Array<ArrayBuffer>;
}

// ── identity lifecycle ────────────────────────────────────────────────────────

/**
 * Generate a new identity from a fresh BIP39 mnemonic.
 * Encrypts the mnemonic with the given password and persists both
 * the encrypted mnemonic and the public keypair record to IndexedDB.
 * The session is unlocked immediately after creation.
 *
 * @returns The KeypairRecord and the plaintext mnemonic.
 *          Show the mnemonic to the user exactly once for backup —
 *          it is never retrievable again without the password.
 */
export async function createIdentity(
  password: string,
): Promise<{ keypair: KeypairRecord; mnemonic: string }> {
  const mnemonic = generateMnemonic();
  const { privateKey, publicKey } = deriveKeypairFromMnemonic(mnemonic);
  const did = publicKeyToDid(publicKey);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await AESFromPassword(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(mnemonic),
  );

  const mnemonicRecord: MnemonicRecord = {
    id: "mnemonic",
    salt,
    iv,
    encrypted,
  };
  const keypairRecord: KeypairRecord = { id: "keypair", did, publicKey };

  await putIdentityRecord(mnemonicRecord);
  await putIdentityRecord(keypairRecord);

  session = { privateKey, publicKey, did };
  return { keypair: keypairRecord, mnemonic };
}

/**
 * Restore an existing identity from a BIP39 mnemonic (account recovery).
 * Re-derives the keypair, re-encrypts the mnemonic with the given password,
 * and overwrites any existing identity in IndexedDB.
 * The session is unlocked immediately after a successful restore.
 *
 * @throws If the mnemonic is not a valid BIP39 phrase.
 */
export async function restoreIdentity(
  mnemonic: string,
  password: string,
): Promise<KeypairRecord> {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic");
  }

  const { privateKey, publicKey } = deriveKeypairFromMnemonic(mnemonic);
  const did = publicKeyToDid(publicKey);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await AESFromPassword(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(mnemonic),
  );

  const mnemonicRecord: MnemonicRecord = {
    id: "mnemonic",
    salt,
    iv,
    encrypted,
  };
  const keypairRecord: KeypairRecord = { id: "keypair", did, publicKey };

  await putIdentityRecord(mnemonicRecord);
  await putIdentityRecord(keypairRecord);

  session = { privateKey, publicKey, did };
  return keypairRecord;
}

/**
 * Read the public keypair record from IndexedDB.
 * Does not require an unlocked session — public data only.
 *
 * @returns The KeypairRecord, or null if no identity has been created yet.
 */
export async function getIdentity(): Promise<KeypairRecord | null> {
  return (await getKeypairRecord()) ?? null;
}

/**
 * Decrypt the stored mnemonic and load the private key into memory.
 * Must be called before any operation in messaging.ts that requires signing
 * or decryption (signMessage, computeSharedSecret, encryptForRecipient, etc.).
 *
 * @throws If no identity exists in IndexedDB.
 * @throws If the password is incorrect (AES-GCM authentication failure).
 */
export async function unlockIdentity(password: string): Promise<void> {
  const mnemonicRecord = await getMnemonicRecord();
  if (!mnemonicRecord) {
    throw new Error("No identity found. Call createIdentity first.");
  }

  const aesKey = await AESFromPassword(password, mnemonicRecord.salt);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: mnemonicRecord.iv },
      aesKey,
      mnemonicRecord.encrypted,
    );
  } catch {
    throw new Error("Wrong password");
  }

  const mnemonic = new TextDecoder().decode(decrypted);
  const { privateKey, publicKey } = deriveKeypairFromMnemonic(mnemonic);
  const did = publicKeyToDid(publicKey);

  session = { privateKey, publicKey, did };
}

/**
 * Zero out the private key in memory and clear the session.
 * Prevents lingering key material in the GC heap.
 * Call this on logout or when the app moves to the background.
 */
export function lockIdentity(): void {
  if (session) {
    session.privateKey.fill(0);
    session = null;
  }
}

/**
 * Derive a 256-bit AES-GCM CryptoKey from a password and salt using PBKDF2-SHA-256.
 * The returned key is non-extractable and can only be used for encrypt/decrypt.
 *
 * @param password - UTF-8 passphrase.
 * @param salt     - Random salt bytes (16 bytes recommended).
 */
export async function AESFromPassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
