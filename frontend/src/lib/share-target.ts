interface SharedPayloadFile {
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
}

interface SharedPayloadRecord {
  id: string;
  title?: string;
  text?: string;
  url?: string;
  files: SharedPayloadFile[];
  createdAt: number;
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

  const db = await openShareDB();
  const files: SharedPayloadFile[] = await Promise.all(
    input.files.map(async (file) => ({
      name: file.name,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
      data: await file.arrayBuffer(),
    }))
  );

  const record: SharedPayloadRecord = {
    id: crypto.randomUUID(),
    title: input.title,
    text: input.text,
    url: input.url,
    files,
    createdAt: Date.now(),
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
  const latest = await new Promise<SharedPayloadRecord | null>(
    (resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx
        .objectStore(STORE)
        .index(CREATED_AT_INDEX)
        .openCursor(null, "prev");
      request.onsuccess = () =>
        resolve((request.result?.value as SharedPayloadRecord) ?? null);
      request.onerror = () => reject(request.error);
    }
  );

  if (!latest) return null;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return {
    files: latest.files.map(
      (entry) =>
        new File([entry.data], entry.name, {
          type: entry.type,
          lastModified: entry.lastModified,
        })
    ),
    text: latest.text,
    title: latest.title,
    url: latest.url,
  };
}
