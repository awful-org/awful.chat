import { afterEach, expect, it, vi } from "vitest";
import { MAX_ROOM_MESSAGE, SecureRoomChannel } from "./channel";
import { deriveRoomKeys, newRoomSecret } from "./keys";

const channels: SecureRoomChannel[] = [];
afterEach(() => { for (const c of channels) c.close(); channels.length = 0; });

async function pair(keys = deriveRoomKeys(newRoomSecret())) {
  const delivered = vi.fn();
  const fromA: unknown[] = [];
  let a: SecureRoomChannel;
  const b = new SecureRoomChannel(keys, "bob", "alice", "responder", async (f) => {
    queueMicrotask(() => a.receive(f, JSON.stringify(f).length));
  }, delivered, () => {});
  a = new SecureRoomChannel(keys, "alice", "bob", "initiator", async (f) => {
    fromA.push(f);
    queueMicrotask(() => b.receive(f, JSON.stringify(f).length));
  }, () => {}, () => {});
  channels.push(a, b);
  await Promise.all([a.ready, b.ready]);
  return { a, b, fromA, delivered, keys };
}

it("exchanges encrypted data only after mutual admission", async () => {
  const { a, delivered, fromA } = await pair();
  const data = new TextEncoder().encode("private profile and history");
  expect(await a.send(data)).toBe(true);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(data));
  expect(JSON.stringify(fromA)).not.toContain("private profile");
});

it("rejects replay on the same authenticated channel", async () => {
  const { a, b, fromA, delivered } = await pair();
  await a.send(new Uint8Array([42]));
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
  const recorded = fromA.at(-1);
  b.receive(recorded, JSON.stringify(recorded).length);
  await vi.waitFor(() => expect(b.verified).toBe(false));
  expect(delivered).toHaveBeenCalledTimes(1);
});

it("reassembles a multi-megabyte profile before dispatching it exactly once", async () => {
  const { a, delivered } = await pair();
  const data = new Uint8Array(2 * 1024 * 1024 + 17);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  expect(await a.send(data)).toBe(true);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1), { timeout: 5000 });
  const received = delivered.mock.calls[0][0] as Uint8Array;
  expect(received).toBeInstanceOf(Uint8Array);
  expect(received.length).toBe(data.length);
  // Avoid millions of generic matcher object comparisons for a byte buffer.
  expect(received.every((byte, index) => byte === data[index])).toBe(true);
});

it("rejects oversized application messages without closing a healthy channel", async () => {
  const { a, delivered } = await pair();
  expect(await a.send(new Uint8Array(MAX_ROOM_MESSAGE + 1))).toBe(false);
  expect(await a.send(new Uint8Array([9]))).toBe(true);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(new Uint8Array([9])));
});

it("rejects a valid encrypted frame replayed onto a fresh connection", async () => {
  const original = await pair();
  await original.a.send(new Uint8Array([7]));
  await vi.waitFor(() => expect(original.delivered).toHaveBeenCalledTimes(1));
  const next = await pair(original.keys);
  const recorded = original.fromA.at(-1);
  next.b.receive(recorded, JSON.stringify(recorded).length);
  await vi.waitFor(() => expect(next.b.verified).toBe(false));
  expect(next.delivered).not.toHaveBeenCalled();
});

it("does not send data on an unverified or closed connection", async () => {
  const write = vi.fn(async () => {});
  const c = new SecureRoomChannel(deriveRoomKeys(newRoomSecret()), "bob", "alice", "responder", write, () => {}, () => {});
  channels.push(c);
  expect(await c.send(new Uint8Array([1]))).toBe(false);
  c.close();
  expect(await c.send(new Uint8Array([1]))).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
