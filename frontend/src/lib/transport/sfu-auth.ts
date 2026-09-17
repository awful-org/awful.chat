import { ed25519 } from "@noble/curves/ed25519.js";

export function signSfuJoin(seed: Uint8Array, nonce: string, roomCode: string, peerId: string): string {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Invalid video server challenge");
  const payload = JSON.stringify(["awful:sfu:join:v1", nonce, roomCode, peerId]);
  const signature = ed25519.sign(new TextEncoder().encode(payload), seed);
  return btoa(String.fromCharCode(...signature));
}
