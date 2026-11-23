/** Who is showing the search overlay, and over what. One owner, like the
 *  palette's open flag: the overlay reads it, hotkeys write it. */
export const searchUi = $state({
  open: false,
  /** Room to search, or null for everywhere. */
  scope: null as string | null,
  /**
   * With a room scope: one of its channels (channels.ts), "" for the
   * original chat, or null for the whole room. Hand it to searchRooms.
   */
  scopeChannel: null as string | null,
});

export function openSearch(scope: string | null, channel: string | null = null): void {
  searchUi.scope = scope;
  searchUi.scopeChannel = scope === null ? null : channel;
  searchUi.open = true;
}

export function closeSearch(): void {
  searchUi.open = false;
}
