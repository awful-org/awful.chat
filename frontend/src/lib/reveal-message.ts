import { getMessage } from "$lib/storage";
import {
  loadMoreMessages,
  transportState,
} from "$lib/transport/transport.svelte";
import { requestJumpToMessage } from "$lib/ui-state.svelte";

/** At most this many pages are read back to reach a message. */
const MAX_PAGES = 40;

let _inFlight = 0;

/** A reveal is filling in older history: ChatView keeps the rows it holds
 *  until the jump has landed, rather than trimming what was just read. */
export function revealInFlight(): boolean {
  return _inFlight > 0;
}

/**
 * Scroll the open conversation to a message and flash it, paging history back
 * first when it is older than what is loaded. The message's lamport bounds
 * the walk: once the oldest loaded row is at or past it, the message is
 * either present or not coming. The caller has already opened `roomCode`.
 *
 * The pages between the view and the message are read in one go and put in
 * the view in one update, and ChatView mounts a window around the message -
 * not, as it did, everything read on the way to it.
 */
export async function revealMessage(
  roomCode: string,
  id: string,
  lamport: number
): Promise<void> {
  _inFlight += 1;
  try {
    if (transportState.roomCode !== roomCode) return;
    const oldest = transportState.messages[0];
    if (
      oldest &&
      !transportState.messages.some((m) => m.id === id) &&
      (oldest.lamport > lamport || (oldest.lamport === lamport && oldest.id > id))
    ) {
      await loadMoreMessages(oldest, { to: { lamport, id }, pages: MAX_PAGES });
      if (transportState.roomCode !== roomCode) return;
    }
    requestJumpToMessage(roomCode, id, true);
  } finally {
    _inFlight -= 1;
  }
}

/**
 * Reveal a message the open conversation does not hold, found by id alone:
 * a quote, or a plugin card's way back to itself. ChatView lets go of rows
 * far back, and either can be older than the first page. Only one of this
 * conversation's: a quote or a plugin names any id it likes.
 */
export async function revealStored(roomCode: string, id: string): Promise<void> {
  _inFlight += 1;
  try {
    const stored = await getMessage(id).catch(() => undefined);
    if (!stored || stored.roomCode !== roomCode) return;
    await revealMessage(roomCode, stored.id, stored.lamport);
  } finally {
    _inFlight -= 1;
  }
}
