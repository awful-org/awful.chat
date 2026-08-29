/**
 * At-rest encryption for IndexedDB records.
 *
 * Why: IndexedDB deletion is not erasure - Chromium's LevelDB keeps old
 * values in immutable segment files until a compaction the page cannot
 * trigger, so anything ever written in plaintext must be assumed
 * recoverable by forensics. The mitigation is crypto-shredding: the disk
 * only ever holds AES-GCM ciphertext, and destroying (or simply never
 * yielding) the key makes every remnant worthless.
 *
 * The key derives from the identity's ed25519 private key via HKDF with a
 * purpose label, so:
 *  - it exists only while the identity is unlocked (never stored anywhere),
 *  - every device of the same identity derives the same key, which is what
 *    lets device sync and backups round-trip through plaintext exports,
 *  - the only disk artifact that can reach it is the mnemonic record, which
 *    is itself AES-GCM under the unlock password's PBKDF2 key.
 *
 * Record layout: index/keyPath fields the queries need stay in clear;
 * everything else is one AES-GCM blob per record (fresh 12-byte IV each
 * write), with ArrayBuffer fields (file bytes, avatars) encrypted as raw
 * buffers beside it - base64ing megabytes into JSON would triple the work.
 *
 * AAD row binding: AES-GCM alone only proves a blob was sealed under this
 * key, not which row it came from - raw IndexedDB access could swap the
 * `_enc` (or `_encBytes[field]`) blob between two rows of the same store, or
 * across stores, and openRow would decrypt it and hand back the swapped
 * content under the wrong id/sender. Every blob is now sealed with
 * additionalData binding it to "<storeName> <primaryKey>" (bytes fields add
 * a third " <field>" segment), taken from StoreCryptoSpec.storeName/key - so
 * a swapped blob decrypts under the wrong AAD and AES-GCM's auth tag check
 * fails closed. Blobs carry `v: 2` when sealed this way; decrypt only
 * applies AAD when it sees that marker. Rows sealed before this change (no
 * `v`, no AAD) stay swappable between rows of the same store/shape until
 * they are next written - accepted because closing that gap needs no flag or
 * schema bump, just the ordinary "everything gets resealed on next write"
 * path this file already relies on for the blinding migration.
 */

interface EncBlob {
  iv: Uint8Array;
  ct: ArrayBuffer;
  /** Present (2) when `ct` was sealed with AAD binding it to its row (see
   *  above). Absent on rows sealed before AAD binding existed - those decrypt
   *  WITHOUT additionalData, exactly as they were sealed. */
  v?: 2;
}

export interface SealedRow {
  [k: string]: unknown;
  /** AES-GCM over the JSON of every non-clear, non-byte field. */
  _enc: EncBlob;
  /** AES-GCM over raw ArrayBuffer fields, keyed by field name. */
  _encBytes?: Record<string, EncBlob>;
}

export interface StoreCryptoSpec {
  /** Fields kept in plaintext: the keyPath and every indexed/query field. */
  clear: string[];
  /**
   * Fields stored as a keyed hash for indexing, with the REAL value encrypted
   * inside _enc. IndexedDB can only look up what it can see, so a field the
   * app queries by has to be readable without the key - which is why
   * roomCode, senderId and the rest used to sit in plaintext, handing anyone
   * with raw database access the room codes (the membership secret), the file
   * infohashes, and the entire named social graph.
   *
   * A keyed hash keeps the lookup working - equality still matches, and a
   * compound [blinded, lamport] range behaves exactly as [roomCode, lamport]
   * did - while revealing nothing about the input without the key. The blind
   * key is derived per identity, so two accounts on one device produce
   * different hashes for the same room and cannot be correlated.
   *
   * Only worth it for HIGH-ENTROPY values. Hashing `type: "group"` or
   * `status: "sent"` would hide nothing, because an attacker just hashes the
   * three possible inputs and compares - those stay in `clear`.
   */
  blind?: string[];
  /** ArrayBuffer fields encrypted as raw buffers instead of via JSON. */
  bytes?: string[];
  /**
   * This store's name and the name of its keyPath field, used together to
   * bind every ciphertext blob to the row it belongs to (see the AAD row
   * binding note in the header comment). Both optional, and only meaningful
   * together: a spec that omits either (the DM offline queue's ad hoc spec,
   * which seals one blob outside any IndexedDB store) gets no AAD, same as a
   * legacy pre-binding row - there is only ever one such blob, so nothing
   * else exists to swap it with.
   */
  storeName?: string;
  key?: string;
}

let _key: CryptoKey | null = null;
let _indexKey: CryptoKey | null = null;
let _plaintextImportDepth = 0;

/**
 * Open a scoped window in which sealRow passes records through as PLAINTEXT
 * when no key is armed, instead of throwing. Exists for exactly one caller:
 * database import on a device that has not unlocked yet (QR device sync onto
 * a fresh install, replace-mode backup restore) - there is no key to seal
 * with because deriving it needs the password the user has not typed. The
 * caller must mark the at-rest sweep as needed so the first unlock seals
 * these rows. Everywhere else the no-key throw stands.
 */
export function beginPlaintextImport(): () => void {
  _plaintextImportDepth += 1;
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      _plaintextImportDepth -= 1;
    }
  };
}

/** Derive and arm the storage key. Call on unlock, with the session's
 *  ed25519 private key scalar; the label separates this use from signing. */
export async function initStorageCrypto(
  privateKey: Uint8Array<ArrayBuffer>
): Promise<void> {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const ikm = await crypto.subtle.importKey("raw", privateKey, "HKDF", false, [
    "deriveKey",
  ]);
  _key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("awful.chat storage at-rest v1"),
      info: utf8("storage-key"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  // A SEPARATE key for the blind index, from the same HKDF input with a
  // different info string, so the index key never doubles as the content key.
  // Both are identity-scoped: two accounts on one device blind the same room
  // code to different values, so nothing on disk correlates them.
  _indexKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("awful.chat storage at-rest v1"),
      info: utf8("index-key"),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"]
  );
  _blindCache.clear();
}

/** Drop the key. Call on lock/logout; sealed rows become unreadable. */
export function clearStorageCrypto(): void {
  _key = null;
  _indexKey = null;
  _blindCache.clear();
}

/**
 * Marks a value as a blind index rather than a plaintext one. Self-describing
 * on purpose: the migration has to tell an already-blinded row from a legacy
 * plaintext one, and every real value this replaces (a hex room code, a
 * did:key, a base58 peer id, a hex infohash) is a different shape, so a
 * length or charset heuristic would be guesswork. A prefix is unambiguous.
 */
const BLIND_PREFIX = "b1:";

/**
 * A value that has been through blindValue(). Distinct from a plain string on
 * purpose: passing a real room code where a blinded one belongs compiles
 * perfectly and then silently matches nothing in IndexedDB, which is how a
 * dozen call sites shipped broken - a delete that deleted nothing, a lookup
 * that always returned empty, a comparison that was never true. Branding the
 * type turns every one of those into a compile error.
 */
export type Blinded = string & { readonly __blinded: unique symbol };

export function isBlinded(v: unknown): v is Blinded {
  return typeof v === "string" && v.startsWith(BLIND_PREFIX);
}

/**
 * Blinding runs on the hot read path - every room query blinds its room code
 * first - and the same handful of values recur constantly, so the HMAC is
 * memoized. Bounded because the inputs are room codes, DIDs and infohashes,
 * all of which are finite per session; cleared with the key on lock.
 */
const _blindCache = new Map<string, string>();
const BLIND_CACHE_MAX = 4096;

/** The keyed hash of a value, for storing in an indexable field. */
export async function blindValue(value: string): Promise<Blinded> {
  if (isBlinded(value)) return value; // already blinded; never double-hash
  const hit = _blindCache.get(value);
  if (hit !== undefined) return hit as Blinded;
  if (!_indexKey) {
    // During plaintext import (no key yet), return the value as-is with a marker.
    // The migration will re-seal these rows with proper blinding later.
    if (_plaintextImportDepth > 0) {
      return value as Blinded;
    }
    throw new Error("storage is locked: no at-rest key (unlock first)");
  }
  const mac = await crypto.subtle.sign(
    "HMAC",
    _indexKey,
    new TextEncoder().encode(value)
  );
  // base64url, so a blinded value is safe in any key path or log line.
  const out =
    BLIND_PREFIX +
    btoa(String.fromCharCode(...new Uint8Array(mac)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  if (_blindCache.size >= BLIND_CACHE_MAX) _blindCache.clear();
  _blindCache.set(value, out);
  return out as Blinded;
}

export function storageCryptoReady(): boolean {
  return _key !== null;
}

function requireKey(): CryptoKey {
  if (!_key) {
    // Refusing beats falling back: a silent plaintext write would defeat
    // the whole scheme the first time a code path ran before unlock.
    throw new Error("storage is locked: no at-rest key (unlock first)");
  }
  return _key;
}

/** Locked-storage errors must stay LOUD - graceful row-dropping is for
 *  corrupt/foreign ciphertext only, never for reads that ran too early. */
export function isStorageLockedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("storage is locked");
}

async function encrypt(
  key: CryptoKey,
  data: BufferSource,
  aad?: Uint8Array<ArrayBuffer>
): Promise<EncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    aad
      ? { name: "AES-GCM", iv, additionalData: aad }
      : { name: "AES-GCM", iv },
    key,
    data
  );
  return aad ? { iv, ct, v: 2 } : { iv, ct };
}

async function decrypt(
  key: CryptoKey,
  blob: EncBlob,
  aad?: Uint8Array<ArrayBuffer>
): Promise<ArrayBuffer> {
  // Only apply AAD when the blob was sealed with it: passing additionalData
  // that was never bound in at seal time changes the auth tag computation
  // and turns a perfectly good legacy (pre-v2) row into a decrypt failure.
  const useAad = blob.v === 2 ? aad : undefined;
  return crypto.subtle.decrypt(
    useAad
      ? {
          name: "AES-GCM",
          iv: blob.iv as Uint8Array<ArrayBuffer>,
          additionalData: useAad,
        }
      : { name: "AES-GCM", iv: blob.iv as Uint8Array<ArrayBuffer> },
    key,
    blob.ct
  );
}

/**
 * The AAD for one blob: "<storeName> <primaryKey>", plus a " <field>"
 * segment for an _encBytes entry. Reads spec.key off the SEALED row - which,
 * for a store whose keyPath is itself blinded (rooms, profiles, phonebook,
 * yjsDocs), is the hash, not the plaintext - because that is the one form
 * available on both sides: sealRow has already written it into `out` by the
 * time this runs, and openRow sees it directly on the stored row. Returns
 * undefined (no AAD) when the spec does not carry storeName/key, or when the
 * row does not (yet) have a value for that field.
 */
function rowAad(
  spec: StoreCryptoSpec,
  row: Record<string, unknown>,
  field?: string
): Uint8Array<ArrayBuffer> | undefined {
  if (!spec.storeName || !spec.key) return undefined;
  const keyVal = row[spec.key];
  if (keyVal === undefined || keyVal === null) return undefined;
  const s = field
    ? `${spec.storeName} ${String(keyVal)} ${field}`
    : `${spec.storeName} ${String(keyVal)}`;
  return new TextEncoder().encode(s);
}

export function isSealed(row: unknown): row is SealedRow {
  return !!row && typeof row === "object" && "_enc" in (row as object);
}

/** Encrypt a record for storage. Clear fields are copied through; the rest
 *  becomes one ciphertext blob (byte fields their own raw blobs). */
export async function sealRow<T extends Record<string, unknown>>(
  record: T,
  spec: StoreCryptoSpec
): Promise<SealedRow> {
  if (!_key && _plaintextImportDepth > 0) {
    // Locked import: the row lands plaintext (legacy layout) and the
    // at-rest sweep seals it on the first unlock.
    return record as unknown as SealedRow;
  }
  const key = requireKey();
  const out: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  const byteSet = new Set(spec.bytes ?? []);
  const clearSet = new Set(spec.clear);
  const byteBufs: Record<string, Uint8Array<ArrayBuffer>> = {};

  const blindSet = new Set(spec.blind ?? []);

  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (clearSet.has(k)) {
      out[k] = v;
    } else if (blindSet.has(k)) {
      // The hash is what the index sees; the real value goes into `rest` and
      // is encrypted with everything else, so openRow hands it back intact.
      out[k] = await blindValue(String(v));
      rest[k] = v;
    } else if (byteSet.has(k)) {
      // Buffered rather than encrypted here: AAD needs spec.key's value, and
      // that field (clear or blind) may not have been visited yet in this
      // same loop - Object.entries order follows `record`'s own key order,
      // not spec's, so the keyPath field is not guaranteed to come first.
      byteBufs[k] = new Uint8Array(
        v instanceof ArrayBuffer ? v : (v as Uint8Array<ArrayBuffer>).slice()
      ) as Uint8Array<ArrayBuffer>;
    } else {
      rest[k] = v;
    }
  }

  // `out` now carries the keyPath field in its ON-DISK form (blinded already
  // if spec.key is itself a `blind` field), so rowAad reads the same value
  // openRow will see later.
  out._enc = await encrypt(
    key,
    new TextEncoder().encode(JSON.stringify(rest)),
    rowAad(spec, out)
  );
  if (Object.keys(byteBufs).length > 0) {
    const encBytes: Record<string, EncBlob> = {};
    for (const [k, buf] of Object.entries(byteBufs)) {
      encBytes[k] = await encrypt(key, buf, rowAad(spec, out, k));
    }
    out._encBytes = encBytes;
  }
  return out as SealedRow;
}

/** Decrypt a stored row back to the full record. Rows written before the
 *  at-rest migration have no _enc and pass through unchanged.
 *  skipBytes leaves ArrayBuffer fields out - for scans that only need the
 *  small metadata and must not materialize every file blob. */
export async function openRow<T>(
  row: unknown,
  spec: StoreCryptoSpec,
  opts?: { skipBytes?: boolean }
): Promise<T> {
  if (!isSealed(row)) return row as T;
  const key = requireKey();
  const rowObj = row as unknown as Record<string, unknown>;
  const json = new TextDecoder().decode(
    await decrypt(key, row._enc, rowAad(spec, rowObj))
  );
  const rest = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  for (const k of spec.clear) {
    if (k in row) out[k] = (row as Record<string, unknown>)[k];
  }
  if (row._encBytes && !opts?.skipBytes) {
    for (const [k, blob] of Object.entries(row._encBytes)) {
      out[k] = await decrypt(key, blob, rowAad(spec, rowObj, k));
    }
  }
  return out as T;
}

/** Whether a row (sealed or legacy) carries bytes for the given field. */
export function rowHasBytes(row: unknown, field: string): boolean {
  if (!row || typeof row !== "object") return false;
  if (isSealed(row)) {
    return !!row._encBytes?.[field] || !!(row as Record<string, unknown>)[field];
  }
  return !!(row as Record<string, unknown>)[field];
}

/** Open many rows, DROPPING the ones that fail to decrypt (truncated blob,
 *  row sealed under a different identity's key) instead of failing the whole
 *  query - one corrupt row must degrade to one missing row, not a blank app. */
export async function openRows<T>(
  rows: unknown[],
  spec: StoreCryptoSpec
): Promise<T[]> {
  const settled = await Promise.allSettled(
    rows.map((r) => openRow<T>(r, spec))
  );
  const out: T[] = [];
  let dropped = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      out.push(s.value);
    } else if (isStorageLockedError(s.reason)) {
      throw s.reason; // reading before unlock is a bug, not a bad row
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    console.warn(`[storage] dropped ${dropped} undecryptable row(s)`);
  }
  return out;
}

// ── per-store specs ──────────────────────────────────────────────────────────
// Clear = keyPath + indexed fields + fields hot paths filter on WITHOUT
// wanting a decrypt (unread counts, watermark sweeps, page-fill filters).
// Everything content-bearing stays inside the blob.

// storeName/key on every entry below feed the AAD row binding (see the
// header comment): storeName is just the object key restated as a literal
// (spec objects don't otherwise know their own name), key is the IndexedDB
// keyPath field name for that store.

export const STORE_SPECS = {
  messages: {
    storeName: "messages",
    key: "id",
    // id stays clear: it is the primary key, and peers already know it - the
    // same id travels on the wire with every message. lamport stays clear
    // because it is the RANGE half of the [roomCode, lamport] compound index,
    // and a keyed hash destroys ordering. type and status stay clear because
    // they are three- and four-valued: hashing them hides nothing, since the
    // inputs can simply be enumerated and compared.
    clear: ["id", "lamport", "type", "status"],
    // roomCode is the membership secret and senderId is the social graph.
    // Both were readable with no key at all, which is how a second account on
    // one device could list the previous account's rooms and everyone in them.
    blind: ["roomCode", "senderId"],
  },
  attachments: {
    storeName: "attachments",
    key: "id",
    clear: ["id", "status"],
    // infoHash identifies the file in the torrent swarm, and files are seeded
    // unencrypted - so a clear infohash plus a clear room code was a working
    // recipe for fetching someone's shared files.
    blind: ["roomCode", "messageId", "infoHash"],
    // The file bytes. MUST stay listed here: a field that is neither clear,
    // blind nor bytes goes through JSON.stringify, and an ArrayBuffer
    // stringifies to {} - so omitting this silently destroyed every stored
    // attachment's contents.
    bytes: ["data"],
  },
  rooms: {
    storeName: "rooms",
    // Also the primary key of this store, so the key path holds the hash -
    // and that hash is exactly what rowAad reads for AAD, same as openRow
    // sees it on disk.
    key: "roomCode",
    clear: ["type"],
    blind: ["roomCode"],
    bytes: ["pfpData"],
  },
  profiles: {
    storeName: "profiles",
    key: "did",
    clear: ["isMe"],
    blind: ["did"],
    bytes: ["pfpData", "bannerData"],
  },
  phonebook: {
    storeName: "phonebook",
    key: "peerId",
    blind: ["peerId"],
    clear: [],
  },
  savedGifs: {
    storeName: "savedGifs",
    key: "id",
    clear: ["id"],
    blind: ["gifId"],
    bytes: ["data"],
  },
  pending: {
    storeName: "pending",
    key: "id",
    clear: ["id"],
    blind: ["to"],
  },
  // Yjs updates ARE channel content. The id is "channel:{roomCode}", so the
  // key path carried the room code in plaintext even though the update beside
  // it was encrypted; it is blinded as "channel:{hash}".
  yjsDocs: {
    storeName: "yjsDocs",
    // The id is "channel:{roomCode}", so leaving it clear published the room
    // code in the primary key of the one store whose own comment calls its
    // contents channel content. It is blinded as "channel:{hash}".
    key: "id",
    blind: ["id"],
    clear: [],
    bytes: ["update"],
  },
  // Watermarks used to skip encryption entirely, on the grounds that they are
  // pure sync counters digest sweeps read without a decrypt. But the key was
  // "roomCode:senderId" with a roomCode index beside it, so the store that
  // opted out was publishing the very room codes and DIDs every other store
  // protects. It is sealed now; maxLamport stays clear so the never-regress
  // comparison in setWatermark still works inside its write transaction,
  // where nothing can be decrypted.
  watermarks: {
    storeName: "watermarks",
    key: "id",
    // maxLamport, NOT "lamport" - the field name matters. setWatermark's
    // never-regress check compares it against the stored row INSIDE the
    // write transaction, where nothing can be decrypted, so sealing it made
    // the comparison read undefined and silently skip every write.
    clear: ["maxLamport"],
    blind: ["id", "roomCode", "senderId"],
  },
} as const satisfies Record<string, StoreCryptoSpec>;

export type EncryptedStoreName = keyof typeof STORE_SPECS;
