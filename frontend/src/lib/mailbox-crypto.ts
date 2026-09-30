/**
 * Sealed-box crypto for the offline DM mailbox.
 *
 * Confidentiality: ephemeral-static key agreement against the recipient's
 * identity - no prior handshake needed, which matters because the whole point
 * is that the two peers are NOT online together. The relay stores only
 * ciphertext; the ephemeral key means nothing in the blob names the sender to
 * the relay either.
 *
 * Two formats, told apart by the first byte:
 *
 *   v1  X25519 only, against the recipient's ed25519 key in Montgomery form.
 *       What every blob was before PQ keys existed, and still what a
 *       recipient without a published PQ key (an older build) is sent.
 *   v2  Hybrid: the same X25519 agreement AND an ML-KEM-768 encapsulation to
 *       the recipient's PQ identity key (identity/pq-identity.ts). Both shared
 *       secrets feed one HKDF, so the key holds while EITHER does: a relay
 *       operator recording blobs today cannot open them with a quantum
 *       computer later, and if ML-KEM turned out to be broken a blob is
 *       still exactly as strong as v1.
 *
 * The sender picks v2 whenever it holds a verified PQ key for the recipient;
 * readers open both, forever, because v1 blobs keep arriving from older
 * builds. A reader does not refuse v1 from a peer it knows has a PQ key: the
 * format is the SENDER's choice, and a sender that has not heard the key yet
 * is not an attack. Keeping the key from a sender is an active attack, and
 * buys the attacker exactly the protection every blob had before.
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
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { didToPublicKey } from "./identity/identity";
import {
  derivePqKemKeypair,
  ML_KEM_768_CIPHERTEXT_BYTES,
  ML_KEM_768_PUBLIC_KEY_BYTES,
} from "./identity/pq-identity";

const VERSION_X25519 = 1;
const VERSION_HYBRID = 2;
/** The sealed JSON's own layout, which the outer format does not change. */
const INNER_VERSION = 1;
const INFO = "awful-mailbox-v1";
const INFO_HYBRID = "awful-mailbox-v2";
const SIG_PREFIX = "awful-mailbox-msg:v1:";

/**
 * What the sealed envelope IS.
 *
 * The mailbox originally carried one thing, a DM chat envelope, so the
 * collector could assume. It now also carries sync batches (files, plugin
 * cards, plugin updates) and delivery/read receipts, and a collector that
 * guesses from the first byte is a collector that guesses wrong. Absent on
 * blobs sealed before this existed, which were all chat.
 */
export type MailboxKind = "chat" | "batch" | "receipt";
/** Padded plaintext sizes. The largest stays under the relay's 16 KiB blob
 *  cap with sealing overhead - bigger content retries peer-to-peer only. */
const BUCKETS = [1024, 4096, 15 * 1024];
/**
 * v2 carries a 1088-byte ML-KEM ciphertext, which pushes the 15 KiB bucket
 * over the relay's cap, so its largest bucket is 1 KiB smaller. What falls in
 * between is "oversized" and goes peer to peer, as anything larger always
 * has - it is never quietly sealed as v1 instead, which would hand the one
 * large message a weaker format than the rest of the conversation.
 */
const BUCKETS_HYBRID = [1024, 4096, 14 * 1024];
/** Version byte, X25519 ephemeral key, ML-KEM ciphertext, IV. */
const HYBRID_HEADER = 1 + 32 + ML_KEM_768_CIPHERTEXT_BYTES + 12;

const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(
  shared: Uint8Array,
  ephPub: Uint8Array,
  rcptXPub: Uint8Array,
  info: Uint8Array = te.encode(INFO)
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
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: info as Uint8Array<ArrayBuffer>,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * The v2 combiner: HKDF over the X25519 and ML-KEM shared secrets
 * concatenated, salted with both X25519 public values exactly as v1 is, and
 * with the ML-KEM ciphertext and the recipient's ML-KEM key hashed into the
 * info. Binding every public input is what keeps a hybrid KDF sound whichever
 * half an attacker controls: no ciphertext or key can be swapped for another
 * that leads to the same AES key.
 */
async function deriveHybridKey(
  xShared: Uint8Array,
  kemShared: Uint8Array,
  ephPub: Uint8Array,
  rcptXPub: Uint8Array,
  kemCt: Uint8Array,
  rcptKemPub: Uint8Array
): Promise<CryptoKey> {
  const ikm = new Uint8Array(64);
  ikm.set(xShared, 0);
  ikm.set(kemShared, 32);
  const label = te.encode(INFO_HYBRID);
  const info = new Uint8Array(label.length + 64);
  info.set(label, 0);
  info.set(sha256(kemCt), label.length);
  info.set(sha256(rcptKemPub), label.length + 32);
  try {
    return await deriveKey(ikm, ephPub, rcptXPub, info);
  } finally {
    ikm.fill(0);
  }
}

/**
 * The signed statement. The kind is covered for everything but "chat", whose
 * form has to stay byte-identical to what pre-kind senders signed - so a
 * blob cannot be re-labelled from a receipt into a batch and routed to the
 * wrong handler while its signature still verifies.
 */
async function sigMessage(
  to: string,
  env: Uint8Array,
  kind: MailboxKind = "chat"
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    env as Uint8Array<ArrayBuffer>
  );
  const tag = kind === "chat" ? "" : kind + ":";
  return te.encode(
    SIG_PREFIX + to + ":" + tag + b64(new Uint8Array(digest))
  ) as Uint8Array<ArrayBuffer>;
}

function pad(
  data: Uint8Array,
  buckets: readonly number[]
): Uint8Array<ArrayBuffer> {
  const needed = 4 + data.length;
  const bucket = buckets.find((b) => b >= needed);
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

/**
 * Seal a DM envelope for the recipient's mailbox. Returns the blob to
 * deposit, or null when the envelope exceeds the largest bucket.
 *
 * `recipientPqKey` is the recipient's VERIFIED ML-KEM key (pq-peers.ts):
 * with it the blob is v2, hybrid; without it, v1. Nothing here verifies it,
 * so it must come from a certificate that did.
 */
export async function sealDmForMailbox(args: {
  senderDid: string;
  senderPrivateKey: Uint8Array<ArrayBuffer>;
  recipientDid: string;
  envelope: Uint8Array;
  kind?: MailboxKind;
  recipientPqKey?: Uint8Array | null;
}): Promise<Uint8Array | null> {
  const kind: MailboxKind = args.kind ?? "chat";
  const pqKey = args.recipientPqKey ?? null;
  if (pqKey && pqKey.length !== ML_KEM_768_PUBLIC_KEY_BYTES) {
    throw new Error("bad recipient PQ key");
  }
  const sig = ed25519.sign(
    await sigMessage(args.recipientDid, args.envelope, kind),
    args.senderPrivateKey
  );
  const inner = te.encode(
    JSON.stringify({
      v: INNER_VERSION,
      from: args.senderDid,
      to: args.recipientDid,
      env: b64(args.envelope),
      sig: b64(sig),
      // Omitted for chat: an older collector ignores unknown fields, but
      // leaving the common case byte-identical keeps the padding buckets
      // behaving exactly as they did.
      ...(kind === "chat" ? {} : { k: kind }),
    })
  );
  let padded: Uint8Array<ArrayBuffer>;
  try {
    padded = pad(inner, pqKey ? BUCKETS_HYBRID : BUCKETS);
  } catch {
    return null; // oversized: the P2P queue still retries
  }

  const rcptXPub = ed25519.utils.toMontgomery(
    didToPublicKey(args.recipientDid)
  );
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, rcptXPub);
  eph.secretKey.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  if (!pqKey) {
    let key: CryptoKey;
    try {
      key = await deriveKey(shared, eph.publicKey, rcptXPub);
    } finally {
      shared.fill(0);
    }
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, padded)
    );
    const blob = new Uint8Array(1 + 32 + 12 + ct.length);
    blob[0] = VERSION_X25519;
    blob.set(eph.publicKey, 1);
    blob.set(iv, 33);
    blob.set(ct, 45);
    return blob;
  }

  const { cipherText: kemCt, sharedSecret: kemShared } =
    ml_kem768.encapsulate(pqKey);
  let key: CryptoKey;
  try {
    key = await deriveHybridKey(
      shared,
      kemShared,
      eph.publicKey,
      rcptXPub,
      kemCt,
      pqKey
    );
  } finally {
    shared.fill(0);
    kemShared.fill(0);
  }
  const header = new Uint8Array(HYBRID_HEADER);
  header[0] = VERSION_HYBRID;
  header.set(eph.publicKey, 1);
  header.set(kemCt, 33);
  header.set(iv, 33 + ML_KEM_768_CIPHERTEXT_BYTES);
  // The header is authenticated as well as keyed: it already feeds the key,
  // and as AAD a flipped version byte or ciphertext fails in one obvious
  // place instead of depending on how the key derivation happens to react.
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header },
      key,
      padded
    )
  );
  const blob = new Uint8Array(HYBRID_HEADER + ct.length);
  blob.set(header, 0);
  blob.set(ct, HYBRID_HEADER);
  return blob;
}

/** Decrypt either format to the padded plaintext. Throws on anything off. */
async function decryptBlob(
  blob: Uint8Array,
  selfPrivateKey: Uint8Array<ArrayBuffer>
): Promise<{ padded: Uint8Array; pq: boolean }> {
  const pq = blob[0] === VERSION_HYBRID;
  // 16 bytes of GCM tag at least, on top of each format's header.
  if (pq ? blob.length < HYBRID_HEADER + 16 : blob.length < 46 || blob[0] !== VERSION_X25519) {
    throw new Error("bad blob");
  }
  const ephPub = blob.subarray(1, 33);
  const selfXPriv = ed25519.utils.toMontgomerySecret(selfPrivateKey);
  const selfXPub = x25519.getPublicKey(selfXPriv);
  const shared = x25519.getSharedSecret(selfXPriv, ephPub);
  selfXPriv.fill(0);
  try {
    if (!pq) {
      const key = await deriveKey(shared, ephPub, selfXPub);
      const padded = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.subarray(33, 45) as Uint8Array<ArrayBuffer> },
        key,
        blob.subarray(45) as Uint8Array<ArrayBuffer>
      );
      return { padded: new Uint8Array(padded), pq };
    }
    const kemCt = blob.subarray(33, 33 + ML_KEM_768_CIPHERTEXT_BYTES);
    const header = blob.subarray(0, HYBRID_HEADER) as Uint8Array<ArrayBuffer>;
    const iv = blob.subarray(HYBRID_HEADER - 12, HYBRID_HEADER) as Uint8Array<ArrayBuffer>;
    const { publicKey: selfKemPub, secretKey: selfKemPriv } =
      derivePqKemKeypair(selfPrivateKey);
    // ML-KEM never fails to decapsulate: a forged or corrupted ciphertext
    // yields an unrelated secret (implicit rejection), and it is the AES-GCM
    // tag below that refuses it.
    let kemShared: Uint8Array;
    try {
      kemShared = ml_kem768.decapsulate(kemCt, selfKemPriv);
    } finally {
      selfKemPriv.fill(0);
    }
    let key: CryptoKey;
    try {
      key = await deriveHybridKey(shared, kemShared, ephPub, selfXPub, kemCt, selfKemPub);
    } finally {
      kemShared.fill(0);
    }
    const padded = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: header },
      key,
      blob.subarray(HYBRID_HEADER) as Uint8Array<ArrayBuffer>
    );
    return { padded: new Uint8Array(padded), pq };
  } finally {
    shared.fill(0);
  }
}

/** Open a collected blob: decrypt with our identity key, verify the sender's
 *  signature and that it was sealed for US. Throws on anything off. `pq` is
 *  whether it came in the hybrid format. */
export async function openDmFromMailbox(args: {
  blob: Uint8Array;
  selfDid: string;
  selfPrivateKey: Uint8Array<ArrayBuffer>;
}): Promise<{
  senderDid: string;
  envelope: Uint8Array;
  kind: MailboxKind;
  pq: boolean;
}> {
  const { padded, pq } = await decryptBlob(args.blob, args.selfPrivateKey);
  const inner = JSON.parse(td.decode(unpad(padded))) as {
    v: number;
    from: string;
    to: string;
    env: string;
    sig: string;
    k?: string;
  };
  if (inner.v !== INNER_VERSION) throw new Error("bad version");
  if (inner.to !== args.selfDid) throw new Error("not sealed for us");
  // Absent means chat - every blob sealed before kinds existed was one.
  // Anything unrecognised is refused rather than guessed at: routing an
  // unknown shape into a handler is how a parser gets fed the wrong bytes.
  const kind: MailboxKind =
    inner.k === undefined ? "chat" : (inner.k as MailboxKind);
  if (kind !== "chat" && kind !== "batch" && kind !== "receipt") {
    throw new Error("unknown mailbox kind");
  }
  const envelope = unb64(inner.env);
  // zip215:false for the same reason messaging.ts passes it: @noble defaults
  // to the cofactored ZIP215 equation, which accepts small-order public keys,
  // and a did:key naming a torsion point then verifies any signature over any
  // content with no private key. The sender did in a mailbox blob is the only
  // thing that attributes an offline DM to somebody.
  const ok = ed25519.verify(
    unb64(inner.sig),
    await sigMessage(inner.to, envelope, kind),
    didToPublicKey(inner.from),
    { zip215: false }
  );
  if (!ok) throw new Error("bad sender signature");
  return { senderDid: inner.from, envelope, kind, pq };
}

/** Mailbox id: the relay never needs the did itself. */
export async function mailboxIdForDid(did: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(did));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
