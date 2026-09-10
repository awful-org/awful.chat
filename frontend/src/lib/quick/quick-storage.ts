/**
 * A storage scope that dies with the page.
 *
 * /qc runs the whole app stack - transport, rooms, plugins - because that is
 * what makes a call a call, and all of it writes to IndexedDB. None of it may
 * land in the database the user's real identity lives in: a quick call is not
 * a room, and it must not leave one behind.
 *
 * So the database gets a different name for the life of the page, and is
 * deleted on the way out. Per PAGE, not per tab: the ephemeral keypair lives
 * only in memory, so a reload is a different identity, and rows sealed with
 * the old key would be unreadable anyway.
 *
 * Anything meant to survive (the name and picture you call under) is written
 * to localStorage by quick-call.svelte.ts instead - see rememberQuickProfile.
 *
 * Must be called BEFORE anything opens the database. main.ts does it, ahead
 * of the app mounting, because identity init opens it on the first frame.
 */

const MAIN_DB = "awful-chat";
const QUICK_PREFIX = "awful-quick-";

let quick: string | null = null;
/** Resolving this releases the lock that marks our database as live. */
let releaseLock: (() => void) | null = null;

export function isQuickStorage(): boolean {
  return quick !== null;
}

/** The database this page uses. Every opener goes through here. */
export function dbName(): string {
  return quick ?? MAIN_DB;
}

/**
 * Switch this page to a throwaway database, and hold a lock named after it
 * for as long as the page lives. The lock is what tells the next page which
 * leftovers are orphans - a tab that crashed released it, a tab still open
 * did not.
 */
export function useQuickStorage(): string {
  if (quick) return quick;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  quick = QUICK_PREFIX + id;
  try {
    void navigator.locks?.request(
      quick,
      () => new Promise<void>((resolve) => (releaseLock = resolve))
    );
  } catch {
    // No Lock Manager: the delete below still runs, only the orphan sweep
    // has nothing to go on.
  }
  return quick;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    // Resolve on blocked too: a delete held up by another connection is not
    // something a page being unloaded can wait for, and the sweep on the
    // next page picks it up.
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/**
 * Delete this page's database and open an empty scope in its place.
 *
 * ROTATES rather than clears, and that is the point: a page that has once
 * been quick must never fall back to the real database. Setting `quick` to
 * null would make dbName() answer "awful-chat" again, so anything written
 * between a hang-up and the next switch - a participant removal still in
 * flight, a profile write, a stray sync - would land in the user's actual
 * data. Rotating makes that fallback unreachable: the answer is always some
 * throwaway name.
 *
 * The new name costs nothing until something writes, because a name is not a
 * database until it is opened. If nothing does, none is created and the sweep
 * has nothing to find.
 *
 * The CALLER closes the cached connection first (storage.closeDatabase), or
 * the delete blocks behind it and the bytes outlive the call they belong to.
 * This module deliberately does not import the store to do that itself.
 */
export async function dropQuickStorage(): Promise<void> {
  if (!quick) return;
  const name = quick;
  releaseLock?.();
  releaseLock = null;
  quick = null;
  useQuickStorage();
  await deleteDatabase(name);
}

/**
 * Delete quick databases nobody is holding: a tab that crashed, or one whose
 * pagehide delete was cut short. Skips any whose lock is still held, so two
 * quick pages open at once do not eat each other.
 *
 * ponytail: silently does nothing without indexedDB.databases() (no Safari
 * before 14, no Firefox before 126). The pagehide delete covers the ordinary
 * case; this only cleans up after a crash.
 */
export async function sweepOrphanQuickStorage(): Promise<void> {
  if (!navigator.locks || !indexedDB.databases) return;
  let names: string[];
  try {
    names = (await indexedDB.databases())
      .map((d) => d.name ?? "")
      .filter((n) => n.startsWith(QUICK_PREFIX) && n !== quick);
  } catch {
    return;
  }
  for (const name of names) {
    await navigator.locks
      .request(name, { ifAvailable: true }, async (lock) => {
        // null means someone still holds it, so the page that owns this
        // database is alive and it is not an orphan.
        if (lock) await deleteDatabase(name);
      })
      .catch(() => {});
  }
}
