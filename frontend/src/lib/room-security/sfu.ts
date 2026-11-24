import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import type { RoomKeys } from "./keys";
import { DEFAULT_VOICE_CHANNEL, isVoiceChannel } from "$lib/transport/voice-channel";

const encoder = new TextEncoder();

/**
 * The signing seed of one voice channel's SFU room.
 *
 * The default channel keeps the room's own seed, so its SFU room id is the
 * one it always was and old clients meet new ones there. Every other channel
 * gets a seed of its own, derived from the room's with the channel id bound
 * into the purpose: a distinct, stable rs2_ id per channel that only a member
 * holding the room's keys can compute or answer a challenge for, and that
 * says nothing to the SFU about which room it belongs to. The SFU verifies
 * these exactly as it verifies the default one - it never sees a channel.
 *
 * The caller wipes a derived seed once it has signed; the default one is the
 * room's and is not ours to wipe.
 */
function voiceChannelSeed(keys: RoomKeys, voiceChannel: string): Uint8Array {
  if (!isVoiceChannel(voiceChannel)) throw new Error("Invalid voice channel");
  if (voiceChannel === DEFAULT_VOICE_CHANNEL) return keys.sfuSigningSeed;
  return hkdf(sha256, keys.sfuSigningSeed, undefined, encoder.encode(`awful/sfu/voice-channel/v1/${voiceChannel}`), 32);
}

/** Public verifier doubles as an opaque SFU routing ID; possession of the
 * public value is insufficient to answer a fresh room-admission challenge. */
export function roomSfuAdmission(keys: RoomKeys, nonce: string, peer: string, voiceChannel: string = DEFAULT_VOICE_CHANNEL) {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Invalid SFU challenge");
  const seed = voiceChannelSeed(keys, voiceChannel);
  try {
    const roomCode = `rs2_${base64urlnopad.encode(ed25519.getPublicKey(seed))}`;
    const payload = encoder.encode(JSON.stringify(["awful:sfu:room:v2", nonce, roomCode, peer]));
    const capability = base64urlnopad.encode(ed25519.sign(payload, seed));
    return { roomCode, capability };
  } finally {
    if (seed !== keys.sfuSigningSeed) seed.fill(0);
  }
}
