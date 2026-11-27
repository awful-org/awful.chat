/** Bounded live-only admission, AFTER signature verification. Keep this across
 * reconnects: dropping it would admit a captured update on a fresh channel.
 *
 * One replay set per room, and each author may hold only `perAuthor` of a
 * room's set: a member sending fresh ids as fast as they can must not shut
 * out the other members' live updates, and a flood stays inside the room it
 * came from. `perAuthor` leaves room for several plugin streams at the send
 * side's own rate (about 4 a second each, held 60 s). */
export class LiveUpdateAdmission {
  private rooms = new Map<string, { seen: Map<string, { author: string; expires: number }>; held: Map<string, number> }>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 8192,
    private readonly perAuthor = 2048,
  ) {}

  accept(room: string, author: string, authenticatedDid: string, id: string, timestamp: number): boolean {
    const now = this.now();
    if (!room || !author.startsWith("did:key:") || author !== authenticatedDid ||
        typeof id !== "string" || !id || id.length > 128 ||
        !Number.isSafeInteger(timestamp) || timestamp < now - 60_000 || timestamp > now + 10_000) return false;
    for (const [name, set] of this.rooms) {
      for (const [key, entry] of set.seen) {
        if (entry.expires >= now) continue;
        set.seen.delete(key);
        const left = (set.held.get(entry.author) ?? 1) - 1;
        if (left > 0) set.held.set(entry.author, left);
        else set.held.delete(entry.author);
      }
      if (set.seen.size === 0 && name !== room) this.rooms.delete(name);
    }
    let set = this.rooms.get(room);
    if (!set) {
      set = { seen: new Map(), held: new Map() };
      this.rooms.set(room, set);
    }
    const key = JSON.stringify([author, id]);
    const mine = set.held.get(author) ?? 0;
    if (set.seen.has(key) || set.seen.size >= this.capacity || mine >= this.perAuthor) return false;
    set.seen.set(key, { author, expires: timestamp + 60_000 });
    set.held.set(author, mine + 1);
    return true;
  }
}
