/**
 * Which channel of each room the user has open (channels.ts).
 *
 * Its own module, with nothing imported, because three layers ask it: the
 * transport sends into it and shows its page, rooms.svelte.ts files pins and
 * read marks under it, and announce.ts tells a message in it from one in
 * another channel of the same room. Each of them already imports the others
 * one way, so the answer cannot live in any of them.
 *
 * Kept for the session only, per room, so going back to a room returns to
 * the channel it was left on. A room never opened is in its original chat.
 */
import { DEFAULT_TEXT_CHANNEL } from "./channels";

const view = $state<{ current: Record<string, string>; opening: Record<string, string> }>({
  current: {},
  opening: {},
});

/** The channel open in a room; the original chat ("") when none was picked. */
export function currentChannelOf(roomCode: string | null | undefined): string {
  if (!roomCode) return DEFAULT_TEXT_CHANNEL;
  return view.current[roomCode] ?? DEFAULT_TEXT_CHANNEL;
}

/**
 * Record the channel the user is in. The transport's selectChannel is what
 * the UI calls: it also swaps the page on screen.
 */
export function setCurrentChannel(roomCode: string, channel: string): void {
  if ((view.current[roomCode] ?? DEFAULT_TEXT_CHANNEL) === channel) return;
  if (channel === DEFAULT_TEXT_CHANNEL) delete view.current[roomCode];
  else view.current[roomCode] = channel;
}

/**
 * The channel picked whose page is still being read, which the list marks as
 * the open one; null when there is none. Until then the channel on screen,
 * and the one a message goes into, is the one before it.
 */
export function openingChannelOf(roomCode: string): string | null {
  return view.opening[roomCode] ?? null;
}

export function setOpeningChannel(roomCode: string, channel: string | null): void {
  if (channel === null) delete view.opening[roomCode];
  else view.opening[roomCode] = channel;
}

/** A room left or removed, or the session ending. */
export function forgetCurrentChannel(roomCode?: string): void {
  if (roomCode === undefined) {
    view.current = {};
    view.opening = {};
  } else {
    delete view.current[roomCode];
    delete view.opening[roomCode];
  }
}
