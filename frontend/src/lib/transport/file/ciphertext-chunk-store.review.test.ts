// Second-round review (wp02-files): every protected file this device serves
// now has its pieces read by CiphertextChunkStore, and nothing in the branch
// exercises its get(): the mocked webtorrent client never reads a piece. A
// wrong offset here fails every peer's piece hash, for every protected file.
import { expect, it } from "vitest";
import { CiphertextChunkStore } from "./opfs-store";

const PIECE = 16;
const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
const get = (store: CiphertextChunkStore, index: number, opts?: { offset?: number; length?: number }) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const cb = (error: unknown, buf?: Uint8Array) => (error ? reject(error) : resolve(new Uint8Array(buf!)));
    if (opts) store.get(index, opts, cb);
    else store.get(index, cb);
  });

it("reads whole pieces, the short last one, and ranges inside a piece", async () => {
  const store = new CiphertextChunkStore(PIECE, new Blob([bytes]));
  expect(await get(store, 0)).toEqual(bytes.slice(0, 16));
  expect(await get(store, 1)).toEqual(bytes.slice(16, 32));
  expect(await get(store, 2)).toEqual(bytes.slice(32, 40));
  // How cache-chunk-store asks: (index, cb), or (index, null, cb).
  expect(await new Promise<Uint8Array>((r) => store.get(2, null, (_e, b) => r(new Uint8Array(b!))))).toEqual(bytes.slice(32, 40));
  expect(await get(store, 1, { offset: 4, length: 8 })).toEqual(bytes.slice(20, 28));
  expect(await get(store, 2, { offset: 2 })).toEqual(bytes.slice(34, 40));
});

it("reads a fresh handle when the one it holds went stale, and nothing is ever written", async () => {
  const stale = { size: bytes.length, slice: () => ({ arrayBuffer: async () => { throw new DOMException("changed", "NotReadableError"); } }) } as unknown as Blob;
  const store = new CiphertextChunkStore(PIECE, stale, async () => new Blob([bytes]));
  expect(await get(store, 1)).toEqual(bytes.slice(16, 32));
  await expect(new Promise((resolve, reject) => store.put(0, new Uint8Array(1), (e) => (e ? reject(e) : resolve(null))))).rejects.toThrow("Read-only");
});
