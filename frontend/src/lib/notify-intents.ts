/**
 * Notification intents: what the user did on a notification, written by the
 * SERVICE WORKER (which may have no app window to talk to) and drained by
 * the app after unlock. Raw IndexedDB on purpose - this module is bundled
 * into the service worker, same pattern as share-target.ts.
 *
 * The record carries the reply the user typed and the DM it is addressed to,
 * and it used to land on disk as readable JSON. That put it outside the
 * at-rest boundary storage-crypto.ts describes: IndexedDB deletion is not
 * erasure, so anything ever written in the clear must be assumed recoverable.
 * The service worker cannot use the identity's at-rest key - it runs with the
 * app locked or closed - so each record is sealed under a device key of its
 * own: a non-extractable AES-GCM CryptoKey structure-cloned into this same
 * database, the pattern remembered-password.ts already uses. Code in the
 * origin can still ask the key to decrypt (the ceiling of any client-only
 * secret), but the plaintext never reaches the disk, and because the duress
 * wipe deletes awful-notify (duress.ts KNOWN_DBS) the key goes with it and
 * leaves the LevelDB remnants as noise.
 *
 * Records an older build wrote in plaintext are still recoverable from those
 * remnants: this stops new plaintext writes, it does not shred old ones.
 *
 * The same key also seals the CONVERSATION REFS. A notification's tag and data
 * bag live in the browser's own notification store (and, on Android, in the
 * OS), which no amount of care here can lock or shred - so what announce.ts
 * puts there is an opaque ref, never the room code, and the ref -> room code
 * mapping is a sealed record in this database. It has to be persisted rather
 * than kept in the page: the page that showed a notification may be long gone
 * by the time someone taps it.
 */

const DB_NAME = "awful-notify";
const STORE = "intents";
const KEY_STORE = "device-key";
const REF_STORE = "room-refs";
const KEY_ID = "intents";
// v2 added the key store, v3 the conversation refs. Plaintext records left in
// a v1 database are still drained (and cleared) by the reader below.
const DB_VERSION = 3;

/**
 * Marks a value as an opaque conversation reference rather than a room code.
 * announce.ts mints the ref (it is the one with the room code); this module
 * only has to tell the two shapes apart, so an intent written by an older
 * build - which carried the code itself - still routes.
 */
export const ROOM_REF_PREFIX = "cref:";

/** How many conversation refs to keep. Bounded rather than TTL'd: a
 *  notification can sit unread for days, and the ref is the only thing that
 *  still turns its click into a conversation. */
const MAX_ROOM_REFS = 64;

export interface NotifyIntent {
  kind: "open" | "reply";
  roomCode: string;
  dmPeerDid?: string;
  text: string;
  ts: number;
}

/** What actually goes in the store: AES-GCM over the JSON of the intent.
 *  Nothing - not even the timestamp - is kept beside it in the clear. */
interface SealedIntent {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

/** One conversation ref: the room code, AES-GCM under the device key. */
interface SealedRef {
  ref: string;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
  ts: number;
}

function isSealedIntent(row: unknown): row is SealedIntent {
  return !!row && typeof row === "object" && "iv" in row && "ct" in row;
}

function isPlainIntent(row: unknown): row is NotifyIntent {
  return (
    !!row &&
    typeof row === "object" &&
    typeof (row as NotifyIntent).roomCode === "string" &&
    typeof (row as NotifyIntent).ts === "number"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(REF_STORE)) {
        db.createObjectStore(REF_STORE, { keyPath: "ref" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Both sides hold the connection only for the length of one call, but if
    // a page is mid-operation when the version bump lands the open blocks.
    // Failing beats hanging: notificationclick awaits this, and a wedged
    // promise would keep the tap from ever opening the app.
    req.onblocked = () => reject(new Error("awful-notify upgrade blocked"));
  });
}

/** The device key, created on first use. Never leaves IndexedDB, and is not
 *  extractable, so the raw bytes cannot be read back even from this origin. */
function deviceKey(db: IDBDatabase): Promise<CryptoKey> {
  return new Promise<CryptoKey | null>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readonly");
    const req = tx.objectStore(KEY_STORE).get(KEY_ID);
    req.onsuccess = () =>
      resolve((req.result as { key?: CryptoKey } | undefined)?.key ?? null);
    tx.onerror = () => reject(tx.error);
  }).then(async (existing) => {
    if (existing) return existing;
    const fresh = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"]
    );
    // Re-read inside the write transaction: the worker and a page can race to
    // create the key, and the loser has to adopt the winner's or the records
    // it sealed would be undecryptable.
    return new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, "readwrite");
      const store = tx.objectStore(KEY_STORE);
      let winner = fresh;
      const req = store.get(KEY_ID);
      req.onsuccess = () => {
        const rec = req.result as { key?: CryptoKey } | undefined;
        if (rec?.key) winner = rec.key;
        else store.put({ id: KEY_ID, key: fresh });
      };
      tx.oncomplete = () => resolve(winner);
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * The device key, for a caller outside this module that has the same problem:
 * share-target.ts is written by the service worker with the app locked or
 * closed, so the identity's at-rest key is out of reach. It seals under THIS
 * key rather than minting a second one - the duress wipe deletes both
 * databases, so the one key going takes both stores' plaintext with it.
 *
 * Not cached: the connection is held for the length of one call, same as every
 * other function here, and a key cached across a wipe would seal records the
 * app could no longer open.
 */
export async function deviceSealKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    return await deviceKey(db);
  } finally {
    db.close();
  }
}

/**
 * Record what a conversation ref means, so a click on the notification that
 * carries it still lands in the right room. Called by announce.ts as the
 * notification goes up; the room code is sealed, the ref is not (it is a hash,
 * and it is already in the notification either way).
 */
export async function rememberRoomRef(
  ref: string,
  roomCode: string
): Promise<void> {
  const db = await openDb();
  try {
    const key = await deviceKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(roomCode)
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(REF_STORE, "readwrite");
      const store = tx.objectStore(REF_STORE);
      store.put({ ref, iv, ct, ts: Date.now() } satisfies SealedRef);
      // Re-putting the same ref just refreshes it, so this only grows with the
      // number of conversations that ever notified. Trim the oldest anyway.
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = ((all.result as SealedRef[]) ?? []).sort(
          (a, b) => a.ts - b.ts
        );
        for (const row of rows.slice(0, rows.length - MAX_ROOM_REFS)) {
          store.delete(row.ref);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Turn the refs back into room codes. Missing or undecryptable entries are
 *  simply absent from the map, and their intents are dropped by the caller. */
async function readRoomRefs(
  db: IDBDatabase,
  key: CryptoKey,
  refs: string[]
): Promise<Map<string, string>> {
  const rows = await new Promise<SealedRef[]>((resolve, reject) => {
    const tx = db.transaction(REF_STORE, "readonly");
    const store = tx.objectStore(REF_STORE);
    const found: SealedRef[] = [];
    for (const ref of refs) {
      const req = store.get(ref);
      req.onsuccess = () => {
        if (req.result) found.push(req.result as SealedRef);
      };
    }
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
  });

  const out = new Map<string, string>();
  for (const row of rows) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: row.iv },
        key,
        row.ct
      );
      out.set(row.ref, new TextDecoder().decode(pt));
    } catch {
      // Sealed under a key that no longer exists. Noise, not an error.
    }
  }
  return out;
}

export async function storeNotifyIntent(intent: NotifyIntent): Promise<void> {
  const db = await openDb();
  try {
    const key = await deviceKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(intent))
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add({ iv, ct } satisfies SealedIntent);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    // A connection left open would block the next version bump, and this one
    // runs in a worker that may outlive the call.
    db.close();
  }
}

/** Read AND clear every pending intent, oldest first. */
export async function drainNotifyIntents(): Promise<NotifyIntent[]> {
  const db = await openDb();
  let out: NotifyIntent[] = [];
  try {
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        store.clear();
        resolve((getAll.result as unknown[]) ?? []);
      };
      tx.onerror = () => reject(tx.error);
    });
    const key = rows.some(isSealedIntent) ? await deviceKey(db) : null;

    for (const row of rows) {
      if (isSealedIntent(row)) {
        if (!key) continue;
        try {
          const pt = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: row.iv },
            key,
            row.ct
          );
          out.push(JSON.parse(new TextDecoder().decode(pt)) as NotifyIntent);
        } catch {
          // Sealed under a key that no longer exists (a wipe, cleared site
          // data): the record is noise, not an error. Drop it.
        }
      } else if (isPlainIntent(row)) {
        // Written by a build from before the records were sealed.
        out.push(row);
      }
    }

    // What the notification carried is a ref, not a room code (see the header
    // comment). Resolve it here rather than at the click, because this is the
    // only place that both holds the sealing key and knows the intent shape.
    const refs = [
      ...new Set(
        out
          .map((i) => i.roomCode)
          .filter((code) => code.startsWith(ROOM_REF_PREFIX))
      ),
    ];
    if (refs.length > 0) {
      const codes = await readRoomRefs(db, key ?? (await deviceKey(db)), refs);
      out = out.flatMap((intent) => {
        if (!intent.roomCode.startsWith(ROOM_REF_PREFIX)) return [intent];
        const roomCode = codes.get(intent.roomCode);
        // An unresolvable ref names a conversation this device can no longer
        // identify. Dropping it beats routing the reply somewhere else.
        return roomCode ? [{ ...intent, roomCode }] : [];
      });
    }
  } finally {
    db.close();
  }

  // Stale intents (an unlock that never came) are dropped, not replayed.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return out.filter((i) => i.ts > cutoff);
}
