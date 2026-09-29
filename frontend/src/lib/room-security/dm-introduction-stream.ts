import type { Connection, Stream, StreamMessageEvent } from "@libp2p/interface";
import { base64urlnopad as b64 } from "@scure/base";
import type { UnlockedSession } from "$lib/identity/identity";
import { DmIntroductionChallenge, sealDmIntroduction } from "./dm-introduction";
import type { RoomSecret } from "./keys";

export const DM_INTRODUCTION_PROTOCOL = "/awful/dm-introduction/2.0.0";
const LIMIT = 24_000;

/** A bounded, mutual identity proof on one authenticated device connection.
 * Public DID hints are not bindings; only accept() may publish a binding.
 * Identity object equality invalidates work across lock/unlock or account swap.
 */
export function attachDmIntroduction(options: {
  stream: Stream; connection: Connection; local: string;
  identity: () => UnlockedSession | null;
  initiate?: { expectedDid?: string };
  verified: (did: string, secret: RoomSecret) => Promise<void>;
  onClose: () => void;
}): { close: () => void; ready: Promise<boolean> } {
  const { stream, connection } = options;
  const identity = options.identity();
  const challenge = new DmIntroductionChallenge(options.local, connection.remotePeer.toString());
  let closed = false;
  let state = options.initiate ? "reply" : "hello";
  let expectedDid: string | undefined;
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
  async function proof(did: string, nonce: string) {
    return b64.encode(await sealDmIntroduction({ identity: identity!, recipientDid: did,
      senderPeer: options.local, recipientPeer: connection.remotePeer.toString(), challenge: nonce }));
  }
  async function handle(frame: any) {
    if (!current() || !frame || typeof frame !== "object") throw new Error("Invalid introduction");
    if (state === "ack" && frame.done === true) {
      state = "done"; resolve(true); return;
    }
    if (state === "hello") {
      state = "finish";
      if (typeof frame.did !== "string" || frame.did.length > 128 || typeof frame.challenge !== "string") throw new Error("Invalid hello");
      expectedDid = frame.did;
      await write({ proof: await proof(frame.did, frame.challenge), challenge: challenge.challenge });
      return;
    }
    if (state !== "reply" && state !== "finish") throw new Error("Unexpected introduction frame");
    const reply = state === "reply"; state = "done";
    if (typeof frame.proof !== "string" || frame.proof.length > 22_000) throw new Error("Invalid proof");
    const result = await challenge.accept(b64.decode(frame.proof), identity!);
    if (!current() || (expectedDid && result.senderDid !== expectedDid) ||
        (options.initiate?.expectedDid && result.senderDid !== options.initiate.expectedDid)) throw new Error("Identity mismatch");
    if (!current()) throw new Error("Identity session ended");
    await options.verified(result.senderDid, result.secret);
    if (!current()) throw new Error("Identity session ended");
    if (reply) {
      state = "ack";
      await write({ proof: await proof(result.senderDid, frame.challenge) });
    } else {
      await write({ done: true }); resolve(true);
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
  else if (options.initiate) void write({ did: identity.did, challenge: challenge.challenge }).catch(close);
  return { close, ready };
}
