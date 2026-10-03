import { base64urlnopad as b64 } from "@scure/base";
import { openDmFromMailbox, sealDmForMailbox } from "$lib/mailbox-crypto";
import { didToPublicKey, type UnlockedSession } from "$lib/identity/identity";
import { ML_KEM_768_CIPHERTEXT_BYTES } from "$lib/identity/pq-identity";
import { pairwiseRoomSecret } from "./pairwise";

const DOMAIN = "awful/dm-introduction/v2";
const TIMEOUT = 10_000;
const MAX_BLOB = 16_384;

/**
 * The post-quantum part of an introduction proof (see pq-dm.ts and
 * dm-introduction-stream.ts): the encapsulator's ML-KEM ciphertext and/or a
 * key confirmation. Its presence at all says "I speak PQ". It rides INSIDE the
 * signed transcript, so the DID's signature covers it like the rest of the
 * binding, and it is only ever sent to a device that advertised a PQ key
 * itself - an older build compares transcripts byte for byte and would refuse
 * the longer form.
 */
export interface IntroductionPq {
  ct?: string;
  confirm?: string;
}

function transcript(challenge: string, senderPeer: string, recipientPeer: string, pq?: IntroductionPq): Uint8Array {
  if (b64.decode(challenge).length !== 32 || b64.encode(b64.decode(challenge)) !== challenge) {
    throw new Error("Invalid introduction challenge");
  }
  if (!senderPeer || !recipientPeer || senderPeer === recipientPeer ||
      senderPeer.length > 128 || recipientPeer.length > 128) {
    throw new Error("Invalid introduction peers");
  }
  const fields: unknown[] = [DOMAIN, challenge, senderPeer, recipientPeer];
  if (pq) fields.push(["pq", pq.ct ?? "", pq.confirm ?? ""]);
  return new TextEncoder().encode(JSON.stringify(fields));
}

function canonicalOrEmpty(text: unknown, length: number): boolean {
  if (text === "") return true;
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return false;
  try {
    const bytes = b64.decode(text);
    return bytes.length === length && b64.encode(bytes) === text;
  } catch { return false; }
}

/** The PQ part of a received transcript, or null if it is not the exact
 * canonical form of this challenge's transcript with one. */
function pqPart(envelope: Uint8Array, challenge: string, senderPeer: string, recipientPeer: string): IntroductionPq | null {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(envelope)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 5) return null;
  const part = parsed[4];
  if (!Array.isArray(part) || part.length !== 3 || part[0] !== "pq" ||
      !canonicalOrEmpty(part[1], ML_KEM_768_CIPHERTEXT_BYTES) || !canonicalOrEmpty(part[2], 32)) return null;
  const pq: IntroductionPq = {
    ...(part[1] ? { ct: part[1] as string } : {}),
    ...(part[2] ? { confirm: part[2] as string } : {}),
  };
  // Rebuilt and compared byte for byte, like the plain form: whitespace,
  // reordering or extra fields are not the transcript this challenge expects.
  const expected = transcript(challenge, senderPeer, recipientPeer, pq);
  return envelope.length === expected.length && expected.every((byte, i) => envelope[i] === byte) ? pq : null;
}

/** Identity signatures bind a device's current Noise peer to its user identity.
 * The sealed payload contains no room secret and is addressed to one identity.
 * These blobs belong to the introduction protocol, not the mailbox collector.
 * With `recipientPqKey` (from the recipient's verified certificate) the proof
 * is sealed in the hybrid mailbox format.
 */
export async function sealDmIntroduction(args: {
  identity: UnlockedSession;
  recipientDid: string;
  senderPeer: string;
  recipientPeer: string;
  challenge: string;
  pq?: IntroductionPq;
  recipientPqKey?: Uint8Array | null;
}): Promise<Uint8Array> {
  const blob = await sealDmForMailbox({
    senderDid: args.identity.did,
    senderPrivateKey: args.identity.privateKey,
    recipientDid: args.recipientDid,
    envelope: transcript(args.challenge, args.senderPeer, args.recipientPeer, args.pq),
    recipientPqKey: args.recipientPqKey,
  });
  if (!blob) throw new Error("Introduction too large");
  return blob;
}

/** One connection-owned challenge. Discard on disconnect; never reuse across
 * connections. Consume before awaiting crypto so concurrent replies cannot both
 * succeed. A malformed reply terminates this introduction attempt.
 */
export class DmIntroductionChallenge {
  readonly challenge = b64.encode(crypto.getRandomValues(new Uint8Array(32)));
  private consumed = false;
  private cancelled = false;
  private readonly deadline: number;

  constructor(
    private readonly recipientPeer: string,
    private readonly senderPeer: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    transcript(this.challenge, senderPeer, recipientPeer);
    this.deadline = now() + TIMEOUT;
  }

  cancel(): void { this.cancelled = true; this.consumed = true; }

  /**
   * `acceptPq`: this side advertised a PQ key, so the sender may answer with
   * the PQ form. Without it only the plain form is accepted, as before.
   * `pq` in the result is present exactly when the sender used the PQ form.
   */
  async accept(blob: Uint8Array, identity: UnlockedSession, options: { acceptPq?: boolean } = {}) {
    if (this.consumed || this.now() >= this.deadline) throw new Error("Introduction ended");
    this.consumed = true;
    if (blob.length > MAX_BLOB) throw new Error("Introduction too large");
    const opened = await openDmFromMailbox({
      blob, selfDid: identity.did, selfPrivateKey: identity.privateKey,
    });
    const expected = transcript(this.challenge, this.senderPeer, this.recipientPeer);
    const plain = opened.envelope.length === expected.length &&
      expected.every((byte, i) => opened.envelope[i] === byte);
    const pq = !plain && options.acceptPq
      ? pqPart(opened.envelope, this.challenge, this.senderPeer, this.recipientPeer)
      : null;
    if (this.cancelled || this.now() >= this.deadline || opened.kind !== "chat" || (!plain && !pq)) {
      throw new Error("Introduction binding mismatch");
    }
    return {
      senderDid: opened.senderDid,
      secret: pairwiseRoomSecret(identity.privateKey, didToPublicKey(opened.senderDid)),
      ...(pq ? { pq } : {}),
    };
  }
}
