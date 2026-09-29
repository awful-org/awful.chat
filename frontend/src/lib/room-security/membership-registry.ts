import type { DiscoveryId, RoomKeys } from "./keys";
import { MembershipSession } from "./session";

/** Owner for bounded, connection-scoped authentication. Connection objects must
 * be actual authenticated transport connections, not objects from wire messages.
 * No eviction of live membership: capacity exhaustion fails closed.
 */
export class MembershipRegistry<Connection extends object> {
  private readonly connections = new Map<Connection, Map<DiscoveryId, { session: MembershipSession; deadline: number }>>();
  private count = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly capacity = 256,
    private readonly perConnection = 32,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(perConnection) || perConnection < 1) {
      throw new Error("Invalid membership limits");
    }
  }

  begin(connection: Connection, keys: RoomKeys, local: string, remote: string, role: "initiator" | "responder"): MembershipSession {
    this.expire();
    const rooms = this.connections.get(connection) ?? new Map();
    if (rooms.has(keys.discoveryId)) throw new Error("Membership session already exists");
    if (this.count >= this.capacity || rooms.size >= this.perConnection) throw new Error("Membership capacity reached");
    const session = new MembershipSession(keys, local, remote, role, this.now);
    rooms.set(keys.discoveryId, { session, deadline: this.now() + 10_000 });
    this.connections.set(connection, rooms);
    this.count++;
    return session;
  }

  verified(connection: Connection, room: DiscoveryId): boolean {
    return this.connections.get(connection)?.get(room)?.session.verified === true;
  }

  disconnect(connection: Connection): void {
    const rooms = this.connections.get(connection);
    if (!rooms) return;
    for (const { session } of rooms.values()) session.close();
    this.count -= rooms.size;
    this.connections.delete(connection);
  }

  leave(room: DiscoveryId): void {
    for (const [connection, rooms] of this.connections) {
      const entry = rooms.get(room);
      if (!entry) continue;
      entry.session.close();
      rooms.delete(room);
      this.count--;
      if (!rooms.size) this.connections.delete(connection);
    }
  }

  expire(): void {
    const now = this.now();
    for (const [connection, rooms] of this.connections) {
      for (const [room, entry] of rooms) {
        if (!entry.session.verified && now >= entry.deadline) {
          entry.session.close();
          rooms.delete(room);
          this.count--;
        }
      }
      if (!rooms.size) this.connections.delete(connection);
    }
  }

  clear(): void {
    for (const connection of this.connections.keys()) this.disconnect(connection);
  }
}
