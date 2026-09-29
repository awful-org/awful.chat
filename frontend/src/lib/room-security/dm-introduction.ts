import { base64urlnopad as b64 } from "@scure/base";
import { openDmFromMailbox, sealDmForMailbox } from "$lib/mailbox-crypto";
import { didToPublicKey, type UnlockedSession } from "$lib/identity/identity";
import { pairwiseRoomSecret } from "./pairwise";

const DOMAIN = "awful/dm-introduction/v2";
const TIMEOUT = 10_000;
const MAX_BLOB = 16_384;

function transcript(challenge: string, senderPeer: string, recipientPeer: string): Uint8Array {
  if (b64.decode(challenge).length !== 32 || b64.encode(b64.decode(challenge)) !== challenge) {
    throw new Error("Invalid introduction challenge");
  }
  if (!senderPeer || !recipientPeer || senderPeer === recipientPeer ||
      senderPeer.length > 128 || recipientPeer.length > 128) {
    throw new Error("Invalid introduction peers");
  }
  return new TextEncoder().encode(JSON.stringify([DOMAIN, challenge, senderPeer, recipientPeer]));
}

/** Identity signatures bind a device's current Noise peer to its user identity.
 * The sealed payload contains no room secret and is addressed to one identity.
 * These blobs belong to the introduction protocol, not the mailbox collector.
 */
export async function sealDmIntroduction(args: {
  identity: UnlockedSession;
  recipientDid: string;
  senderPeer: string;
  recipientPeer: string;
  challenge: string;
}): Promise<Uint8Array> {
  const blob = await sealDmForMailbox({
    senderDid: args.identity.did,
    senderPrivateKey: args.identity.privateKey,
    recipientDid: args.recipientDid,
    envelope: transcript(args.challenge, args.senderPeer, args.recipientPeer),
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

  async accept(blob: Uint8Array, identity: UnlockedSession) {
    if (this.consumed || this.now() >= this.deadline) throw new Error("Introduction ended");
    this.consumed = true;
    if (blob.length > MAX_BLOB) throw new Error("Introduction too large");
    const opened = await openDmFromMailbox({
      blob, selfDid: identity.did, selfPrivateKey: identity.privateKey,
    });
    const expected = transcript(this.challenge, this.senderPeer, this.recipientPeer);
    if (this.cancelled || this.now() >= this.deadline || opened.kind !== "chat" ||
        opened.envelope.length !== expected.length ||
        !expected.every((byte, i) => opened.envelope[i] === byte)) {
      throw new Error("Introduction binding mismatch");
    }
    return {
      senderDid: opened.senderDid,
      secret: pairwiseRoomSecret(identity.privateKey, didToPublicKey(opened.senderDid)),
    };
  }
}
