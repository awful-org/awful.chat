import type { Connection, Stream, StreamMessageEvent } from "@libp2p/interface";
import { base64urlnopad as b64 } from "@scure/base";
import { didToPublicKey, type UnlockedSession } from "$lib/identity/identity";
import { pqKeyCertificate, verifyPqKeyCertificate, type PqKeyCertificate } from "$lib/identity/pq-identity";
import { DmIntroductionChallenge, sealDmIntroduction, type IntroductionPq } from "./dm-introduction";
import type { RoomSecret } from "./keys";
import {
  confirmationsMatch, dmPqConfirmation, dmPqEncapsulate, dmPqRole, hybridPairwiseRoomSecret,
  type DmPqRole, type DmPqState,
} from "./pq-dm";

export const DM_INTRODUCTION_PROTOCOL = "/awful/dm-introduction/2.0.0";
const LIMIT = 24_000;

/**
 * The post-quantum upgrade rides this same four-frame exchange, so an older
 * build on either end simply never sees it (the protocol ID is unchanged and
 * it ignores fields it does not know):
 *
 *   hello  I->R  { did, challenge, pq: I's key certificate }
 *   reply  R->I  { proof, challenge, pq: R's key certificate }
 *   finish I->R  { proof }
 *   done   R->I  { done: true, pq?: true | R's confirmation }
 *
 * A proof carries a PQ part (dm-introduction.ts) only when the other device
 * advertised a key certificate - that is how each side knows the other is a
 * new build. The encapsulating identity (pq-dm.ts) puts its ciphertext and a
 * confirmation in its proof; the decapsulator answers with its own
 * confirmation, in its proof or in `done`. Each side hands the state to
 * `upgraded` only once it has checked the OTHER side's confirmation - both
 * derived the same key - so a failed or partial exchange leaves the
 * conversation as it was instead of on a key only one side has:
 *
 *   R encapsulates: R's proof {ct, confirm}; I checks, finish {confirm}; R
 *                   checks, upgrades, done {pq: true}; I upgrades.
 *   I encapsulates: R's proof {} ("I speak PQ"); finish {ct, confirm}; R
 *                   checks, upgrades, done {pq: R's confirm}; I checks,
 *                   upgrades.
 *
 * The last frame can be lost after one side upgraded; the two devices then
 * disagree until their next introduction, which the DM lobby
 * (libp2p/transport.ts) starts. Nothing is lost meanwhile - they are simply
 * not in the same live room, and messages take the mailbox.
 */
interface PqSession {
  role: DmPqRole;
  state?: DmPqState;
  secret?: RoomSecret;
}

/** A bounded, mutual identity proof on one authenticated device connection.
 * Public DID hints are not bindings; only accept() may publish a binding.
 * Identity object equality invalidates work across lock/unlock or account swap.
 */
export function attachDmIntroduction(options: {
  stream: Stream; connection: Connection; local: string;
  identity: () => UnlockedSession | null;
  initiate?: { expectedDid?: string };
  /** `pqPending`: this introduction is about to upgrade the conversation
   * (it may still fail - then `upgraded` is never called). */
  verified: (did: string, secret: RoomSecret, pqPending: boolean) => Promise<void>;
  upgraded?: (did: string, state: DmPqState) => Promise<void>;
  onClose: () => void;
}): { close: () => void; ready: Promise<boolean> } {
  const { stream, connection } = options;
  const identity = options.identity();
  const remote = connection.remotePeer.toString();
  const challenge = new DmIntroductionChallenge(options.local, remote);
  // Our own certificate, advertised in our first frame. Without one this
  // device behaves exactly like an older build - which is also what it must
  // do with nowhere to put an agreed state: confirming an upgrade we then do
  // not store would leave the other side on a key we never join.
  let ownCert: PqKeyCertificate | undefined;
  try { ownCert = identity && options.upgraded ? pqKeyCertificate(identity) : undefined; } catch { ownCert = undefined; }
  let closed = false;
  let state = options.initiate ? "reply" : "hello";
  let expectedDid: string | undefined;
  let peerDid: string | undefined;
  let pqSession: PqSession | undefined;
  let context: string[] = [];
  let buffer = new Uint8Array(0);
  let frames = 0;
  let chain = Promise.resolve();
  let resolve!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => { resolve = r; });
  const timer = setTimeout(close, 10_000);
  function current() { return !closed && !!identity && options.identity() === identity && connection.status === "open"; }
  function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); challenge.cancel(); buffer = new Uint8Array(0);
    stream.removeEventListener("message", receive); stream.removeEventListener("close", close);
    stream.abort(new Error("DM introduction ended")); options.onClose(); resolve(false);
  }
  async function write(value: unknown) {
    if (!current()) throw new Error("Identity session ended");
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > LIMIT) throw new Error("Introduction oversized");
    const frame = new Uint8Array(bytes.length + 4);
    new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4);
    if (!stream.send(frame)) await Promise.race([stream.onDrain(), ready.then(() => { throw new Error("Introduction closed"); })]);
    if (!current()) throw new Error("Identity session ended");
  }
  async function proof(did: string, nonce: string, pq?: IntroductionPq, recipientPqKey?: Uint8Array | null) {
    return b64.encode(await sealDmIntroduction({ identity: identity!, recipientDid: did,
      senderPeer: options.local, recipientPeer: remote, challenge: nonce, pq, recipientPqKey }));
  }
  /** Our role against that DID, or undefined when no PQ exchange is possible. */
  function pqRole(did: string): DmPqRole | undefined {
    try { return ownCert ? dmPqRole(identity!.privateKey, didToPublicKey(did)) : undefined; }
    catch { return undefined; }
  }
  /** Null on failure: a PQ problem must never cost the introduction itself,
   * which then simply completes in the plain form. */
  function encapsulate(did: string, peerKey: Uint8Array): PqSession | null {
    try {
      const remoteKey = didToPublicKey(did);
      const pqState = dmPqEncapsulate(identity!.privateKey, remoteKey, peerKey);
      return { role: "encapsulator", state: pqState,
        secret: hybridPairwiseRoomSecret(identity!.privateKey, remoteKey, pqState) };
    } catch { return null; }
  }
  /** Decapsulate the peer's ciphertext and check its confirmation; null if
   * either fails, which ends the PQ part and nothing else. */
  function decapsulate(did: string, pq: IntroductionPq): PqSession | null {
    if (!pq.ct || !pq.confirm || !ownCert) return null;
    const pqState: DmPqState = { v: 1, ct: pq.ct, ek: ownCert.key };
    try {
      const secret = hybridPairwiseRoomSecret(identity!.privateKey, didToPublicKey(did), pqState);
      if (!confirmationsMatch(dmPqConfirmation(secret, "encapsulator", context), pq.confirm)) return null;
      return { role: "decapsulator", state: pqState, secret };
    } catch { return null; }
  }
  async function upgrade(did: string, session: PqSession | undefined) {
    if (!session?.state || !current()) return;
    await options.upgraded?.(did, session.state);
  }
  async function handle(frame: any) {
    if (!current() || !frame || typeof frame !== "object") throw new Error("Invalid introduction");
    if (state === "ack" && frame.done === true) {
      state = "done";
      // Our half is only adopted once the responder says - or proves - it
      // adopted the same key.
      if (pqSession?.role === "decapsulator" && frame.pq === true) {
        await upgrade(peerDid!, pqSession);
      } else if (pqSession?.role === "encapsulator" && pqSession.secret &&
          confirmationsMatch(dmPqConfirmation(pqSession.secret, "decapsulator", context), frame.pq)) {
        await upgrade(peerDid!, pqSession);
      }
      resolve(true); return;
    }
    if (state === "hello") {
      state = "finish";
      if (typeof frame.did !== "string" || frame.did.length > 128 || typeof frame.challenge !== "string") throw new Error("Invalid hello");
      expectedDid = frame.did;
      context = [frame.challenge, challenge.challenge, remote, options.local];
      // The PQ part answers the initiator's certificate. Its DID is only
      // claimed here; the proof is sealed to it and the finish frame must be
      // signed by it, so a false claim gets nothing.
      const peerKey = verifyPqKeyCertificate(frame.did, frame.pq);
      let pq: IntroductionPq | undefined;
      const role = peerKey ? pqRole(frame.did) : undefined;
      if (peerKey && role === "encapsulator") {
        pqSession = encapsulate(frame.did, peerKey) ?? undefined;
        if (pqSession) pq = { ct: pqSession.state!.ct, confirm: dmPqConfirmation(pqSession.secret!, "encapsulator", context) };
      } else if (peerKey && role === "decapsulator") {
        pqSession = { role };
        pq = {};
      }
      await write({ proof: await proof(frame.did, frame.challenge, pq, peerKey), challenge: challenge.challenge,
        ...(ownCert ? { pq: ownCert } : {}) });
      return;
    }
    if (state !== "reply" && state !== "finish") throw new Error("Unexpected introduction frame");
    const reply = state === "reply"; state = "done";
    if (typeof frame.proof !== "string" || frame.proof.length > 22_000) throw new Error("Invalid proof");
    const result = await challenge.accept(b64.decode(frame.proof), identity!, { acceptPq: !!ownCert });
    if (!current() || (expectedDid && result.senderDid !== expectedDid) ||
        (options.initiate?.expectedDid && result.senderDid !== options.initiate.expectedDid)) throw new Error("Identity mismatch");
    if (!current()) throw new Error("Identity session ended");
    // The PQ outcome is settled BEFORE the binding is published, so the
    // binding can say an upgrade is under way: a conversation that does not
    // exist yet is then created by the upgrade, under the hybrid key, instead
    // of under the classical one for the moments in between.
    if (reply) {
      peerDid = result.senderDid;
      if (typeof frame.challenge === "string") context = [challenge.challenge, frame.challenge, options.local, remote];
      const peerKey = verifyPqKeyCertificate(result.senderDid, frame.pq);
      let pq: IntroductionPq | undefined;
      // A PQ part in their proof means they saw our certificate and speak PQ;
      // anything we send back must then be in the PQ form too, even a refusal.
      if (result.pq) {
        const role = pqRole(result.senderDid);
        if (role === "decapsulator") {
          pqSession = decapsulate(result.senderDid, result.pq) ?? undefined;
          pq = pqSession ? { confirm: dmPqConfirmation(pqSession.secret!, "decapsulator", context) } : {};
        } else if (role === "encapsulator" && peerKey && !result.pq.ct) {
          pqSession = encapsulate(result.senderDid, peerKey) ?? undefined;
          pq = pqSession ? { ct: pqSession.state!.ct, confirm: dmPqConfirmation(pqSession.secret!, "encapsulator", context) } : {};
        } else {
          pq = {};
        }
      }
      await options.verified(result.senderDid, result.secret, !!pqSession);
      if (!current()) throw new Error("Identity session ended");
      state = "ack";
      await write({ proof: await proof(result.senderDid, frame.challenge, pq, peerKey) });
    } else {
      // The initiator's finish: the last word on the PQ part.
      let adopt: PqSession | null = null;
      let done: { done: true; pq?: true | string } = { done: true };
      if (pqSession && result.pq) {
        if (pqSession.role === "encapsulator" && pqSession.secret && !result.pq.ct &&
            confirmationsMatch(dmPqConfirmation(pqSession.secret, "decapsulator", context), result.pq.confirm)) {
          adopt = pqSession;
          done = { done: true, pq: true };
        } else if (pqSession.role === "decapsulator") {
          adopt = decapsulate(result.senderDid, result.pq);
          if (adopt) done = { done: true, pq: dmPqConfirmation(adopt.secret!, "decapsulator", context) };
        }
      }
      await options.verified(result.senderDid, result.secret, !!adopt);
      if (!current()) throw new Error("Identity session ended");
      if (adopt) await upgrade(result.senderDid, adopt);
      await write(done); resolve(true);
    }
    // Keep the bounded stream alive until its deadline: aborting immediately
    // can cancel the remote's queued crypto before it processes the final proof.
  }
  function receive(event: StreamMessageEvent) {
    try {
      if (!current()) { close(); return; }
      const chunk = event.data instanceof Uint8Array ? event.data : event.data.subarray();
      if (buffer.length + chunk.length > LIMIT + 4) throw new Error("Introduction buffer limit");
      const next = new Uint8Array(buffer.length + chunk.length); next.set(buffer); next.set(chunk, buffer.length); buffer = next;
      while (buffer.length >= 4) {
        const n = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (!n || n > LIMIT) throw new Error("Introduction frame limit");
        if (buffer.length < n + 4) break;
        if (++frames > 2) throw new Error("Introduction count limit");
        const frame = JSON.parse(new TextDecoder().decode(buffer.subarray(4, n + 4)));
        buffer = buffer.slice(n + 4);
        chain = chain.then(() => handle(frame)); void chain.catch(close);
      }
    } catch { close(); }
  }
  stream.addEventListener("message", receive); stream.addEventListener("close", close);
  if (!identity) close();
  else if (options.initiate) void write({ did: identity.did, challenge: challenge.challenge,
    ...(ownCert ? { pq: ownCert } : {}) }).catch(close);
  return { close, ready };
}
