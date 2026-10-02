/**
 * Flood caps for plugin traffic coming IN: so many messages per sender per
 * window, the rest dropped. The transport checks every plugin row and
 * ephemeral against these before it stores, folds or renders anything.
 */

/** Ephemerals: about four a second per plugin per sender - a cursor tick. */
export const EPHEMERAL_FLOOD_LIMIT = 4;
export const EPHEMERAL_FLOOD_WINDOW = 1000; // milliseconds
/**
 * Persisted updates: 20 per 10 s per room per sender. A human clicking as
 * fast as they can stays well inside it; a flooder does not.
 */
export const UPDATE_FLOOD_LIMIT = 20;
export const UPDATE_FLOOD_WINDOW = 10_000; // milliseconds
/**
 * Cards: 10 a minute per room per sender. A person posts one with a slash
 * command; each is stored for good and rendered for everyone in the room.
 */
export const CARD_FLOOD_LIMIT = 10;
export const CARD_FLOOD_WINDOW = 60_000; // milliseconds
/** Above this many live windows, the expired ones are swept. */
const FLOOD_MAX_KEYS = 256;

/**
 * A fixed-window cap by key. With a message id, a message counts once: a
 * live send arrives twice (the gossip copy and the direct batch to each
 * member), and counting both halved what an honest sender got, while a peer
 * replaying one message spent its sender's window. A copy of a message the
 * cap let through passes again - storage drops it as a duplicate - and a
 * copy of one it dropped is dropped again.
 */
export function createFloodCap(
  limit: number,
  windowMs: number,
  now: () => number = Date.now
): (key: string, id?: string) => boolean {
  const windows = new Map<string, { resetAt: number; count: number; ids: Set<string> }>();
  let sweepAt = 0;
  return (key, id) => {
    const t = now();
    // Expired windows were never removed, only overwritten if the same key
    // came back: a peer varying the key grew the map without bound for the
    // life of the tab. Throttled to once per window - unthrottled, a busy
    // room paid an O(size) walk per message to free nothing while every
    // window was still live, on the highest-rate traffic there is.
    if (windows.size > FLOOD_MAX_KEYS && t >= sweepAt) {
      sweepAt = t + windowMs;
      for (const [k, w] of windows) if (t >= w.resetAt) windows.delete(k);
    }
    let w = windows.get(key);
    if (!w || t >= w.resetAt) {
      w = { resetAt: t + windowMs, count: 0, ids: new Set() };
      windows.set(key, w);
    }
    if (id !== undefined && w.ids.has(id)) return true;
    if (w.count >= limit) return false;
    w.count += 1;
    if (id !== undefined) w.ids.add(id);
    return true;
  };
}

/**
 * The transport's three caps. Ephemerals are capped per plugin; persisted
 * updates and cards per ROOM and sender, whatever plugin they name: the
 * pluginId is what the sender wrote (only its shape is checked), so keying
 * on it gave a sender a fresh window for every made-up plugin.
 */
export function createPluginFloodCaps(now: () => number = Date.now) {
  const ephemeral = createFloodCap(EPHEMERAL_FLOOD_LIMIT, EPHEMERAL_FLOOD_WINDOW, now);
  const update = createFloodCap(UPDATE_FLOOD_LIMIT, UPDATE_FLOOD_WINDOW, now);
  const card = createFloodCap(CARD_FLOOD_LIMIT, CARD_FLOOD_WINDOW, now);
  return {
    ephemeral: (pluginId: string, senderId: string) => ephemeral(`${pluginId}|${senderId}`),
    update: (roomCode: string, senderId: string, id: string) =>
      update(`${roomCode}|${senderId}`, id),
    card: (roomCode: string, senderId: string, id: string) =>
      card(`${roomCode}|${senderId}`, id),
  };
}
