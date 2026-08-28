/**
 * identity.ts - DID identity, keypair derivation, and session lifecycle
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
  getWebAuthnRecord,
  deleteWebAuthnRecord,
  migrateAtRest,
  setAtRestOwner,
} from "../storage";
import { initStorageCrypto, clearStorageCrypto } from "../storage-crypto";
import { clearRememberedPassword } from "./remembered-password";
import { utf8 } from "../utils";

/** 2-byte multicodec prefix for ed25519 public keys in did:key. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

/**
 * PBKDF2 iteration count for password-derived keys. 600k matches current OWASP
 * guidance for PBKDF2-SHA256. The count is stored per-record so existing
 * mnemonics encrypted at the old 100k count still decrypt (see unlockIdentity).
 */
const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 100_000;

export interface MnemonicRecord {
  id: "mnemonic";
  /** Random 16-byte PBKDF2 salt. */
  salt: Uint8Array<ArrayBuffer>;
  /** Random 12-byte AES-GCM IV. */
  iv: Uint8Array<ArrayBuffer>;
  /** AES-GCM ciphertext of the BIP39 mnemonic phrase. */
  encrypted: ArrayBuffer;
  /** PBKDF2 iteration count used to derive the key. Absent = legacy 100k. */
  iterations?: number;
}

export interface KeypairRecord {
  id: "keypair";
  /** did:key identifier - permanent, deterministic public identity. */
  did: string;
  /** Cached ed25519 public key bytes (32 bytes). */
  publicKey: Uint8Array<ArrayBuffer>;
  // privateKey is intentionally NOT stored - derived at unlock, held in memory only.
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

export interface WebAuthnRecord {
  id: "webauthn";
  credentialId: ArrayBuffer;
  prfSalt: Uint8Array<ArrayBuffer>; // fed to PRF eval
  iv: Uint8Array<ArrayBuffer>;
  encrypted: ArrayBuffer; // AES-GCM(prfDerivedKey, password)
}

export interface WebAuthnCapabilities {
  /** WebAuthn API exists in this browser */
  supported: boolean;
  /** Platform authenticator available (Touch ID, Windows Hello, Android biometrics) */
  platformAuthenticator: boolean;
  /**
   * true/false when getClientCapabilities() gave a definitive answer,
   * null when the browser is too old to ask (support still possible).
   */
  prfBrowserSupport: boolean | null;
  /** Full confidence: browser + platform authenticator + PRF all available */
  canEnroll: boolean;
}

// ── session ───────────────────────────────────────────────────────────────────

let session: UnlockedSession | null = null;

/**
 * Return the active session or throw if the identity is locked.
 * Used internally by messaging.ts - do not call from UI code.
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
  // slice() copied the scalar - wipe the seed so the only remaining copy
  // is the session privateKey (zeroed later by lockIdentity)
  seed.fill(0);
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
 *          Show the mnemonic to the user exactly once for backup -
 *          it is never retrievable again without the password.
 */
/**
 * Every path that unlocks (password, WebAuthn, create, restore) funnels
 * here: the session key goes live and the at-rest storage key derives from
 * it, so nothing can touch IndexedDB unlocked-but-unencrypted. The
 * migration sweep sealing pre-encryption rows runs in the background.
 */
async function _activateSession(
  privateKey: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer>,
  did: string
): Promise<void> {
  await initStorageCrypto(privateKey);
  session = { privateKey, publicKey, did };
  // The sweep seals with THIS identity's key, so whether it has run is a
  // property of the identity, not of the device.
  setAtRestOwner(did);
  migrateAtRest().catch((err) =>
    console.warn("[storage] at-rest migration failed, will retry:", err)
  );
}

/** localStorage written on behalf of the signed-in identity. */
const IDENTITY_SCOPED_KEYS = [
  "awful:dm-queue:v1", // queued DM envelopes, sealed to the old identity
  "awful:mailbox-optin:v1",
  "awful:duress:v1", // the old account's duress registration
  "awful_remember_duration",
  "awful_remember_reset_timer",
];

/**
 * Erase everything the PREVIOUS identity owned on this device.
 *
 * Called when a different identity takes over: a new account, or a restore of
 * a phrase that is not the one already here. Its rows are sealed under a key
 * derived from ITS private key, so under the new identity most of them can
 * never be read again - but "unreadable" is not "gone". Clear fields survive
 * (a room's code, a message's sender and lamport), rows written before at-rest
 * encryption or during a locked import are not sealed at all and so open under
 * any key, and the at-rest sweep would re-seal exactly those under the NEW
 * identity's key, quietly adopting the old account's data into the new one.
 *
 * That is how a fresh account inherited the previous account's room list.
 */
async function wipePreviousIdentityData(): Promise<void> {
  const { wipeLocalDatabase } = await import("../storage");
  await wipeLocalDatabase();

  // The chat database is not the only place the old account left content.
  const { KNOWN_DBS } = await import("../duress");
  await Promise.all(
    KNOWN_DBS.filter((name) => name !== "awful-chat").map(
      (name) =>
        new Promise<void>((resolve) => {
          // Never reject and never hang: another tab holding a handle blocks
          // the delete, and a new account must still be able to start.
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        })
    )
  );

  // Device-scoped preferences (theme, audio devices, the libp2p device key)
  // belong to the DEVICE, not the account, and are deliberately left alone.
  for (const key of IDENTITY_SCOPED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* blocked storage held nothing to remove */
    }
  }
}

export async function createIdentity(
  password: string
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
    new TextEncoder().encode(mnemonic)
  );

  // A new account on a device that already had one: the old account's data is
  // not this account's to keep. restoreIdentity has always done this; creating
  // did not, so a fresh identity inherited the previous one's rooms. Must run
  // BEFORE the writes below, because the wipe drops the whole database.
  const existing = await getKeypairRecord();
  if (existing && existing.did !== did) {
    await wipePreviousIdentityData();
  }

  const mnemonicRecord: MnemonicRecord = {
    id: "mnemonic",
    salt,
    iv,
    encrypted,
    iterations: PBKDF2_ITERATIONS,
  };
  const keypairRecord: KeypairRecord = { id: "keypair", did, publicKey };

  await putIdentityRecord(mnemonicRecord);
  await putIdentityRecord(keypairRecord);

  await _activateSession(privateKey, publicKey, did);
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
  password: string
): Promise<KeypairRecord> {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic");
  }

  const { privateKey, publicKey } = deriveKeypairFromMnemonic(mnemonic);
  const did = publicKeyToDid(publicKey);

  // Restoring a DIFFERENT identity over this device: the stored rows are
  // sealed under the old identity's key and can never decrypt under the new
  // one - every read would fail forever. They are also not the new
  // account's data to keep. Wipe; restoring the SAME identity (re-imported
  // phrase) keeps local history, the derived key matches.
  const existing = await getKeypairRecord();
  if (existing && existing.did !== did) {
    await wipePreviousIdentityData();
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await AESFromPassword(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(mnemonic)
  );

  const mnemonicRecord: MnemonicRecord = {
    id: "mnemonic",
    salt,
    iv,
    encrypted,
    iterations: PBKDF2_ITERATIONS,
  };
  const keypairRecord: KeypairRecord = { id: "keypair", did, publicKey };

  await putIdentityRecord(mnemonicRecord);
  await putIdentityRecord(keypairRecord);

  // The restored identity is encrypted under the NEW password. Any WebAuthn
  // enrollment or remembered-password record was bound to the OLD password (and
  // possibly a different identity), so it would silently fail or unlock the
  // wrong account - drop both. The user can re-enroll after restoring.
  await deleteWebAuthnRecord().catch(() => {});
  await clearRememberedPassword().catch(() => {});

  await _activateSession(privateKey, publicKey, did);
  return keypairRecord;
}

/**
 * Read the public keypair record from IndexedDB.
 * Does not require an unlocked session - public data only.
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

  // Records written before per-record iteration counts existed used 100k.
  const aesKey = await AESFromPassword(
    password,
    mnemonicRecord.salt,
    mnemonicRecord.iterations ?? LEGACY_PBKDF2_ITERATIONS
  );

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: mnemonicRecord.iv },
      aesKey,
      mnemonicRecord.encrypted
    );
  } catch {
    throw new Error("Wrong password");
  }

  const mnemonic = new TextDecoder().decode(decrypted);
  new Uint8Array(decrypted).fill(0);
  const { privateKey, publicKey } = deriveKeypairFromMnemonic(mnemonic);
  const did = publicKeyToDid(publicKey);

  await _activateSession(privateKey, publicKey, did);
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
  // Sealed rows become unreadable until the next unlock re-derives the key.
  clearStorageCrypto();
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
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function AESFromPRF(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("webauthn-password-wrap"),
    },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Enroll a WebAuthn credential that can unlock this identity.
 * Must be called while the session is already unlocked (password was used).
 * Encrypts the password under the PRF output and stores it in IndexedDB.
 *
 * @throws If PRF extension is not supported by the authenticator.
 */
export async function enrollWebAuthn(password: string): Promise<void> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));

  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: location.hostname, id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "local-user",
        displayName: "Local User",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 }, // ed25519
        { type: "public-key", alg: -7 }, // ES256 fallback
      ],
      authenticatorSelection: { userVerification: "required" },
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  })) as PublicKeyCredential;

  const ext = (cred.getClientExtensionResults() as any).prf;
  let prfOutput: ArrayBuffer | undefined = ext?.results?.first;
  if (!prfOutput && ext?.enabled !== false) {
    // Most browsers spent years only ENABLING prf at create() and evaluating
    // it exclusively in a follow-up get() - which is why this feature
    // originally "did not work": capable devices threw here. One extra
    // fingerprint prompt right after enrollment covers all of them.
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: cred.rawId }],
        userVerification: "required",
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    })) as PublicKeyCredential;
    prfOutput = (assertion.getClientExtensionResults() as any).prf?.results
      ?.first;
  }
  if (!prfOutput) {
    throw new Error("PRF extension not supported by this authenticator");
  }

  const aesKey = await AESFromPRF(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(password)
  );

  const record: WebAuthnRecord = {
    id: "webauthn",
    credentialId: cred.rawId,
    prfSalt,
    iv,
    encrypted,
  };
  await putIdentityRecord(record);
}

/**
 * Unlock identity using a stored WebAuthn credential.
 * Decrypts the password via PRF, then runs the normal unlock flow.
 *
 * @throws If no WebAuthn enrollment exists.
 * @throws If PRF output doesn't match (wrong authenticator / tampered record).
 */
export async function unlockWithWebAuthn(): Promise<void> {
  const record = await getWebAuthnRecord(); // add to storage.ts
  if (!record) throw new Error("No WebAuthn enrollment found");

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: record.credentialId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: record.prfSalt } } },
    },
  })) as PublicKeyCredential;

  const ext = (assertion.getClientExtensionResults() as any).prf;
  if (!ext?.results?.first) {
    throw new Error("PRF extension not supported by this authenticator");
  }

  const aesKey = await AESFromPRF(ext.results.first);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv },
      aesKey,
      record.encrypted
    );
  } catch {
    throw new Error("WebAuthn decryption failed - wrong authenticator?");
  }

  const password = new TextDecoder().decode(decrypted);
  await unlockIdentity(password); // existing flow, unchanged
}

/** Returns true if a WebAuthn credential is enrolled for this identity. */
export async function hasWebAuthnEnrollment(): Promise<boolean> {
  return (await getWebAuthnRecord()) !== undefined;
}

/**
 * Probe WebAuthn capabilities without triggering any browser UI.
 * Call this before showing any biometric enrollment option in the UI.
 *
 * Note: prfBrowserSupport=true does not guarantee the authenticator supports PRF.
 * That is only confirmed after enrollment (create() returns ext.results.first).
 */
export async function getWebAuthnCapabilities(): Promise<WebAuthnCapabilities> {
  const supported =
    typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials;

  if (!supported) {
    return {
      supported: false,
      platformAuthenticator: false,
      prfBrowserSupport: false,
      canEnroll: false,
    };
  }

  const [platformAuthenticator, prfBrowserSupport] = await Promise.all([
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(
      () => false
    ),
    (async (): Promise<boolean | null> => {
      if (typeof PublicKeyCredential.getClientCapabilities !== "function")
        return null;
      try {
        const caps = await PublicKeyCredential.getClientCapabilities();
        const prf = (caps as Record<string, unknown>)["prf"];
        // Absent key = the browser does not know either.
        return typeof prf === "boolean" ? prf : null;
      } catch {
        return null;
      }
    })(),
  ]);

  return {
    supported,
    platformAuthenticator,
    prfBrowserSupport,
    // Optimistic on purpose, twice over. getClientCapabilities() is too new
    // to demand (Chrome 133+/Safari 17.4+): requiring prf===true hid the
    // enroll button on every browser without the probe, including ones whose
    // PRF works fine - only an EXPLICIT "prf: false" rules it out. And
    // platformAuthenticator only says whether THIS machine has a fingerprint
    // reader / Windows Hello; a YubiKey is invisible to every probe until
    // the chooser opens, so requiring it hid the button on exactly the
    // desktops where a security key is the whole plan. The enrollment
    // attempt itself is the real probe; cancelling it costs nothing.
    canEnroll: supported && prfBrowserSupport !== false,
  };
}
