import { LibP2PTransport } from "$lib/transport/libp2p/transport";
import { deriveRoomKeys, type RoomSecret } from "./keys";

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
}

const LIVENESS_PREFIXES = ['{"type":"__ping"', '{"type":"__pong"'];

export function isLivenessFrame(data: Uint8Array): boolean {
  if (data.byteLength > 64) return false;
  const text = new TextDecoder().decode(data);
  return LIVENESS_PREFIXES.some((p) => text.startsWith(p));
}
