/**
 * Which session a temporary OPFS entry belongs to, so what a closed page left
 * behind can be told apart from what a running one is still using.
 *
 * A torrent's piece store and a send's ciphertext staging live as long as the
 * session that made them, and nothing on the way out can remove them: an
 * unloading page gets no async time, and a crash or an OS kill runs nothing at
 * all. Every reload used to add another copy of each file opened, sent or
 * downloaded (older builds also left the DECRYPTED copy in room-v2-transfers),
 * and the directories only ever grew. So they are cleared on the way in, by
 * the next page that starts, and on lock - and what that sweep must never
 * touch is a running page's files: a second tab, a quick send, a quick call.
 *
 * Each file transport therefore keeps its entries under a directory named
 * after a lease, and holds a Web Lock of the same name for as long as the
 * lease lives. The browser releases a lock when its page closes or crashes,
 * which makes the test for an orphan exact: a lease whose lock can be taken
 * has nobody left to use its files. The durable ciphertext store
 * (ciphertext-store.ts) is not temporary and is never swept.
 */

export const PIECES_DIR = "room-v2-pieces";
export const STAGING_DIR = "room-v2-transfers";
const AREAS = [PIECES_DIR, STAGING_DIR] as const;
type Area = (typeof AREAS)[number];

const LOCK_PREFIX = "awful:opfs:";
const LEASE_NAME = /^[0-9a-f]{16}$/;

function notFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function removeEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
  await parent.removeEntry(name, { recursive: true }).catch((error) => {
    if (!notFound(error)) throw error;
  });
}

export class OPFSLease {
  readonly id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  /**
   * Settles once the lock is held - or at once, with no Lock Manager. Taken
   * with the first directory, not before: a page that never touches a file
   * holds no lock for it.
   */
  private held: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private ended = false;

  private hold(): Promise<void> {
    this.held ??= new Promise<void>((resolve) => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return resolve();
      try {
        locks
          .request(LOCK_PREFIX + this.id, () => {
            resolve();
            if (this.ended) return undefined;
            return new Promise<void>((r) => (this.release = r));
          })
          .catch(() => resolve());
      } catch {
        // Lock Manager refused (opaque origin, storage blocked): files still
        // work, only the sweep has nothing to go on.
        resolve();
      }
    });
    return this.held;
  }

  /**
   * This lease's directory in one area. Made only once the lock is held: a
   * directory that existed before its lock would look abandoned to a sweep
   * running in another tab.
   */
  async directory(area: Area): Promise<FileSystemDirectoryHandle> {
    if (!globalThis.navigator?.storage?.getDirectory) {
      throw new Error("Encrypted file transfers need browser storage support. Please update your browser.");
    }
    await this.hold();
    if (this.ended) throw new Error("Transfer storage released");
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(area, { create: true });
    return parent.getDirectoryHandle(this.id, { create: true });
  }

  /** Remove everything this lease holds, then let its lock go. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      // Never held means nothing was ever made under it.
      if (!this.held) return;
      await this.held;
      if (!globalThis.navigator?.storage?.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      for (const area of AREAS) {
        const parent = await root.getDirectoryHandle(area).catch(() => null);
        // A file still open for writing refuses removal; the lock goes
        // anyway, and the next sweep finds the leftovers unowned.
        if (parent) await removeEntry(parent, this.id).catch(() => {});
      }
    } finally {
      this.release?.();
      this.release = null;
    }
  }

  /**
   * Remove what closed sessions left in the temporary areas: every lease
   * directory whose lock is free, and - when no page of an older build can
   * still be running - every entry from before leases existed.
   *
   * Those older entries carry no lease, so only the pages around them can
   * vouch for them, and the only ones that could be using one are pages of
   * that older build still open from before an update. A running main page
   * holds or waits for the node lock (node-lock.ts) and a quick call holds
   * its storage lock (quick-storage.ts); while any other page does, older
   * entries are left for a later sweep. They are also where earlier builds
   * left decrypted attachments, which is why they are not simply left alone.
   */
  async sweep(): Promise<void> {
    const locks = globalThis.navigator?.locks;
    if (!locks || !globalThis.navigator?.storage?.getDirectory) return;
    const unleasedAreFree = await noOtherPage(locks);
    const root = await navigator.storage.getDirectory();
    for (const area of AREAS) {
      const parent = await root.getDirectoryHandle(area).catch(() => null);
      if (!parent) continue;
      const names: string[] = [];
      for await (const name of parent.keys()) names.push(name);
      for (const name of names) {
        if (LEASE_NAME.test(name)) {
          if (name === this.id) continue;
          // Taken only when its page is gone; held while the files go.
          await locks
            .request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
              if (lock) await removeEntry(parent, name);
            })
            .catch(() => {});
        } else if (unleasedAreFree) {
          await removeEntry(parent, name).catch(() => {});
        }
      }
    }
  }
}

/**
 * No other page of this origin runs the app or a quick call right now.
 *
 * The query names the page behind every lock, and this page's own - its node
 * lock, a quick call's storage lock - must not count. A probe lock, held just
 * for the query, says which page this is. The lease's own lock could not: a
 * sweep runs on a lease nothing has used yet, which holds none, so this
 * page's node lock counted as another page's and older entries were only
 * ever removed at boot, before the node lock was taken.
 */
async function noOtherPage(locks: LockManager): Promise<boolean> {
  const probe = `awful:opfs-probe:${crypto.randomUUID()}`;
  try {
    return await locks.request(probe, async () => {
      const { held = [], pending = [] } = await locks.query();
      const self = held.find((lock) => lock.name === probe)?.clientId;
      // No telling whose is whose: count every lock as somebody else's.
      if (self === undefined) return false;
      return ![...held, ...pending].some(
        (lock) =>
          lock.clientId !== self &&
          (lock.name === "awful:node" || !!lock.name?.startsWith("awful-quick-"))
      );
    });
  } catch {
    return false;
  }
}
