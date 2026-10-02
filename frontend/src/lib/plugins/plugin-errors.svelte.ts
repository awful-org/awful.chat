/**
 * "Only you can see this": why a plugin did not do what was asked, shown in
 * the chat of the person who asked and nowhere else. Never sent, never
 * stored - it dies with the session, like local cards.
 *
 * A command that throws lands here, and `host.showError` puts one here
 * directly: a /ping with nobody to ping, a watch party without a link. A
 * command that only logged its complaint looked, to the person typing it,
 * like nothing happened at all.
 */

export interface PluginErrorEntry {
  id: string;
  pluginId: string;
  roomCode: string;
  message: string;
  at: number;
}

/** A sentence or two, not a stack trace. */
export const MAX_ERROR_LENGTH = 300;
/**
 * How long a note stays before it goes by itself (PluginErrorRow's bar,
 * held while the cursor is on it). Long enough to read two lines and the
 * usage they quote.
 */
export const ERROR_LINGER_MS = 8_000;
/** Per room: older ones go first. */
export const MAX_ERRORS_PER_ROOM = 3;

export const pluginErrors = $state({ entries: [] as PluginErrorEntry[] });

let nextId = 0;

export function cleanErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const clean = message.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length > MAX_ERROR_LENGTH ? chars.slice(0, MAX_ERROR_LENGTH - 1).join("") + "…" : clean;
}

export function showPluginError(pluginId: string, roomCode: string, message: unknown): void {
  const clean = cleanErrorMessage(message);
  if (!clean || !roomCode) return;
  // The same complaint again moves to the bottom instead of stacking.
  const others = pluginErrors.entries.filter(
    (e) => !(e.pluginId === pluginId && e.roomCode === roomCode && e.message === clean),
  );
  const entry: PluginErrorEntry = { id: `plugin-error-${Date.now()}-${nextId++}`, pluginId, roomCode, message: clean, at: Date.now() };
  const inRoom = others.filter((e) => e.roomCode === roomCode);
  const drop = new Set(inRoom.slice(0, Math.max(0, inRoom.length - (MAX_ERRORS_PER_ROOM - 1))).map((e) => e.id));
  pluginErrors.entries = [...others.filter((e) => !drop.has(e.id)), entry];
}

export function dismissPluginError(id: string): void {
  pluginErrors.entries = pluginErrors.entries.filter((e) => e.id !== id);
}

export function clearPluginErrors(): void {
  pluginErrors.entries = [];
}
