/**
 * Settings > What's new: the last pull requests merged into main.
 *
 * The list is /whats-new.json, which the frontend container writes at start
 * (docker-entrypoint.d/41-awful-whats-new.sh) from GitHub, so the app only
 * ever reads its own origin. This module is the pure half: reading that file
 * without trusting it, and deciding what counts as new to this device.
 */

export interface ReleaseNote {
  number: number;
  title: string;
  /** ISO time the pull request was merged. */
  mergedAt: string;
  /** The pull request on GitHub; https only, or empty. */
  url: string;
  /** Its description, markdown. */
  body: string;
}

const MAX_NOTES = 10;
const MAX_TITLE = 300;
const MAX_BODY = 6000;

/**
 * The file's entries that are well formed, newest merge first. The server
 * wrote it, but from GitHub's answer: a malformed entry is dropped, a url
 * that is not https is dropped, and text is capped.
 */
export function parseWhatsNew(raw: unknown): ReleaseNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: ReleaseNote[] = [];
  // The list is keyed by number on screen: a repeat would throw there.
  const numbers = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(e.number) || (e.number as number) <= 0) continue;
    if (numbers.has(e.number as number)) continue;
    if (typeof e.title !== "string" || !e.title.trim()) continue;
    if (typeof e.mergedAt !== "string" || Number.isNaN(Date.parse(e.mergedAt))) continue;
    numbers.add(e.number as number);
    notes.push({
      number: e.number as number,
      title: e.title.trim().slice(0, MAX_TITLE),
      mergedAt: e.mergedAt,
      url: typeof e.url === "string" && /^https:\/\//i.test(e.url) ? e.url : "",
      body: typeof e.body === "string" ? e.body.slice(0, MAX_BODY) : "",
    });
  }
  return notes
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, MAX_NOTES);
}

/**
 * When the newest pull request in the list was merged, in ms; 0 for none.
 * A merge time, not a number: pull requests merge out of order, so #105
 * merged after #106 is news that a "newest number seen" would never flag.
 */
export function newestMerge(notes: ReleaseNote[]): number {
  return notes.length ? Date.parse(notes[0].mergedAt) : 0;
}

/**
 * Whether the list holds something this device has not seen. `seen` is the
 * newest merge time shown here last time, or null on a device that never
 * looked: that device starts caught up rather than with a dot for every
 * release before it arrived.
 */
export function hasUnseen(notes: ReleaseNote[], seen: number | null): boolean {
  if (seen === null) return false;
  return newestMerge(notes) > seen;
}
