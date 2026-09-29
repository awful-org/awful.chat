/** In-memory OPFS contract for deterministic transfer lifecycle tests. */
export function fakeOPFS(afterWrite?: () => void) {
  const entries = new Map<string, Blob>();
  const missing = () => new DOMException("Missing", "NotFoundError");
  function directory(prefix = ""): any {
    return {
      async getDirectoryHandle(name: string) { return directory(`${prefix}${name}/`); },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        const path = prefix + name;
        if (!entries.has(path)) {
          if (!opts?.create) throw missing();
          entries.set(path, new Blob());
        }
        return {
          async getFile() { if (!entries.has(path)) throw missing(); return new File([entries.get(path)!], name); },
          async createWritable() {
            const parts: BlobPart[] = [];
            return {
              async write(part: BlobPart) { parts.push(part); afterWrite?.(); },
              async close() { entries.set(path, new Blob(parts)); },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name: string, opts?: { recursive?: boolean }) {
        const path = prefix + name;
        if (opts?.recursive) { for (const key of entries.keys()) if (key.startsWith(path + "/")) entries.delete(key); }
        else entries.delete(path);
      },
    };
  }
  return { entries, storage: { async getDirectory() { return directory(); } } };
}
