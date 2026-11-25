import { LibP2PTransport } from "$lib/transport/libp2p/transport";
import { deriveRoomKeys, type RoomSecret } from "./keys";

type Connection = ReturnType<SecureSyncTransport["openConnections"]>[number];

/** How long each way of making a new connection may take. */
const REDIAL_MS = 4_000;

/** A dedicated pairing transport must never export secrets over raw streams.
 * The existing sync batching/ack logic can only send through this capability. */
export class SecureSyncTransport extends LibP2PTransport {
  readonly pairingRoom: ReturnType<typeof deriveRoomKeys>["discoveryId"];

  constructor(private readonly pairingSecret: RoomSecret) {
    super({ diagBus: "sync" });
    this.pairingRoom = deriveRoomKeys(pairingSecret).discoveryId;
  }

  override async connect(privateKeyBytes?: Uint8Array | null): Promise<void> {
    await super.connect(privateKeyBytes);
    super.joinSecureRoom(this.pairingSecret);
  }

  override send(peerId: string, data: Uint8Array): Promise<boolean> {
    // The link's own liveness probes and their answers (pingFrame/pongFrame
    // in libp2p/transport.ts) carry nothing, and the side that answers them
    // only reads the direct stream. Wrapped in the pairing room they arrived
    // as app messages, went unanswered, and a few missed answers later the
    // link was dropped as dead - in the middle of a sync, while one device
    // waited on its user.
    if (isLivenessFrame(data)) return super.send(peerId, data);
    return this.sendSecureRoom(peerId, this.pairingRoom, data);
  }

  /** A stream on a dead connection never opens; there are others to try. */
  protected override roomOpenTimeoutMs = 10_000;

  /**
   * The channel to a peer closed under us, with no other in its place: what
   * was on it is gone, known at once rather than from the silence.
   */
  onChannelLost: ((peerId: string) => void) | null = null;
  /** Closing one ourselves. */
  private leaving = false;

  protected override roomChannelClosed(
    ...[peerId, room]: Parameters<LibP2PTransport["roomChannelClosed"]>
  ): void {
    if (this.leaving || room !== this.pairingRoom) return;
    if (this.secureRoomConnection(peerId, room)) return;
    this.onChannelLost?.(peerId);
  }

  private leave(peerId: string): Connection[] {
    this.leaving = true;
    try {
      return this.closeSecureRoom(peerId, this.pairingRoom);
    } finally {
      this.leaving = false;
    }
  }

  /** Connections that went quiet, or never opened a channel (reopen). */
  private readonly stalled = new WeakSet<Connection>();
  /** Of each peer: the last of those, and what its last channel was opened, or tried, on. */
  private readonly lastStalled = new Map<string, Connection>();
  private readonly picked = new Map<string, Connection>();
  /** Connections made here, to be closed here. */
  private readonly made = new WeakSet<Connection>();

  /**
   * What was sent is not being answered: leave the channel it went on, and
   * the connection under it, for the next send to open another.
   *
   * Two devices are often connected twice, through the relay and directly, and
   * a room channel stays on whichever it was opened on - usually the relay's
   * circuit, which is there first. The link's own liveness probes ride the
   * other stream, so a circuit that stopped carrying anything looked like a
   * healthy peer, and the sync sat where it was with a direct connection open.
   */
  reopen(peerId: string): void {
    const left = this.leave(peerId);
    const tried = this.picked.get(peerId);
    // None: it is opening one that is not being answered either.
    for (const connection of left.length ? left : tried ? [tried] : []) {
      this.stalled.add(connection);
      this.lastStalled.set(peerId, connection);
      if (this.made.has(connection)) void connection.close().catch(() => {});
    }
  }

  /** Leave the channel only: the connections are new, or as good as any. */
  refresh(peerId: string): void {
    this.leave(peerId);
  }

  /**
   * Move to the direct connection when there is one. Only while nothing is in
   * flight: what is on the old channel goes with it.
   */
  preferDirect(peerId: string): void {
    const now = this.secureRoomConnection(peerId, this.pairingRoom);
    if (!now || now.direct || !this.usable(peerId).some((c) => c.direct)) return;
    this.leave(peerId);
  }

  private usable(peerId: string): Connection[] {
    return this.openConnections(peerId).filter((c) => !this.stalled.has(c));
  }

  /**
   * The direct connection first, and after one that went quiet, the other
   * kind: what took a direct path down takes every direct one down, and the
   * same goes for the relay.
   */
  protected override async roomConnection(
    ...[node, peerId, signal]: Parameters<LibP2PTransport["roomConnection"]>
  ): Promise<Connection> {
    const connection = await this.choose(node, peerId, signal);
    this.picked.set(peerId, connection);
    return connection;
  }

  private async choose(
    ...[node, peerId, signal]: Parameters<LibP2PTransport["roomConnection"]>
  ): Promise<Connection> {
    const direct = !this.lastStalled.get(peerId)?.direct;
    const usable = this.usable(peerId);
    const best = usable.find((c) => c.direct === direct) ?? usable[0];
    if (best) return best;
    const open = this.openConnections(peerId);
    if (!open.length) return super.roomConnection(node, peerId, signal);
    // Only ones that went quiet are left. One may have come back since, but a
    // new one is the better bet.
    for (const via of direct ? (["direct", "relay"] as const) : (["relay", "direct"] as const)) {
      try {
        const made = await this.dialAnother(
          node, peerId, via, AbortSignal.any([signal, AbortSignal.timeout(REDIAL_MS)]));
        // One that was under way already comes back instead of a new one.
        if (this.stalled.has(made)) continue;
        this.made.add(made);
        return made;
      } catch (err) {
        if (signal.aborted) throw err;
      }
    }
    return open.find((c) => c.direct === direct) ?? open[0];
  }
}

const LIVENESS_PREFIXES = ['{"type":"__ping"', '{"type":"__pong"'];

export function isLivenessFrame(data: Uint8Array): boolean {
  if (data.byteLength > 64) return false;
  const text = new TextDecoder().decode(data);
  return LIVENESS_PREFIXES.some((p) => text.startsWith(p));
}
