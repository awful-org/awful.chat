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
  /** When it was shown: the countdown only runs on screen, so a note for a
   *  room not in view would otherwise wait there indefinitely. */
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
/**
 * A note older than this is never shown. It belongs to something just done:
 * opening its room twenty minutes later and being told about it is noise.
 */
export const ERROR_MAX_AGE_MS = 60_000;
/** Per room: older ones go first. */
export const MAX_ERRORS_PER_ROOM = 3;

export const pluginErrors = $state({ entries: [] as PluginErrorEntry[] });

let nextId = 0;

export function cleanErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  // Controls and invisible formatting go (bidi overrides, zero-width
  // spaces), but not the joiners: those hold emoji sequences and some
  // scripts together.
  const clean = message.replace(/(?![\u200C\u200D])[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length > MAX_ERROR_LENGTH ? chars.slice(0, MAX_ERROR_LENGTH - 1).join("") + "…" : clean;
}

export function showPluginError(pluginId: string, roomCode: string, message: unknown): void {
  const clean = cleanErrorMessage(message);
  if (!clean || !roomCode) return;
  // The same complaint again moves to the bottom instead of stacking.
  const now = Date.now();
  const others = pluginErrors.entries.filter(
    (e) =>
      now - e.at < ERROR_MAX_AGE_MS &&
      !(e.pluginId === pluginId && e.roomCode === roomCode && e.message === clean),
  );
  const entry: PluginErrorEntry = { id: `plugin-error-${nextId++}`, pluginId, roomCode, message: clean, at: now };
  const inRoom = others.filter((e) => e.roomCode === roomCode);
  const drop = new Set(inRoom.slice(0, Math.max(0, inRoom.length - (MAX_ERRORS_PER_ROOM - 1))).map((e) => e.id));
  pluginErrors.entries = [...others.filter((e) => !drop.has(e.id)), entry];
}

/** The notes worth showing in a room now: its own, and still fresh. */
export function freshErrorsFor(roomCode: string, now = Date.now()): PluginErrorEntry[] {
  return pluginErrors.entries.filter((e) => e.roomCode === roomCode && now - e.at < ERROR_MAX_AGE_MS);
}

/** Several at once, by id. */
export function dismissPluginErrors(ids: string[]): void {
  if (!ids.length) return;
  const drop = new Set(ids);
  pluginErrors.entries = pluginErrors.entries.filter((e) => !drop.has(e.id));
}

export function dismissPluginError(id: string): void {
  pluginErrors.entries = pluginErrors.entries.filter((e) => e.id !== id);
}

/** Every note this plugin left in this room. */
export function dismissPluginErrorsFor(pluginId: string, roomCode: string): void {
  pluginErrors.entries = pluginErrors.entries.filter((e) => !(e.pluginId === pluginId && e.roomCode === roomCode));
}

export function clearPluginErrors(): void {
  pluginErrors.entries = [];
}
