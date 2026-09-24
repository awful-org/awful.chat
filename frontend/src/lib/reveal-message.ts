import {
  loadMoreMessages,
  transportState,
} from "$lib/transport/transport.svelte";
import { requestJumpToMessage } from "$lib/ui-state.svelte";

/**
 * Scroll the open conversation to a message and flash it, paging history back
 * first when it is older than what is loaded. The message's lamport bounds
 * the walk: once the oldest loaded row is at or past it, the message is
 * either present or not coming. The caller has already opened `roomCode`.
 */
export async function revealMessage(
  roomCode: string,
  id: string,
  lamport: number
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (transportState.roomCode !== roomCode) return;
    if (transportState.messages.some((m) => m.id === id)) break;
    const oldest = transportState.messages[0];
    if (
      !oldest ||
      oldest.lamport < lamport ||
      (oldest.lamport === lamport && oldest.id <= id)
    ) {
      break;
    }
    if (!(await loadMoreMessages(oldest))) break;
  }
  requestJumpToMessage(roomCode, id);
}
