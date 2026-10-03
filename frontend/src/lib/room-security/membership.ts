/** Proofs must travel on an identity-authenticated channel (e.g. Noise).
 * Both challenges MUST be fresh for that connection; the caller supplies
 * transport-authenticated identities, never identities claimed by a message.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad as base64url } from "@scure/base";
import type { DiscoveryId, RoomKeys } from "./keys";

export type MembershipTranscript = {
  room: DiscoveryId;
  initiator: string;
  responder: string;
  initiatorChallenge: string;
  responderChallenge: string;
};

export function newMembershipChallenge(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

function transcriptBytes(t: MembershipTranscript, role: "initiator" | "responder") {
  if (!t.initiator || !t.responder || t.initiator === t.responder ||
      t.initiator.length > 256 || t.responder.length > 256) {
    throw new Error("Invalid membership identities");
  }
  for (const challenge of [t.initiatorChallenge, t.responderChallenge]) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        base64url.encode(base64url.decode(challenge)) !== challenge) {
      throw new Error("Invalid membership challenge");
    }
  }
  return new TextEncoder().encode(JSON.stringify([
    "awful/room-membership/v2", t.room, t.initiator, t.responder,
    t.initiatorChallenge, t.responderChallenge, role,
  ]));
}

export function createMembershipProof(
  keys: RoomKeys, transcript: MembershipTranscript, role: "initiator" | "responder",
): string {
  if (transcript.room !== keys.discoveryId) throw new Error("Wrong membership room");
  return base64url.encode(hmac(sha256, keys.membershipKey, transcriptBytes(transcript, role)));
}

export function verifyMembershipProof(
  keys: RoomKeys, transcript: MembershipTranscript, role: "initiator" | "responder", proof: string,
): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
    const expected = createMembershipProof(keys, transcript, role);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
