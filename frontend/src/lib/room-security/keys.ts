/** V2 primitives. Never pass a RoomSecret to a network routing API. */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32nopad } from "@scure/base";

declare const secretBrand: unique symbol;
declare const discoveryBrand: unique symbol;
export type RoomSecret = string & { readonly [secretBrand]: true };
export type DiscoveryId = string & { readonly [discoveryBrand]: true };
const encoder = new TextEncoder();
const salt = encoder.encode("awful/room/v2");

/**
 * Lowercase base32 (RFC 4648 alphabet, no padding) for the values a person
 * sees: the secret in an invitation link and the room's public ID in the
 * address bar. Always lowercase, so a link reads and types the same way
 * everywhere, and survives anything that folds case - a browser lowercases
 * the "host" of a web+awfl: link, which base64url could not survive.
 *
 * Wire-only values (challenges, envelopes, session IDs, the SFU's room ID)
 * stay base64url: nobody reads them.
 */
export const b32 = {
  encode: (bytes: Uint8Array): string => base32nopad.encode(bytes).toLowerCase(),
  decode: (text: string): Uint8Array => base32nopad.decode(text.toUpperCase()),
};

/** A public room ID as it appears in a URL: rd2_ and 32 bytes of base32. */
export const DISCOVERY_ID_RE = /^rd2_[a-z2-7]{52}$/;

export function newRoomSecret(): RoomSecret {
  return `r2_${b32.encode(crypto.getRandomValues(new Uint8Array(32)))}` as RoomSecret;
}

/**
 * Accepts any case - a link retyped, or capitalised by a phone keyboard -
 * and returns the lowercase form. Whitespace is still refused: callers trim
 * what a person pasted, and a secret stored or sent must be canonical.
 */
export function parseRoomSecret(input: string): RoomSecret {
  const value = typeof input === "string" ? input.toLowerCase() : "";
  if (!/^r2_[a-z2-7]{52}$/.test(value)) throw new Error("Invalid v2 invitation");
  const bytes = b32.decode(value.slice(3));
  if (bytes.length !== 32 || b32.encode(bytes) !== value.slice(3)) {
    throw new Error("Invalid v2 invitation");
  }
  return value as RoomSecret;
}

export function deriveRoomKeys(secret: RoomSecret) {
  const canonical = parseRoomSecret(secret);
  const root = b32.decode(canonical.slice(3));
  const derive = (purpose: string) => hkdf(sha256, root, salt, encoder.encode(purpose), 32);
  const result = {
    discoveryId: `rd2_${b32.encode(derive("discovery"))}` as DiscoveryId,
    membershipKey: derive("membership"),
    encryptionKey: derive("encryption"),
    sfuSigningSeed: derive("sfu-signing"),
  };
  root.fill(0);
  return result;
}

export type RoomKeys = ReturnType<typeof deriveRoomKeys>;

/** Only the public ID, for callers that need nothing else: the keys derived
 * alongside it are wiped rather than left for the collector. */
export function discoveryIdOf(secret: RoomSecret): DiscoveryId {
  const keys = deriveRoomKeys(secret);
  keys.membershipKey.fill(0); keys.encryptionKey.fill(0); keys.sfuSigningSeed.fill(0);
  return keys.discoveryId;
}

/** Validate at the persistence boundary too: imports must not attach a
 * capability to an unrelated public room identifier. */
export function validateStoredCapability(room: { roomCode: string; roomSecret?: string }): void {
  if (!room.roomCode.startsWith("rd2_") && room.roomSecret === undefined) return;
  if (!room.roomSecret || deriveRoomKeys(parseRoomSecret(room.roomSecret)).discoveryId !== room.roomCode) {
    throw new Error("Room capability is missing or does not match its identifier");
  }
}
