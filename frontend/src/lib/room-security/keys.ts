/** V2 primitives. Never pass a RoomSecret to a network routing API. */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad as base64url } from "@scure/base";

declare const secretBrand: unique symbol;
declare const discoveryBrand: unique symbol;
export type RoomSecret = string & { readonly [secretBrand]: true };
export type DiscoveryId = string & { readonly [discoveryBrand]: true };
const encoder = new TextEncoder();
const salt = encoder.encode("awful/room/v2");

export function newRoomSecret(): RoomSecret {
  return `r2_${base64url.encode(crypto.getRandomValues(new Uint8Array(32)))}` as RoomSecret;
}

export function parseRoomSecret(input: string): RoomSecret {
  if (!/^r2_[A-Za-z0-9_-]{43}$/.test(input)) throw new Error("Invalid v2 invitation");
  const bytes = base64url.decode(input.slice(3));
  if (bytes.length !== 32 || base64url.encode(bytes) !== input.slice(3)) {
    throw new Error("Invalid v2 invitation");
  }
  return input as RoomSecret;
}

export function deriveRoomKeys(secret: RoomSecret) {
  parseRoomSecret(secret);
  const root = base64url.decode(secret.slice(3));
  const derive = (purpose: string) => hkdf(sha256, root, salt, encoder.encode(purpose), 32);
  const result = {
    discoveryId: `rd2_${base64url.encode(derive("discovery"))}` as DiscoveryId,
    membershipKey: derive("membership"),
    encryptionKey: derive("encryption"),
    sfuSigningSeed: derive("sfu-signing"),
  };
  root.fill(0);
  return result;
}

export type RoomKeys = ReturnType<typeof deriveRoomKeys>;

/** Validate at the persistence boundary too: imports must not attach a
 * capability to an unrelated public room identifier. */
export function validateStoredCapability(room: { roomCode: string; roomSecret?: string }): void {
  if (!room.roomCode.startsWith("rd2_") && room.roomSecret === undefined) return;
  if (!room.roomSecret || deriveRoomKeys(parseRoomSecret(room.roomSecret)).discoveryId !== room.roomCode) {
    throw new Error("Room capability is missing or does not match its identifier");
  }
}
