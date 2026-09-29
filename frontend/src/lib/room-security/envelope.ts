/** Room confidentiality only. A decrypted message MUST still pass identity
 * signature verification and membership/replay admission before dispatch.
 * A fresh 256-bit salt gives each envelope a separate AES key, avoiding shared
 * group-key nonce counters across devices and tabs. Bounds precede decoding.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad as base64url } from "@scure/base";
import type { RoomKeys } from "./keys";

export const MAX_ROOM_PLAINTEXT = 1024 * 1024;
export type RoomEnvelope = {
  version: 2;
  room: string;
  sender: string;
  kind: string;
  salt: string;
  ciphertext: string;
};
const te = new TextEncoder();
const nonce = new Uint8Array(12);

function aad(e: Omit<RoomEnvelope, "ciphertext">) {
  return te.encode(JSON.stringify(["awful/room-envelope/v2", e.version, e.room, e.sender, e.kind, e.salt]));
}

async function key(keys: RoomKeys, salt: string) {
  const raw = hkdf(sha256, keys.encryptionKey, base64url.decode(salt), te.encode("awful/room-envelope/v2"), 32);
  try {
    return await crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

function validLabels(sender: unknown, kind: unknown): boolean {
  return typeof sender === "string" && sender.length > 0 && sender.length <= 256 &&
    typeof kind === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(kind);
}

export async function sealRoomEnvelope(keys: RoomKeys, sender: string, kind: string, plaintext: Uint8Array): Promise<RoomEnvelope> {
  if (!validLabels(sender, kind) || plaintext.length > MAX_ROOM_PLAINTEXT) throw new Error("Invalid room payload");
  const header = {
    version: 2 as const, room: keys.discoveryId, sender, kind,
    salt: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(header), tagLength: 128 },
    await key(keys, header.salt), new Uint8Array(plaintext),
  );
  return { ...header, ciphertext: base64url.encode(new Uint8Array(ciphertext)) };
}

export async function openRoomEnvelope(keys: RoomKeys, input: unknown): Promise<Uint8Array> {
  if (!input || typeof input !== "object") throw new Error("Invalid room envelope");
  const e = input as RoomEnvelope;
  if (e.version !== 2 || e.room !== keys.discoveryId || !validLabels(e.sender, e.kind) ||
      typeof e.salt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(e.salt) ||
      base64url.encode(base64url.decode(e.salt)) !== e.salt ||
      typeof e.ciphertext !== "string" || e.ciphertext.length > Math.ceil((MAX_ROOM_PLAINTEXT + 16) * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(e.ciphertext)) throw new Error("Invalid room envelope");
  const ciphertext = base64url.decode(e.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > MAX_ROOM_PLAINTEXT + 16 ||
      base64url.encode(ciphertext) !== e.ciphertext) throw new Error("Invalid room ciphertext");
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(e), tagLength: 128 },
    await key(keys, e.salt), new Uint8Array(ciphertext),
  ));
}
