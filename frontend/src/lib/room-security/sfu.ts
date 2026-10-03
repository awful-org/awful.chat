import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlnopad } from "@scure/base";
import type { RoomKeys } from "./keys";

/** Public verifier doubles as an opaque SFU routing ID; possession of the
 * public value is insufficient to answer a fresh room-admission challenge. */
export function roomSfuAdmission(keys: RoomKeys, nonce: string, peer: string) {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Invalid SFU challenge");
  const roomCode = `rs2_${base64urlnopad.encode(ed25519.getPublicKey(keys.sfuSigningSeed))}`;
  const payload = new TextEncoder().encode(JSON.stringify(["awful:sfu:room:v2", nonce, roomCode, peer]));
  const capability = base64urlnopad.encode(ed25519.sign(payload, keys.sfuSigningSeed));
  return { roomCode, capability };
}
