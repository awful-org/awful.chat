/**
 * Bumped whenever a favorite GIF is saved or removed, so every message on
 * screen re-checks its bookmark: the same GIF can be in many messages, and
 * the picker saves and removes them too.
 */
export const savedGifs = $state({ version: 0 });

export function savedGifsChanged(): void {
  savedGifs.version++;
}
