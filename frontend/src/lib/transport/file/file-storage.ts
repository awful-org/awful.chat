/** OPFS when available; bounded, page-local ciphertext storage when it is not.
 * Firefox private browsing exposes getDirectory() but rejects it with
 * SecurityError. Plaintext never enters this filesystem. */
const MEMORY_LIMIT = 64 * 1024 * 1024;
let used = 0;
type Entry = { directory: Map<string, Entry> } | { file: Blob };
const entries = new Map<string, Entry>();
const directories = new WeakMap<FileSystemDirectoryHandle, Map<string, Entry>>();
const missing = () => new DOMException("File not found", "NotFoundError");

function drop(entry: Entry): void {
  if ("file" in entry) used -= entry.file.size;
  else for (const child of entry.directory.values()) drop(child);
}

function memoryDirectory(children: Map<string, Entry>): FileSystemDirectoryHandle {
  // Implements the subset consumed by staging, chunk stores and lease cleanup.
  const handle = {
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      let entry = children.get(name);
      if (!entry && options?.create) {
        entry = { directory: new Map() };
        children.set(name, entry);
      }
      if (!entry) throw missing();
      if (!("directory" in entry)) throw new DOMException("Not a directory", "TypeMismatchError");
      return memoryDirectory(entry.directory);
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      let entry = children.get(name);
      if (!entry && options?.create) {
        entry = { file: new Blob() };
        children.set(name, entry);
      }
      if (!entry) throw missing();
      if (!("file" in entry)) throw new DOMException("Not a file", "TypeMismatchError");
      const file = entry;
      let owner = children;
      return {
        async move(destination: FileSystemDirectoryHandle, newName: string) {
          const target = directories.get(destination);
          if (!target) throw new DOMException("Unsupported destination", "NotSupportedError");
          if (owner.get(name) !== file) throw missing();
          if (target === owner && newName === name) return;
          const previous = target.get(newName);
          if (previous) {
            if (!("file" in previous)) throw new DOMException("Not a file", "TypeMismatchError");
            drop(previous);
          }
          target.set(newName, file);
          owner.delete(name);
          name = newName;
          owner = target;
        },
        async getFile() { return new File([file.file], name); },
        async createWritable() {
          let parts: Blob[] = [];
          let reserved = 0;
          let closed = false;
          return {
            async write(data: BlobPart) {
              if (closed) throw new Error("Writer closed");
              const blob = new Blob([data]);
              if (used + blob.size > MEMORY_LIMIT) {
                throw new DOMException("Temporary file storage is full (64 MB). Use a regular window for larger transfers.", "QuotaExceededError");
              }
              used += blob.size;
              reserved += blob.size;
              parts.push(blob);
            },
            async close() {
              if (closed) return;
              if (owner.get(name) !== file) throw missing();
              const blob = new Blob(parts);
              used -= file.file.size;
              file.file = blob;
              reserved = 0;
              parts = [];
              closed = true;
            },
            async abort() {
              if (closed) return;
              used -= reserved;
              reserved = 0;
              parts = [];
              closed = true;
            },
          };
        },
      };
    },
    async removeEntry(name: string, options?: { recursive?: boolean }) {
      const entry = children.get(name);
      if (!entry) throw missing();
      if ("directory" in entry && entry.directory.size && !options?.recursive) {
        throw new DOMException("Directory is not empty", "InvalidModificationError");
      }
      drop(entry);
      children.delete(name);
    },
    async *keys() { yield* children.keys(); },
  } as unknown as FileSystemDirectoryHandle;
  directories.set(handle, children);
  return handle;
}

export async function fileStorageRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage;
  if (storage?.getDirectory) {
    try { return await storage.getDirectory(); }
    catch (error) {
      // A full disk, failed write or corrupt filesystem must still surface.
      if (!(error instanceof DOMException && ["SecurityError", "NotSupportedError"].includes(error.name))) throw error;
    }
  }
  return memoryDirectory(entries);
}
