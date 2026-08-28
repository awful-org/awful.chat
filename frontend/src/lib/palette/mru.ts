/**
 * Recency for palette commands.
 *
 * Pure recency, not frequency. VS Code's palette does the same, and it is the
 * right call: frequency makes a command you used heavily last month outrank the
 * one you used a minute ago, which reads as the palette ignoring you.
 *
 * A monotonic counter, bounded to the most recent entries. The counter is the
 * rank; the value never resets, so ordering stays total.
 *
 * Recency is applied by `rank.ts` as a sort tier inside a relevance class, never
 * as a score bonus. A recently used command must not jump above a better text
 * match, only above equally-relevant ones.
 */

/** How many commands to remember. VS Code uses the same bound. */
export const MRU_LIMIT = 50;

const STORAGE_KEY = "awful:palette-mru:v1";

interface Persisted {
  counter: number;
  entries: [string, number][];
}

export class Mru {
  #ranks = new Map<string, number>();
  #counter = 1;

  constructor(entries?: Iterable<[string, number]>, counter?: number) {
    if (entries) this.#ranks = new Map(entries);
    if (counter !== undefined) this.#counter = counter;
  }

  /** Higher means more recent. `undefined` means never used. */
  rank(id: string): number | undefined {
    return this.#ranks.get(id);
  }

  /** Ids from most to least recent. */
  recent(limit = MRU_LIMIT): string[] {
    return [...this.#ranks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  /** Record a use. Evicts the least recent entry once the bound is reached. */
  touch(id: string): void {
    this.#ranks.set(id, this.#counter++);
    if (this.#ranks.size > MRU_LIMIT) this.#evictOldest();
  }

  /** Drop one command's history, for the per-row "forget" affordance. */
  forget(id: string): boolean {
    return this.#ranks.delete(id);
  }

  get size(): number {
    return this.#ranks.size;
  }

  #evictOldest(): void {
    let oldestId: string | undefined;
    let oldestRank = Number.POSITIVE_INFINITY;
    for (const [id, rank] of this.#ranks) {
      if (rank < oldestRank) {
        oldestRank = rank;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) this.#ranks.delete(oldestId);
  }

  toJSON(): Persisted {
    return { counter: this.#counter, entries: [...this.#ranks.entries()] };
  }

  /**
   * Rebuild from persisted state, discarding anything malformed.
   *
   * This reads `localStorage`, which can hold whatever a previous version or a
   * different tab wrote, so every field is validated rather than trusted.
   */
  static fromJSON(value: unknown): Mru {
    if (typeof value !== "object" || value === null) return new Mru();
    const raw = value as Partial<Persisted>;
    if (!Array.isArray(raw.entries)) return new Mru();

    const entries: [string, number][] = [];
    for (const entry of raw.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, rank] = entry;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof rank !== "number" || !Number.isFinite(rank)) continue;
      entries.push([id, rank]);
    }

    // Keep the counter above every rank, or a restored session would hand out
    // ranks that collide with existing ones and break the ordering.
    const highest = entries.reduce((max, [, rank]) => Math.max(max, rank), 0);
    const counter =
      typeof raw.counter === "number" && Number.isFinite(raw.counter)
        ? Math.max(raw.counter, highest + 1)
        : highest + 1;

    const trimmed = entries.sort((a, b) => b[1] - a[1]).slice(0, MRU_LIMIT);
    return new Mru(trimmed, counter);
  }
}

/**
 * Read the persisted history.
 *
 * Never throws: `localStorage` is unavailable in private-mode Safari and can be
 * blocked outright, and a palette that cannot open is worse than one that
 * forgets. Matches how `display-prefs.svelte.ts` guards its own reads.
 */
export function loadMru(): Mru {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return new Mru();
    return Mru.fromJSON(JSON.parse(stored));
  } catch {
    return new Mru();
  }
}

/** Persist the history. Silently gives up when storage is unavailable. */
export function saveMru(mru: Mru): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mru.toJSON()));
  } catch {
    // Nothing useful to do. Recency is a convenience, not state we own.
  }
}
