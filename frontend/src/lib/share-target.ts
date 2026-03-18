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
const DB_VERSION = 1;
const STORE = "pending";

function openShareDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
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
    tx.objectStore(STORE).put(record);
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

  const records = await new Promise<SharedPayloadRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as SharedPayloadRecord[]);
    request.onerror = () => reject(request.error);
  });

  if (!records.length) return null;
  records.sort((a, b) => b.createdAt - a.createdAt);
  const latest = records[0];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const record of records) {
      tx.objectStore(STORE).delete(record.id);
    }
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
