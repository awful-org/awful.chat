/**
 * Last time's row object, when nothing in it changed.
 *
 * A keyed {#each} updates a row whenever its item is a different object,
 * equal or not, and a list rebuilt from its sources makes every item a new
 * one - so every row repainted, avatar redrawn and all, whatever it was that
 * changed. Handing back the previous object for a row whose fields are all
 * the same leaves those rows alone. Shallow on purpose: it is meant for flat
 * rows of strings, numbers and booleans.
 */
export function keepUnchanged<T extends object>(
  previous: T | undefined,
  next: T
): T {
  if (previous === undefined) return next;
  const keys = Object.keys(next) as (keyof T)[];
  if (keys.length !== Object.keys(previous).length) return next;
  for (const key of keys) {
    if (previous[key] !== next[key]) return next;
  }
  return previous;
}
