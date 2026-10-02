import { Buffer } from "buffer";
import { PIECES_DIR, type OPFSLease } from "./opfs-lease";

/** WebTorrent chunk-store contract, disk-backed with bounded per-piece buffers.
 * A random directory per torrent instance avoids cross-tab writer collisions.
 * It sits inside the transport's lease directory (opfs-lease.ts), so whatever
 * a session that closed without tidying up left here is found and removed;
 * webtorrent hands `storeOpts` to the constructor, which is how the lease
 * gets here. */
export class OPFSChunkStore {
  private root: Promise<FileSystemDirectoryHandle>;
  private name = crypto.randomUUID();
  private closed = false;
  constructor(readonly chunkLength: number, opts?: { lease?: OPFSLease }) {
    this.root = opts?.lease
      ? opts.lease.directory(PIECES_DIR)
      : Promise.reject(new Error("Piece store opened without a lease"));
    // Seen here so a store torn down before its first piece does not report
    // the failure as unhandled; every use below still gets it.
    this.root.catch(() => {});
  }
  private async dir() {
    if (this.closed) throw new Error("Store closed");
    return (await this.root).getDirectoryHandle(this.name, { create: true });
  }
  put(index: number, bytes: Uint8Array, cb: (error?: unknown) => void) {
    void (async () => {
      const handle = await (await this.dir()).getFileHandle(String(index), { create: true });
      const writer = await handle.createWritable();
      try { await writer.write(new Uint8Array(bytes)); await writer.close(); }
      catch (e) { await writer.abort().catch(() => {}); throw e; }
    })().then(() => cb(), cb);
  }
  get(index: number, opts: { offset?: number; length?: number } | ((error: unknown, bytes?: Buffer) => void), callback?: (error: unknown, bytes?: Buffer) => void) {
    const cb = typeof opts === "function" ? opts : callback!;
    const range = typeof opts === "function" ? {} : opts;
    void (async () => {
      const file = await (await (await this.dir()).getFileHandle(String(index))).getFile();
      const start = range.offset ?? 0;
      return Buffer.from(await file.slice(start, range.length === undefined ? file.size : start + range.length).arrayBuffer());
    })().then(bytes => cb(null, bytes), cb);
  }
  close(cb: (error?: unknown) => void) { this.destroy(cb); }
  destroy(cb: (error?: unknown) => void) {
    this.closed = true;
    void this.root.then(root => root.removeEntry(this.name, { recursive: true })).catch(e => {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }).then(() => cb(), cb);
  }
}
