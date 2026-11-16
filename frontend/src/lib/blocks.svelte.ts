/**
 * Soft block: who this device keeps at arm's length, by did:key.
 *
 * Local only - nobody is told, and nothing leaves this device. A blocked
 * person's DMs are refused and their conversation is set aside, their room
 * messages fold to a line you can open, they are muted in calls and get none
 * of your voice, and they notify you of nothing. They still see what you
 * write in a room you share (it is encrypted for everyone in it), and with no
 * accounts a new identity is a click away: "soft" is the honest word.
 *
 * A leaf on purpose: the transport, the voice layer and the views all read
 * isBlockedDid synchronously while handling a message, so the set lives here
 * in memory, loaded once the store is open (loadBlocks) and kept in step by
 * storeBlock/removeBlock. What blocking DOES lives with each of those layers.
 */
import { getBlockEntries, putBlockEntry, type BlockEntry } from "./storage";

export const blocks = $state({
  entries: [] as BlockEntry[],
  /** Bumped on every change, for effects that only need to re-run. */
  version: 0,
});

let blockedSet = new Set<string>();
/** Every entry in the store, lifted ones included. */
let allEntries: BlockEntry[] = [];
/** did -> every [from, until) in which DMs from them were refused. */
let refusedWindows = new Map<string, [number, number][]>();

/** Every lifted window of an entry: the earlier ones and its own, if lifted. */
function liftedWindows(e: BlockEntry): [number, number][] {
  const own: [number, number][] =
    e.unblockedAt !== undefined ? [[e.blockedAt, e.unblockedAt]] : [];
  return [...(e.earlier ?? []), ...own];
}

function adopt(entries: BlockEntry[]): void {
  // `entries` is the active list Settings shows; a lifted block stays in the
  // store only for its refusal windows.
  blocks.entries = entries.filter((e) => e.unblockedAt === undefined);
  blockedSet = new Set(blocks.entries.map((e) => e.did));
  refusedWindows = new Map(
    entries
      .map((e) => [e.did, liftedWindows(e)] as [string, [number, number][]])
      .filter(([, w]) => w.length > 0)
  );
  allEntries = entries;
  blocks.version += 1;
}

/** The load this session made (or is making), shared by every caller. */
let loading: Promise<void> | null = null;
/** Bumped by a clear, so a load that started before it adopts nothing. */
let generation = 0;

/**
 * Read the list from the (unlocked) store, once per session: every caller
 * that must not act on an empty list before it is read (the mailbox, the
 * sidebar, a block itself) awaits the same read.
 */
export function loadBlocks(): Promise<void> {
  if (!loading) {
    const gen = generation;
    loading = getBlockEntries().then((entries) => {
      if (gen === generation) adopt(entries);
    });
  }
  return loading;
}

/**
 * Read the list again, after something other than storeBlock/removeBlock
 * wrote the store - a device sync or a backup merged into this one. Without
 * it the merged blocks sat in storage while this session went on acting on
 * the list it had read at unlock. A load already in flight adopts nothing
 * once this one starts.
 */
export function reloadBlocks(): Promise<void> {
  generation += 1;
  const gen = generation;
  loading = getBlockEntries().then((entries) => {
    if (gen === generation) adopt(entries);
  });
  return loading;
}

/** Forget the list in memory, as a lock or a sign-out does. */
export function clearBlocksInMemory(): void {
  generation += 1;
  loading = null;
  adopt([]);
}

export function isBlockedDid(did: string | null | undefined): boolean {
  void blocks.version;
  return !!did && blockedSet.has(did);
}

/**
 * A DM from this person, written at `ts`, falls in a time they were blocked:
 * refused then, so refused still, live or through history sync. Their
 * clock is theirs to set, so this keeps a backlog out, not a determined
 * sender - which a soft block never claims to.
 */
export function dmRefusedAt(did: string | null | undefined, ts: number): boolean {
  if (!did) return false;
  if (blockedSet.has(did)) return true;
  return (refusedWindows.get(did) ?? []).some(([from, until]) => ts >= from && ts < until);
}

/** The blocked dids, for the voice layer's withhold list. */
export function blockedDids(): ReadonlySet<string> {
  void blocks.version;
  return blockedSet;
}

/** Record a block. Returns false for something that is not a did:key. */
export async function storeBlock(did: string, name: string): Promise<boolean> {
  if (!did.startsWith("did:")) return false;
  // The whole list first: an entry adopted onto an unread one would drop the
  // rest from memory, and an earlier window of this did with it.
  await loadBlocks().catch(() => {});
  if (blockedSet.has(did)) return true;
  // Blocking again starts a new window and carries the earlier ones: what
  // they wrote in those was refused too, and a later unblock's history sync
  // must not deliver it.
  const prior = allEntries.find((e) => e.did === did);
  const earlier = prior ? liftedWindows(prior) : [];
  const entry: BlockEntry = {
    did,
    name: name.slice(0, 64),
    blockedAt: Date.now(),
    ...(earlier.length ? { earlier } : {}),
  };
  await putBlockEntry(entry);
  adopt([...allEntries.filter((e) => e.did !== did), entry]);
  return true;
}

/** Lift a block, keeping its windows of refused DMs (see dmRefusedAt). */
export async function removeBlock(did: string): Promise<void> {
  await loadBlocks().catch(() => {});
  const entry = allEntries.find((e) => e.did === did && e.unblockedAt === undefined);
  if (!entry) return;
  const lifted = { ...entry, unblockedAt: Date.now() };
  await putBlockEntry(lifted);
  adopt(allEntries.map((e) => (e.did === did ? lifted : e)));
}
