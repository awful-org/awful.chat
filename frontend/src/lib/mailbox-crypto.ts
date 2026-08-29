/**
 * Sealed-box crypto for the offline DM mailbox.
 *
 * Confidentiality: ephemeral-static X25519 ECDH against the recipient's
 * identity key (ed25519 converted to Montgomery form) - no prior handshake
 * needed, which matters because the whole point is that the two peers are
 * NOT online together. The relay stores only ciphertext; the ephemeral key
 * means nothing in the blob names the sender to the relay either.
 *
 * Authenticity: the sealed PLAINTEXT carries the sender's did and an
 * ed25519 signature binding the envelope to the recipient - the stream
 * path authenticates senders at the transport layer (noise + peerId-did
 * binding), and a mailbox blob has no transport, so it must carry its own.
 * The recipient check on `to` stops cross-mailbox replays; the message-id
 * dedup against storage stops same-mailbox replays.
 *
 * Sizes: plaintext pads to fixed buckets so the relay learns even less
 * from blob sizes than "some message".
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { didToPublicKey } from "./identity/identity";

const VERSION = 1;
const INFO = "awful-mailbox-v1";
const SIG_PREFIX = "awful-mailbox-msg:v1:";
/** Padded plaintext sizes. The largest stays under the relay's 16 KiB blob
 *  cap with sealing overhead - bigger content retries peer-to-peer only. */
const BUCKETS = [1024, 4096, 15 * 1024];

const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(
  shared: Uint8Array,
  ephPub: Uint8Array,
  rcptXPub: Uint8Array
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    shared as Uint8Array<ArrayBuffer>,
    "HKDF",
    false,
    ["deriveKey"]
  );
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(rcptXPub, 32);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: te.encode(INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function sigMessage(
  to: string,
  env: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    env as Uint8Array<ArrayBuffer>
  );
  return te.encode(
    SIG_PREFIX + to + ":" + b64(new Uint8Array(digest))
  ) as Uint8Array<ArrayBuffer>;
}

function pad(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const needed = 4 + data.length;
  const bucket = BUCKETS.find((b) => b >= needed);
  if (!bucket) throw new Error("too large for the mailbox");
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function unpad(data: Uint8Array): Uint8Array {
  if (data.length < 4) throw new Error("truncated");
  const len = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getUint32(0);
  if (len > data.length - 4) throw new Error("bad padding");
  return data.subarray(4, 4 + len);
}

/** Seal a DM envelope for the recipient's mailbox. Returns the blob to
 *  deposit, or null when the envelope exceeds the largest bucket. */
export async function sealDmForMailbox(args: {
  senderDid: string;
  senderPrivateKey: Uint8Array<ArrayBuffer>;
  recipientDid: string;
  envelope: Uint8Array;
}): Promise<Uint8Array | null> {
  const sig = ed25519.sign(
    await sigMessage(args.recipientDid, args.envelope),
    args.senderPrivateKey
  );
  const inner = te.encode(
    JSON.stringify({
      v: VERSION,
      from: args.senderDid,
      to: args.recipientDid,
      env: b64(args.envelope),
      sig: b64(sig),
    })
  );
  let padded: Uint8Array<ArrayBuffer>;
  try {
    padded = pad(inner);
  } catch {
    return null; // oversized: the P2P queue still retries
  }

  const rcptXPub = ed25519.utils.toMontgomery(
    didToPublicKey(args.recipientDid)
  );
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, rcptXPub);
  const key = await deriveKey(shared, eph.publicKey, rcptXPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, padded)
  );

  const blob = new Uint8Array(1 + 32 + 12 + ct.length);
  blob[0] = VERSION;
  blob.set(eph.publicKey, 1);
  blob.set(iv, 33);
  blob.set(ct, 45);
  return blob;
}

/** Open a collected blob: decrypt with our identity key, verify the sender's
 *  signature and that it was sealed for US. Throws on anything off. */
export async function openDmFromMailbox(args: {
  blob: Uint8Array;
  selfDid: string;
  selfPrivateKey: Uint8Array<ArrayBuffer>;
}): Promise<{ senderDid: string; envelope: Uint8Array }> {
  const { blob } = args;
  if (blob.length < 46 || blob[0] !== VERSION) throw new Error("bad blob");
  const ephPub = blob.subarray(1, 33);
  const iv = blob.subarray(33, 45) as Uint8Array<ArrayBuffer>;
  const ct = blob.subarray(45) as Uint8Array<ArrayBuffer>;

  const selfXPriv = ed25519.utils.toMontgomerySecret(args.selfPrivateKey);
  const selfXPub = x25519.getPublicKey(selfXPriv);
  const shared = x25519.getSharedSecret(selfXPriv, ephPub);
  const key = await deriveKey(shared, ephPub, selfXPub);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct)
  );
  const inner = JSON.parse(td.decode(unpad(padded))) as {
    v: number;
    from: string;
    to: string;
    env: string;
    sig: string;
  };
  if (inner.v !== VERSION) throw new Error("bad version");
  if (inner.to !== args.selfDid) throw new Error("not sealed for us");
  const envelope = unb64(inner.env);
  // zip215:false for the same reason messaging.ts passes it: @noble defaults
  // to the cofactored ZIP215 equation, which accepts small-order public keys,
  // and a did:key naming a torsion point then verifies any signature over any
  // content with no private key. The sender did in a mailbox blob is the only
  // thing that attributes an offline DM to somebody.
  const ok = ed25519.verify(
    unb64(inner.sig),
    await sigMessage(inner.to, envelope),
    didToPublicKey(inner.from),
    { zip215: false }
  );
  if (!ok) throw new Error("bad sender signature");
  return { senderDid: inner.from, envelope };
}

/** Mailbox id: the relay never needs the did itself. */
export async function mailboxIdForDid(did: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(did));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
