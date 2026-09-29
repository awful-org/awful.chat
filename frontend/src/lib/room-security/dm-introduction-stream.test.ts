import { afterEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { attachDmIntroduction } from "./dm-introduction-stream";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}
class Stream extends EventTarget {
  other!: Stream;
  send(data: Uint8Array) {
    // Fragment across the length prefix and the JSON body.
    for (const bytes of [data.slice(0, 2), data.slice(2, 7), data.slice(7)]) {
      queueMicrotask(() => this.other.dispatchEvent(new MessageEvent("message", { data: bytes })));
    }
    return true;
  }
  abort() {}
  onDrain() { return Promise.resolve(); }
}
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); vi.useRealTimers(); });
function pair(expectedDid?: string, remote = "alice-device") {
  const alice = identity(), bob = identity();
  let session: UnlockedSession | null = alice;
  const a = new Stream(), b = new Stream(); a.other = b; b.other = a;
  const acceptedA = vi.fn(async (_did: string, _secret: string) => {}), acceptedB = vi.fn(async (_did: string, _secret: string) => {});
  const responder = attachDmIntroduction({ stream: b as any,
    connection: { status: "open", remotePeer: { toString: () => remote } } as any,
    local: "bob-device", identity: () => bob, verified: acceptedB, onClose: () => {} });
  const initiator = attachDmIntroduction({ stream: a as any,
    connection: { status: "open", remotePeer: { toString: () => "bob-device" } } as any,
    local: "alice-device", identity: () => session, initiate: { expectedDid }, verified: acceptedA, onClose: () => {} });
  closers.push(initiator.close, responder.close);
  return { alice, bob, a, initiator, responder, acceptedA, acceptedB, lock: () => { session = null; } };
}
it("mutually binds authenticated device peers and derives matching secrets over fragmented streams", async () => {
  const p = pair();
  expect(await p.initiator.ready).toBe(true);
  expect(await p.responder.ready).toBe(true);
  expect(p.acceptedA).toHaveBeenCalledWith(p.bob.did, expect.any(String));
  expect(p.acceptedB).toHaveBeenCalledWith(p.alice.did, p.acceptedA.mock.calls[0][1]);
});
it("rejects connection substitution before publishing a DID binding", async () => {
  const p = pair(undefined, "mallory-device");
  expect(await p.initiator.ready).toBe(false);
  expect(p.acceptedA).not.toHaveBeenCalled(); expect(p.acceptedB).not.toHaveBeenCalled();
});
it("rejects unexpected account identities and lock during crypto", async () => {
  const p = pair(identity().did);
  expect(await p.initiator.ready).toBe(false); expect(p.acceptedA).not.toHaveBeenCalled();
  const locked = pair(); locked.lock();
  expect(await locked.initiator.ready).toBe(false); expect(locked.acceptedA).not.toHaveBeenCalled();
});
it("closes stalled peers at the deadline", async () => {
  vi.useFakeTimers();
  const stream = new Stream(); stream.other = new Stream();
  const session = identity(), verified = vi.fn(), onClose = vi.fn();
  const handle = attachDmIntroduction({ stream: stream as any,
    connection: { status: "open", remotePeer: { toString: () => "remote-device" } } as any,
    local: "local-device", identity: () => session, verified, onClose });
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await handle.ready).toBe(false);
  expect(verified).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
});
