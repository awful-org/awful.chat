import { createPublicKey, randomBytes, verify } from "node:crypto";
import bs58 from "bs58";

export const JOIN_TIMEOUT_MS = 10_000;
export const newJoinNonce = (): string => randomBytes(32).toString("hex");

/** Version/domain separation plus a server-issued, single-socket challenge. */
export function joinPayload(nonce: string, roomCode: string, peerId: string): string {
  return JSON.stringify(["awful:sfu:join:v1", nonce, roomCode, peerId]);
}

export function verifyJoin(nonce: string, roomCode: string, peerId: string, signature: unknown): boolean {
  try {
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    // The application uses Ed25519 identity-multihash peer IDs: 00 24 followed
    // by the canonical protobuf PublicKey (08 01 12 20 + 32 raw bytes).
    const bytes = Buffer.from(bs58.decode(peerId));
    if (bytes.length !== 38 || !bytes.subarray(0, 6).equals(Buffer.from([0, 36, 8, 1, 18, 32]))) return false;
    const key = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: bytes.subarray(6).toString("base64url") },
    });
    return verify(null, Buffer.from(joinPayload(nonce, roomCode, peerId)), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The authenticated peer also proves room access. Never accept root secrets or
 * discovery IDs as an alternative legacy SFU room identifier. */
export function verifyRoomAdmission(nonce: string, room: string, peer: string, capability: unknown): boolean {
  if (!room.startsWith("rs2_")) return false;
  try {
    if (!/^rs2_[A-Za-z0-9_-]{43}$/.test(room) || typeof capability !== "string" ||
        !/^[A-Za-z0-9_-]{86}$/.test(capability) || !/^[0-9a-f]{64}$/.test(nonce)) return false;
    const publicBytes = Buffer.from(room.slice(4), "base64url");
    const signature = Buffer.from(capability, "base64url");
    if (publicBytes.toString("base64url") !== room.slice(4) || signature.toString("base64url") !== capability) return false;
    const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: room.slice(4) } });
    return verify(null, Buffer.from(JSON.stringify(["awful:sfu:room:v2", nonce, room, peer])), key, signature);
  } catch { return false; }
}
