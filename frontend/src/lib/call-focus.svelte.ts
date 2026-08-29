/**
 * Pin state for the call stage and floating panel.
 *
 * This module is a leaf: it takes tile state in as arguments rather than
 * importing it, so it can be tested without bootstrapping the transport.
 *
 * The stage's "auto focus" behavior (clearing a vanished focus) lives here,
 * not in the component, so it survives navigation out of the call room. When
 * the user returns to the call, the same tile is still pinned.
 */

/**
 * The tile the user has pinned to keep it focused. Null when nothing is pinned.
 * This replaces `focusedTileId` in VoiceVideoCallView.svelte.
 */
export const callFocus = $state({ pinnedTileId: null as string | null });

/**
 * Call this effect to clear the pin if the pinned tile disappears.
 *
 * The stage passes it the current list of all tiles; if the pinned tile id
 * is not in that list, the pin is cleared.
 *
 * Wave 2 will call this in a $effect in the stage component.
 */
export function autofocusEffect(tileIds: string[]): void {
  if (callFocus.pinnedTileId && !tileIds.includes(callFocus.pinnedTileId)) {
    callFocus.pinnedTileId = null;
  }
}
