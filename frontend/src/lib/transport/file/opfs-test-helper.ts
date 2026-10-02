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
        entries.delete(path);
      },
      /** Children by name: a directory exists here while it holds a file. */
      async *keys() {
        const names = new Set<string>();
        for (const key of entries.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
        }
        yield* names;
      },
    };
  }
  return { entries, storage: { async getDirectory() { return directory(); } } };
}

/** In-memory Web Locks: exclusive, never queued, each held by a page
 *  (clientId) - this one unless a test plants a lock for another. */
export function fakeLocks(clientId = "this-page") {
  const held = new Map<string, string>();
  return {
    held,
    async request(name: string, ...args: unknown[]) {
      const cb = args.at(-1) as (lock: unknown) => unknown;
      const opts = (args.length > 1 ? args[0] : {}) as { ifAvailable?: boolean };
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        throw new Error("fakeLocks does not queue");
      }
      held.set(name, clientId);
      try { return await cb({ name, mode: "exclusive" }); }
      finally { held.delete(name); }
    },
    async query() {
      return { held: [...held].map(([name, owner]) => ({ name, clientId: owner, mode: "exclusive" })), pending: [] };
    },
  };
}
