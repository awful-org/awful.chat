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
 */

const DB_NAME = "awful-notify";
const STORE = "intents";
const KEY_STORE = "device-key";
const KEY_ID = "intents";
// v2 added the key store. Plaintext records left in a v1 database are still
// drained (and cleared) by the reader below.
const DB_VERSION = 2;

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
  let rows: unknown[];
  let key: CryptoKey | null = null;
  try {
    rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        store.clear();
        resolve((getAll.result as unknown[]) ?? []);
      };
      tx.onerror = () => reject(tx.error);
    });
    if (rows.some(isSealedIntent)) key = await deviceKey(db);
  } finally {
    db.close();
  }

  const out: NotifyIntent[] = [];
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
  // Stale intents (an unlock that never came) are dropped, not replayed.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return out.filter((i) => i.ts > cutoff);
}
