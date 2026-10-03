/** Bounded live-only admission, AFTER signature verification. Keep this across
 * reconnects: dropping it would admit a captured update on a fresh channel. */
export class LiveUpdateAdmission {
  private seen = new Map<string, number>();
  constructor(private readonly now = Date.now, private readonly capacity = 8192) {}

  accept(room: string, author: string, authenticatedDid: string, id: string, timestamp: number): boolean {
    const now = this.now();
    if (!room || !author.startsWith("did:key:") || author !== authenticatedDid ||
        typeof id !== "string" || !id || id.length > 128 ||
        !Number.isSafeInteger(timestamp) || timestamp < now - 60_000 || timestamp > now + 10_000) return false;
    for (const [key, expires] of this.seen) if (expires < now) this.seen.delete(key);
    const key = JSON.stringify([room, author, id]);
    if (this.seen.has(key) || this.seen.size >= this.capacity) return false;
    this.seen.set(key, timestamp + 60_000);
    return true;
  }
}
