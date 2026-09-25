/** More than anyone watches at once; bounds what one frame can make us store. */
export const MAX_WATCHED = 16;

/**
 * The shares a WatchPresence frame says its sender is watching.
 *
 * `watchingAll` lists every one; it arrived with watching several shares at
 * once. An older sender has only `watching`, its single share - and a newer
 * one still sets that to its latest, so both kinds of client keep reading
 * each other.
 */
export function watchedFromWire(msg: {
  watching?: unknown;
  watchingAll?: unknown;
}): string[] {
  if (Array.isArray(msg.watchingAll)) {
    return msg.watchingAll
      .filter((w): w is string => typeof w === "string")
      .slice(0, MAX_WATCHED);
  }
  return typeof msg.watching === "string" ? [msg.watching] : [];
}

/** The share started most recently - the Map keeps start order. */
export function latestWatched(watching: ReadonlyMap<string, string>): string | null {
  let last: string | null = null;
  for (const peerId of watching.keys()) last = peerId;
  return last;
}
