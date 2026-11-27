/** Bounded live-only admission, AFTER signature verification. Keep this across
 * reconnects: dropping it would admit a captured update on a fresh channel.
 *
 * The replay set is shared, so each author may hold only `perAuthor` of it:
 * one member sending fresh ids as fast as they can must not fill the set and
 * shut out every other member's live updates in every room. */
export class LiveUpdateAdmission {
  private seen = new Map<string, { author: string; expires: number }>();
  private held = new Map<string, number>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 8192,
    private readonly perAuthor = 512,
  ) {}

  accept(room: string, author: string, authenticatedDid: string, id: string, timestamp: number): boolean {
    const now = this.now();
    if (!room || !author.startsWith("did:key:") || author !== authenticatedDid ||
        typeof id !== "string" || !id || id.length > 128 ||
        !Number.isSafeInteger(timestamp) || timestamp < now - 60_000 || timestamp > now + 10_000) return false;
    for (const [key, entry] of this.seen) {
      if (entry.expires >= now) continue;
      this.seen.delete(key);
      const left = (this.held.get(entry.author) ?? 1) - 1;
      if (left > 0) this.held.set(entry.author, left);
      else this.held.delete(entry.author);
    }
    const key = JSON.stringify([room, author, id]);
    const mine = this.held.get(author) ?? 0;
    if (this.seen.has(key) || this.seen.size >= this.capacity || mine >= this.perAuthor) return false;
    this.seen.set(key, { author, expires: timestamp + 60_000 });
    this.held.set(author, mine + 1);
    return true;
  }
}
