/**
 * The DM retry queue: frames for peers who were unreachable when they were
 * sent, kept in localStorage so they survive a reload and go out when the
 * peer is next seen (dm.svelte.ts flushes them).
 *
 * Its own module, out of dm.svelte.ts, because device sync and backups carry
 * it too, and that file starts the transport when it is imported.
 */
import { requireSession } from "$lib/identity/identity";
import {
  openRow,
  sealRow,
  storageCryptoReady,
  type StoreCryptoSpec,
} from "$lib/storage-crypto";
import { base64ToBytes, bytesToBase64 } from "$lib/utils";
import { ev, errText } from "$lib/telemetry/event";
import { rec } from "$lib/telemetry/recorder";

export interface QueuedMessage {
  to: string;
  data: number[];
  queuedAt: number;
  messageId?: string; // for status updates once the flush succeeds
}

export const DM_QUEUE_KEY = "awful:dm-queue:v1";

/** Bound the offline queue; beyond this the oldest entries give way. */
export const DM_QUEUE_MAX = 200;

// The queue holds message plaintext - body text, quoted replies, reaction
// emoji, the recipient's DID - which everywhere else in the app reaches disk
// only as AES-GCM ciphertext (storage-crypto.ts). Written as readable JSON it
// also survived lockIdentity(), which drops the at-rest key but not
// localStorage, so a locked or seized device still gave up every undelivered
// DM. The value is now a single sealed blob under that same at-rest key.
// localStorage stays the medium because the send path needs the queue to
// survive a reload; base64 because localStorage only holds strings.
const DM_QUEUE_SPEC: StoreCryptoSpec = { clear: [] };

function validQueueEntries(items: unknown[]): QueuedMessage[] {
  return items.filter(
    (item): item is QueuedMessage =>
      !!item &&
      typeof (item as QueuedMessage).to === "string" &&
      Array.isArray((item as QueuedMessage).data) &&
      typeof (item as QueuedMessage).queuedAt === "number"
  );
}

/** One entry's identity, for removing what was sent and merging two queues. */
export function queueEntryKey(e: QueuedMessage): string {
  return `${e.to}|${e.queuedAt}|${e.messageId ?? ""}`;
}

/** The entries of a sealed queue blob, or null when it cannot be opened here. */
async function openSealedQueue(blob: {
  iv?: unknown;
  ct?: unknown;
}): Promise<QueuedMessage[] | null> {
  if (typeof blob.iv !== "string" || typeof blob.ct !== "string") return null;
  if (!storageCryptoReady()) return null;
  try {
    const opened = await openRow<{ q?: unknown }>(
      {
        _enc: { iv: base64ToBytes(blob.iv), ct: base64ToBytes(blob.ct).buffer },
      },
      DM_QUEUE_SPEC
    );
    return Array.isArray(opened.q) ? validQueueEntries(opened.q) : [];
  } catch {
    // Another identity's key, or a truncated write.
    return null;
  }
}

export async function loadQueuedDmMessages(): Promise<QueuedMessage[]> {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DM_QUEUE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // A queue left by a build from before the sealing. Read it so pending
      // messages still go out, then write it straight back sealed: that
      // clears the readable copy, though the bytes already handed to the
      // profile's LevelDB stay recoverable until a compaction the page
      // cannot trigger.
      const legacy = validQueueEntries(parsed);
      await saveQueuedDmMessages(legacy);
      return legacy;
    }
    // Locked: there is nothing to flush before unlock anyway, and returning
    // empty here is safe only because saveQueuedDmMessages refuses to write
    // while locked - otherwise an empty read would overwrite the queue.
    // Undecryptable (another identity's key, a truncated write): the queue is
    // unrecoverable, and treating it as empty beats throwing out of the send
    // path. Nothing overwrites it until the next successful save.
    return (await openSealedQueue(parsed as { iv?: unknown; ct?: unknown })) ?? [];
  } catch {
    return [];
  }
}

export async function saveQueuedDmMessages(queue: QueuedMessage[]): Promise<void> {
  if (typeof localStorage === "undefined") return;
  if (!storageCryptoReady()) {
    // No at-rest key means no way to persist this without putting plaintext
    // back on disk, and refusing beats that. Unreachable from the send path:
    // composing a DM already needs the unlocked identity to sign the envelope
    // and to allocate a lamport out of IndexedDB, so the key is armed by the
    // time anything can be queued.
    console.warn("[dm] storage locked: offline queue not persisted");
    rec(ev("storage.locked", { d: { what: "dm-queue" } }));
    return;
  }
  try {
    const session = requireSession();
    const sealed = await sealRow({ q: queue }, DM_QUEUE_SPEC);
    if (requireSession() !== session) return;
    localStorage.setItem(
      DM_QUEUE_KEY,
      JSON.stringify({
        iv: bytesToBase64(sealed._enc.iv),
        ct: bytesToBase64(new Uint8Array(sealed._enc.ct)),
      })
    );
  } catch (err) {
    // Storage full or blocked: the message still sent or sits in memory;
    // a quota error must not blow up out of sendDirectMessage.
    rec(ev("storage.quota", { d: { err: errText(err) } }));
  }
}

// Every read-modify-write of the queue runs through this chain, one at a time.
// Sealing the queue made load and save asynchronous, and ChatView calls
// sendMessage() without awaiting it, so two quick sends to an offline peer both
// loaded the same snapshot and both wrote snapshot+1: the first message was
// dropped without a trace, never retried, its status stuck on "sending"
// forever. Holding the chain across the load AND the save is what makes each
// mutation see the previous one's write.
let _queueChain: Promise<void> = Promise.resolve();

export function mutateDmQueue(
  mutate: (queue: QueuedMessage[]) => QueuedMessage[]
): Promise<void> {
  const session = requireSession();
  const run = _queueChain.then(async () => {
    const apply = async () => {
      if (requireSession() !== session) return;
      const queue = await loadQueuedDmMessages();
      if (requireSession() !== session) return;
      await saveQueuedDmMessages(mutate(queue));
    };
    // The chain above only serializes THIS context. The queue lives in
    // localStorage, which a second tab (or the installed PWA alongside the
    // browser) shares: both read the same blob, both write blob+1, and the
    // loser's message is gone with no trace and no retry. Best effort - a
    // browser without the Lock Manager still gets the in-context chain.
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request("awful:dm-queue", apply);
      return;
    }
    await apply();
  });
  // One failed mutation must not wedge the chain for every later one.
  _queueChain = run.catch(() => {});
  return run;
}

/** The queue exactly as stored, for a device sync or a backup to carry. */
export function readDmQueueBlob(): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    return localStorage.getItem(DM_QUEUE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Both queues, each entry once, oldest first, bounded like the queue itself. */
export function mergeDmQueues(
  local: QueuedMessage[],
  incoming: QueuedMessage[]
): QueuedMessage[] {
  const byKey = new Map<string, QueuedMessage>();
  for (const entry of [...local, ...incoming]) {
    const key = queueEntryKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()]
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .slice(-DM_QUEUE_MAX);
}

/**
 * Take in another device's queue, as `readDmQueueBlob` gave it there.
 *
 * The blob is sealed under the account's at-rest key, which every device of
 * one account derives the same way (from the identity's private key), so a
 * replace stores it as it came and it opens once this device unlocks as that
 * account. A merge opens it with the key armed here and folds it into the
 * local queue entry by entry; one that does not open here (another
 * account's, from a file) is left out. A replace with no queue to bring
 * clears this device's: those messages' rows went with the wipe.
 */
export async function importDmQueueBlob(
  blob: string | undefined,
  mode: "add" | "replace"
): Promise<void> {
  if (typeof localStorage === "undefined") return;
  if (mode === "replace") {
    try {
      if (blob) localStorage.setItem(DM_QUEUE_KEY, blob);
      else localStorage.removeItem(DM_QUEUE_KEY);
    } catch {
      // Blocked storage: nothing to carry the queue in.
    }
    return;
  }
  if (!blob) return;
  let incoming: QueuedMessage[] | null;
  try {
    const parsed = JSON.parse(blob);
    incoming = Array.isArray(parsed)
      ? validQueueEntries(parsed)
      : await openSealedQueue(parsed as { iv?: unknown; ct?: unknown });
  } catch {
    incoming = null;
  }
  if (!incoming) {
    console.warn("[dm] the imported retry queue does not open under this account - left out");
    return;
  }
  if (incoming.length === 0) return;
  const arrived = incoming;
  await mutateDmQueue((queue) => mergeDmQueues(queue, arrived));
}
