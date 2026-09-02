/**
 * Shares waiting for the app to claim them.
 *
 * What the OS share sheet hands over - a title, a link, the text of a message,
 * the bytes of a photo - is exactly the kind of content the at-rest layer
 * exists for (see storage-crypto.ts: IndexedDB deletion is not erasure, so
 * anything ever written in the clear must be assumed recoverable). It used to
 * land here as a plain record, outside that boundary.
 *
 * The identity's at-rest key is out of reach: this module runs in the service
 * worker, with the app locked or closed, which is the same problem
 * notify-intents.ts already solved. So it seals under the SAME device key -
 * a non-extractable AES-GCM CryptoKey living in the awful-notify database -
 * rather than minting a second one. The duress wipe deletes both databases
 * (duress.ts KNOWN_DBS), so the key going takes both stores' plaintext with it.
 *
 * Records an older build wrote in plaintext are still read (and cleared) by
 * the consumer below; this stops new plaintext writes, it does not shred old
 * ones.
 */

import { deviceSealKey } from "./notify-intents";

/** A file's metadata. The bytes are sealed separately, as raw buffers. */
interface SharedPayloadFileMeta {
  name: string;
  type: string;
  lastModified: number;
}

interface SharedPayloadFile extends SharedPayloadFileMeta {
  data: ArrayBuffer;
}

/** The plaintext shape - what an older build stored, and what the sealed
 *  record's blob holds once opened. */
interface SharedPayloadRecord {
  id: string;
  title?: string;
  text?: string;
  url?: string;
  files: SharedPayloadFile[];
  createdAt: number;
}

interface EncBlob {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

/**
 * What actually goes in the store. `id` and `createdAt` stay in the clear:
 * one is the key path, the other is the index the eviction and TTL walk needs
 * to read without a key. Everything the user shared is inside the blobs.
 */
interface SealedShareRecord {
  id: string;
  createdAt: number;
  /** AES-GCM over the JSON of title/text/url and the file descriptors. */
  meta: EncBlob;
  /** AES-GCM over each file's raw bytes, in the descriptors' order. Raw
   *  rather than through the JSON, for the reason storage-crypto seals byte
   *  fields separately: base64ing a 128 MB share would triple the work. */
  fileData: EncBlob[];
}

function isSealedShare(row: unknown): row is SealedShareRecord {
  return !!row && typeof row === "object" && "meta" in row;
}

const DB_NAME = "awful-share-target";
// Version 2 adds the createdAt index. Eviction and "which share is newest"
// both need an ordering, and an index gives it without reading a single
// stored byte back out.
const DB_VERSION = 2;
const STORE = "pending";
const CREATED_AT_INDEX = "createdAt";

/**
 * Bounds on the pending-share store.
 *
 * Nothing upstream can prove a share POST came from the OS share sheet - a
 * service worker sees neither Origin nor Sec-Fetch-Site (see sw.ts) - so any
 * page that can navigate the user to /share-target can add a record here.
 * Unbounded, a run of large POSTs grows this database until the browser
 * evicts the origin, and browsers evict an origin whole: the app's own
 * message history would go with it. The store is therefore capped in three
 * independent directions - how big one share may be, how many may wait at
 * once, and how long an unclaimed one survives - and the first two multiply
 * out to the worst case this database can ever occupy (384 MB).
 *
 * The numbers are set where no real share reaches them: shares are photos,
 * clips and links, the app inlines attachments under 512 KB and persists
 * under 5 MB, and a share is normally claimed seconds later by the next
 * unlock.
 */
const MAX_SHARE_BYTES = 128 * 1024 * 1024;
const MAX_PENDING_RECORDS = 3;
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function openShareDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction?.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "id" });
      if (store && !store.indexNames.contains(CREATED_AT_INDEX)) {
        store.createIndex(CREATED_AT_INDEX, "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeSharedPayload(input: {
  title?: string;
  text?: string;
  url?: string;
  files: File[];
}): Promise<void> {
  // Measured from File.size and string length, before anything is read into
  // memory: an oversized share must be refused without first buffering it.
  // The text fields count too, since a POST body can put its bulk there.
  const bytes =
    input.files.reduce((sum, file) => sum + file.size, 0) +
    2 *
      ((input.title?.length ?? 0) +
        (input.text?.length ?? 0) +
        (input.url?.length ?? 0));
  if (bytes > MAX_SHARE_BYTES) {
    throw new Error("shared payload exceeds the pending-share size cap");
  }

  // Before the database is opened: a share that cannot be sealed must not be
  // written at all, and the throw lands in the service worker's catch, which
  // still redirects into the app shell.
  const key = await deviceSealKey();
  const seal = async (data: BufferSource): Promise<EncBlob> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return {
      iv,
      ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
    };
  };

  const db = await openShareDB();
  const meta: SharedPayloadFileMeta[] = input.files.map((file) => ({
    name: file.name,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  }));
  const fileData: EncBlob[] = [];
  for (const file of input.files) {
    // One file at a time: the cap allows 128 MB, and holding every share's
    // plaintext and ciphertext at once doubles that for no reason.
    fileData.push(await seal(await file.arrayBuffer()));
  }

  const record: SealedShareRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    meta: await seal(
      new TextEncoder().encode(
        JSON.stringify({
          title: input.title,
          text: input.text,
          url: input.url,
          files: meta,
        })
      )
    ),
    fileData,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cutoff = Date.now() - MAX_PENDING_AGE_MS;
    let kept = 0;

    // Walk the existing shares newest first and drop the stale ones and the
    // ones past the cap, then write. openKeyCursor never deserializes the
    // stored file bytes, so eviction costs the same whether the store holds
    // three links or three videos. The write is issued only once the cursor
    // is exhausted, so the new record is never counted against the cap it is
    // making room in.
    const cursor = store.index(CREATED_AT_INDEX).openKeyCursor(null, "prev");
    cursor.onsuccess = () => {
      const position = cursor.result;
      if (!position) {
        store.put(record);
        return;
      }
      if (Number(position.key) >= cutoff && kept < MAX_PENDING_RECORDS - 1) {
        kept += 1;
      } else {
        store.delete(position.primaryKey);
      }
      position.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function consumeLatestSharedPayload(): Promise<{
  files: File[];
  text?: string;
  title?: string;
  url?: string;
} | null> {
  const db = await openShareDB();

  // Only the newest record is ever returned, so only the newest is read.
  // getAll() materialized every pending share's file bytes at once, which the
  // record cap above turns into a predictable multi-hundred-MB spike.
  const latest = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx
      .objectStore(STORE)
      .index(CREATED_AT_INDEX)
      .openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });

  if (!latest) return null;

  // Cleared whether or not it opens below: a record sealed under a key that no
  // longer exists is noise, and leaving it would block every later share
  // behind a cursor that keeps returning it.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const opened = isSealedShare(latest)
    ? await openSharedPayload(latest)
    : // Written by a build from before the records were sealed.
      (latest as SharedPayloadRecord);
  if (!opened) return null;

  return {
    files: opened.files.map(
      (entry) =>
        new File([entry.data], entry.name, {
          type: entry.type,
          lastModified: entry.lastModified,
        })
    ),
    text: opened.text,
    title: opened.title,
    url: opened.url,
  };
}

/** Unseal one record. Null when the device key is gone (a wipe, cleared site
 *  data) or the record is truncated - noise, not an error. */
async function openSharedPayload(
  row: SealedShareRecord
): Promise<SharedPayloadRecord | null> {
  try {
    const key = await deviceSealKey();
    const open = (blob: EncBlob) =>
      crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv }, key, blob.ct);
    const meta = JSON.parse(
      new TextDecoder().decode(await open(row.meta))
    ) as Omit<SharedPayloadRecord, "id" | "createdAt" | "files"> & {
      files: SharedPayloadFileMeta[];
    };
    const files: SharedPayloadFile[] = [];
    for (let i = 0; i < meta.files.length; i++) {
      const blob = row.fileData[i];
      if (!blob) continue;
      files.push({ ...meta.files[i], data: await open(blob) });
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      title: meta.title,
      text: meta.text,
      url: meta.url,
      files,
    };
  } catch {
    console.warn("[share] a pending share could not be opened; dropping it");
    return null;
  }
}
