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
    return this.sendSecureRoom(peerId, this.pairingRoom, data);
  }
}
