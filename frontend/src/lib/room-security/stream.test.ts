import { afterEach, expect, it, vi } from "vitest";
import type { Connection, Stream } from "@libp2p/interface";
import { attachRoomStream } from "./stream";
import { deriveRoomKeys, newRoomSecret } from "./keys";

class Wire extends EventTarget {
  other?: Wire;
  aborted = false;
  backpressure = false;
  onDrain = vi.fn(async () => {});
  send(data: Uint8Array) {
    // Deliberately split length prefix and payload across separate events.
    for (const chunk of [data.slice(0, 2), data.slice(2, 5), data.slice(5)]) {
      queueMicrotask(() => {
        if (!this.aborted && !this.other?.aborted) this.other?.dispatchEvent(Object.assign(new Event("message"), { data: chunk }));
      });
    }
    return !this.backpressure;
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.dispatchEvent(new Event("close"));
    this.other?.dispatchEvent(new Event("close"));
  }
}
const handles: ReturnType<typeof attachRoomStream>[] = [];
afterEach(() => { for (const h of handles) h.close(); handles.length = 0; });

function setup(backpressure = false) {
  const keys = deriveRoomKeys(newRoomSecret());
  const rooms = new Map([[keys.discoveryId, keys]]);
  const a = new Wire(), b = new Wire();
  a.other = b; b.other = a; a.backpressure = backpressure;
  const onData = vi.fn(), ready = vi.fn(), closed = vi.fn();
  const connection = (peer: string) => ({ status: "open", remotePeer: { toString: () => peer } }) as Connection;
  const inbound = attachRoomStream({ stream: b as unknown as Stream, connection: connection("alice"),
    local: "bob", rooms, onData, onReady: ready, onClose: closed });
  const outbound = attachRoomStream({ stream: a as unknown as Stream, connection: connection("bob"),
    local: "alice", rooms, initiate: keys, onData: () => {}, onReady: () => {}, onClose: () => {} });
  handles.push(inbound, outbound);
  return { a, b, inbound, outbound, onData, ready, closed, keys };
}

it("frames fragmented authenticated streams and delivers encrypted room data", async () => {
  const p = setup();
  await p.outbound.getChannel()!.ready;
  await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
  const data = new Uint8Array([1, 2, 3]);
  expect(await p.outbound.getChannel()!.send(data)).toBe(true);
  await vi.waitFor(() => expect(p.onData).toHaveBeenCalledWith(p.keys.discoveryId, data));
});

it("waits for backpressure drain without losing authorization", async () => {
  const p = setup(true);
  await p.outbound.getChannel()!.ready;
  expect(await p.outbound.getChannel()!.send(new Uint8Array([9]))).toBe(true);
  await vi.waitFor(() => expect(p.onData).toHaveBeenCalledOnce());
  expect(p.a.onDrain).toHaveBeenCalled();
  expect(p.outbound.getChannel()!.verified).toBe(true);
});

it("withdraws authorization when the stream closes", async () => {
  const p = setup();
  await p.outbound.getChannel()!.ready;
  await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
  p.b.abort();
  expect(p.outbound.getChannel()!.verified).toBe(false);
  expect(p.inbound.getChannel()!.verified).toBe(false);
  expect(await p.outbound.getChannel()!.send(new Uint8Array([1]))).toBe(false);
  expect(p.closed).toHaveBeenCalledOnce();
});

it("rejects an oversized declared frame before buffering its payload", async () => {
  const p = setup();
  await p.outbound.getChannel()!.ready;
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, 0xffffffff);
  p.b.dispatchEvent(Object.assign(new Event("message"), { data: bytes }));
  expect(p.b.aborted).toBe(true);
  expect(p.onData).not.toHaveBeenCalled();
});
