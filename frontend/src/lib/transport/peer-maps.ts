// Updates to the per-peer maps on transportState (names, avatars, colors,
// profile meta), lifted out of transport.svelte.ts so they can be tested:
// that module builds a libp2p node at import time.
//
// Each map is replaced, never mutated, so that whatever reads it re-runs. A
// profile frame arrives from every peer on every connect and every room
// switch, and nearly always repeats what is already known; replacing the
// maps anyway re-ran every name, avatar, color and tag on screen - in the
// open conversation, the user list, the mention candidates - for nothing.

/**
 * `map` with `key` set to `value`, or removed when `value` is undefined - as
 * a new Map, or `map` itself when that would change nothing.
 */
export function withEntry<V>(
  map: Map<string, V>,
  key: string,
  value: V | undefined,
  same: (a: V, b: V) => boolean = Object.is
): Map<string, V> {
  if (value === undefined) {
    if (!map.has(key)) return map;
    const next = new Map(map);
    next.delete(key);
    return next;
  }
  if (map.has(key) && same(map.get(key) as V, value)) return map;
  const next = new Map(map);
  next.set(key, value);
  return next;
}

/** Whether two flat records hold the same fields with the same values. */
export function sameFields(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}
