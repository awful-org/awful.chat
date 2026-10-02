import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeLocks, fakeOPFS } from "./opfs-test-helper";
import type { FileEntry } from "../../types/message";

const clients: Client[] = [];
const seeds: { file: File; opts: any }[] = [];
class Torrent extends EventEmitter {
  infoHash = "";
  done = false;
  progress = 0;
  numPeers = 0;
  length?: number;
  files: any[] = [];
  destroyed = false;
  destroy() { this.destroyed = true; }
}
class Client {
  torrents = new Map<string, Torrent>();
  constructor() { clients.push(this); }
  get(hash: string) { return this.torrents.get(hash); }
  add(hash: string) { const t = new Torrent(); t.infoHash = hash; this.torrents.set(hash, t); return t; }
  seed(file: File, opts: any, cb: (t: Torrent) => void) {
    seeds.push({ file, opts });
    const t = new Torrent();
    void file.arrayBuffer().then(bytes => {
      t.infoHash = createHash("sha1").update(file.name).update(String(opts.pieceLength)).update(new Uint8Array(bytes)).digest("hex");
      t.length = file.size;
      t.done = true;
      t.files = [{ name: file.name }];
      this.torrents.set(t.infoHash, t);
      cb(t);
    });
    return t;
  }
  destroy(cb: () => void) { for (const t of this.torrents.values()) t.destroy(); cb(); }
}
vi.mock("webtorrent", () => ({ default: Client }));
vi.mock("simple-peer", () => ({ default: class extends EventEmitter {} }));
vi.mock("../ice-server-list", () => ({ getIceServers: () => [], onIceServersChanged: () => () => {} }));
vi.mock("../../telemetry/recorder", () => ({ rec: () => {}, refs: () => ({ fileRef: () => "file" }) }));
import { WebTorrentFileTransport } from "./webtorrent";
let disk: ReturnType<typeof fakeOPFS>;
const transports: WebTorrentFileTransport[] = [];
function transport() { const t = new WebTorrentFileTransport(() => "me"); transports.push(t); return t; }
beforeEach(() => { disk = fakeOPFS(); vi.stubGlobal("navigator", disk); clients.length = 0; seeds.length = 0; });
afterEach(() => { for (const t of transports.splice(0)) t.destroy(); vi.unstubAllGlobals(); });

async function offer() {
  const sender = transport();
  const original = new File(["private medical report"], "diagnosis.txt", { type: "text/plain" });
  const [descriptor] = await sender.seedEncryptedFiles([original]);
  const bytes = await sender.persistableCiphertext(descriptor.infoHash, 1000);
  return { sender, original, descriptor, bytes: bytes! };
}
async function deliver(receiver: WebTorrentFileTransport, descriptor: FileEntry, bytes: ArrayBuffer) {
  const count = clients.length;
  receiver.ensureDownload(descriptor);
  await vi.waitFor(() => { expect(clients.length).toBe(count + 1); expect(clients.at(-1)?.get(descriptor.infoHash)).toBeTruthy(); });
  const t = clients.at(-1)!.get(descriptor.infoHash)!;
  t.length = bytes.byteLength;
  t.files = [{ name: `${descriptor.encryption!.id}.bin`, async *createReadStream() { yield new Uint8Array(bytes); } }];
  t.emit("metadata");
  t.done = true;
  t.emit("done");
  return t;
}
it("seeds only opaque ciphertext, authenticates before publication, and restarts with identical ciphertext identity", async () => {
  const { sender, original, descriptor, bytes } = await offer();
  expect(seeds[0].file.name).not.toContain("diagnosis");
  expect(seeds[0].file.type).toBe("application/octet-stream");
  expect(await seeds[0].file.text()).not.toContain("medical");
  // Pieces read from the ciphertext itself: no piece store copies it.
  expect(seeds[0].opts.preloadedStore).toBeTruthy();
  expect(seeds[0].opts.store).toBeUndefined();
  expect(JSON.stringify(seeds[0].opts)).not.toContain(descriptor.encryption!.key);
  const receiver = transport();
  const downloaded = vi.fn(); receiver.on("downloaded", downloaded);
  await deliver(receiver, descriptor, bytes);
  expect(downloaded).not.toHaveBeenCalled();
  expect(receiver.getTransfer(descriptor.infoHash)?.done).toBe(false);
  await vi.waitFor(() => expect(downloaded).toHaveBeenCalledOnce());
  expect(await downloaded.mock.calls[0][1].text()).toBe(await original.text());
  expect(receiver.getTransfer(descriptor.infoHash)?.seeding).toBe(true);
  expect(seeds).toHaveLength(1); // downloaded plaintext was never re-seeded
  sender.resetTransfers(); receiver.resetTransfers();
  const restarted = transport();
  expect(await restarted.restoreEncryptedFile(descriptor)).toBe(true);
  expect(restarted.getTransfer(descriptor.infoHash)?.blobURL).toBeTruthy();
  expect(restarted.getTransfer(descriptor.infoHash)?.seeding).toBe(true);
  expect(seeds).toHaveLength(1); // shown, not seeded
  // A peer asking for it gets the very same torrent back.
  expect(await restarted.seedStoredFile(descriptor)).toBe(true);
  expect(seeds[1].file.name).toBe(seeds[0].file.name);
  expect(seeds[1].opts.pieceLength).toBe(seeds[0].opts.pieceLength);
  expect(await seeds[1].file.arrayBuffer()).toEqual(bytes);
});

it.each(["key", "tamper", "truncation"])("never publishes or reseeds plaintext after %s failure", async kind => {
  const offered = await offer();
  const descriptor = structuredClone(offered.descriptor);
  let bytes = offered.bytes;
  if (kind === "key") descriptor.encryption!.key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  if (kind === "tamper") { const b = new Uint8Array(bytes.slice(0)); b[0] ^= 1; bytes = b.buffer; }
  if (kind === "truncation") bytes = bytes.slice(0, -1);
  const receiver = transport(); const downloaded = vi.fn(); receiver.on("downloaded", downloaded);
  await deliver(receiver, descriptor, bytes);
  await vi.waitFor(() => expect(receiver.getTransfer(descriptor.infoHash)?.status).toBe("failed"));
  expect(downloaded).not.toHaveBeenCalled();
  expect(receiver.getTransfer(descriptor.infoHash)?.blobURL).toBeUndefined();
  expect(seeds).toHaveLength(1);
});

it("reset cancels an in-flight download without late plaintext publication", async () => {
  const { descriptor, bytes } = await offer();
  const receiver = transport(); const downloaded = vi.fn(); receiver.on("downloaded", downloaded);
  await deliver(receiver, descriptor, bytes);
  receiver.resetTransfers();
  await new Promise(r => setTimeout(r, 30));
  expect(downloaded).not.toHaveBeenCalled();
  expect(receiver.getTransfers()).toEqual([]);
  expect([...disk.entries.keys()].filter(k => k.startsWith("room-v2-transfers/"))).toEqual([]);
});

it("a finished download and a restore leave no plaintext anywhere on disk", async () => {
  const { descriptor, bytes, original } = await offer();
  const receiver = transport(); const downloaded = vi.fn(); receiver.on("downloaded", downloaded);
  await deliver(receiver, descriptor, bytes);
  await vi.waitFor(() => expect(downloaded).toHaveBeenCalledOnce());
  // The next session opens the conversation and shows the file again.
  const restarted = transport();
  expect(await restarted.restoreEncryptedFile(descriptor)).toBe(true);
  const secret = await original.text();
  for (const [path, blob] of disk.entries) {
    expect(await blob.text(), path).not.toContain(secret);
  }
  // ...without leaving the session it ran in: a tab closed without a lock
  // runs nothing, and the plaintext must already be nowhere but in memory.
  expect([...disk.entries.keys()].filter(k => k.startsWith("room-v2-transfers/"))).toEqual([]);
  expect(await downloaded.mock.calls[0][1].text()).toBe(secret);
});

it("showing a stored file again writes nothing and seeds nothing", async () => {
  const { descriptor, bytes, original } = await offer();
  const before = new Map(disk.entries);
  const restarted = transport(); const downloaded = vi.fn(); restarted.on("downloaded", downloaded);
  // From the durable copy, and from the row's own copy of the same bytes.
  expect(await restarted.restoreEncryptedFile(descriptor)).toBe(true);
  expect(await restarted.restoreEncryptedFile({ ...descriptor, data: bytes } as FileEntry, bytes)).toBe(true);
  expect(new Map(disk.entries)).toEqual(before);
  expect([...disk.entries].every(([path, blob]) => before.get(path) === blob)).toBe(true);
  expect(seeds).toHaveLength(1);
  // Marked as read back from storage, so nobody stores it again.
  expect(downloaded.mock.calls.map(call => call[2])).toEqual([true, true]);
  expect(await downloaded.mock.calls[1][1].text()).toBe(await original.text());
  // The transfer holds the descriptor only, never the row's bytes.
  expect(restarted.getTransfer(descriptor.infoHash)).not.toHaveProperty("data");
});

it("keeps one durable copy of a row's bytes when this device's file store has none", async () => {
  const { descriptor, bytes } = await offer();
  disk.entries.delete(`room-v2-ciphertext/${descriptor.infoHash}`);
  const restarted = transport();
  expect(await restarted.restoreEncryptedFile(descriptor)).toBe(false);
  expect(await restarted.restoreEncryptedFile(descriptor, bytes)).toBe(true);
  const kept = disk.entries.get(`room-v2-ciphertext/${descriptor.infoHash}`);
  expect(await kept?.arrayBuffer()).toEqual(bytes);
  expect(await restarted.restoreEncryptedFile(descriptor, bytes)).toBe(true);
  expect(disk.entries.get(`room-v2-ciphertext/${descriptor.infoHash}`)).toBe(kept);
});

it("serves a stored file from its ciphertext as it is: nothing decrypted, nothing copied", async () => {
  const { descriptor, bytes } = await offer();
  const restarted = transport();
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  const before = new Map(disk.entries);
  // Two peers asking at once get one seed.
  const [a, b] = await Promise.all([restarted.seedStoredFile(descriptor), restarted.seedStoredFile(descriptor)]);
  expect([a, b]).toEqual([true, true]);
  expect(decrypt).not.toHaveBeenCalled();
  decrypt.mockRestore();
  expect(seeds).toHaveLength(2);
  expect(seeds[1].opts.store).toBeUndefined();
  expect(new Map(disk.entries)).toEqual(before);
  const piece = await new Promise<Uint8Array>((resolve, reject) =>
    seeds[1].opts.preloadedStore.get(0, (e: unknown, buf: Uint8Array) => (e ? reject(e) : resolve(buf))));
  expect(new Uint8Array(piece)).toEqual(new Uint8Array(bytes));
  expect(restarted.getTransfer(descriptor.infoHash)?.status).toBe("seeding");
  // A file this device holds no ciphertext for is not served at all.
  disk.entries.delete(`room-v2-ciphertext/${descriptor.infoHash}`);
  expect(await transport().seedStoredFile(descriptor)).toBe(false);
});

it("a starting session clears what closed ones left, and a lock clears its own", async () => {
  vi.stubGlobal("navigator", { storage: disk.storage, locks: fakeLocks() });
  const temporary = () => [...disk.entries.keys()].filter(k => !k.startsWith("room-v2-ciphertext/"));
  // An older build's tab that was closed without a lock, and a crashed one.
  disk.entries.set("room-v2-transfers/3a1392f4-7763-43e2-a8a9-7cd8fb556978", new Blob(["private medical report"]));
  disk.entries.set("room-v2-pieces/0123456789abcdef/0", new Blob(["ciphertext piece"]));
  const t = transport();
  await vi.waitFor(() => expect(temporary()).toEqual([]));

  const { lease } = t as never as { lease: { id: string; directory(area: string): Promise<FileSystemDirectoryHandle> } };
  const pieces = await lease.directory("room-v2-pieces");
  await (await (await pieces.getFileHandle("0", { create: true })).createWritable()).close();
  expect(temporary()).toEqual([`room-v2-pieces/${lease.id}/0`]);
  t.resetTransfers();
  await vi.waitFor(() => expect(temporary()).toEqual([]));
});

it("fails closed without OPFS instead of seeding plaintext", async () => {
  vi.stubGlobal("navigator", { storage: {} });
  await expect(transport().seedEncryptedFiles([new File(["secret"], "name")])).rejects.toThrow("storage support");
  expect(seeds).toHaveLength(0);
});

it("cancels a delayed encrypted restore on reset while preserving durable ciphertext for the new session", async () => {
  const { descriptor, original } = await offer();
  const receiver = transport();
  const downloaded = vi.fn(); receiver.on("downloaded", downloaded);
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(r => { release = r; });
  const decrypting = new Promise<void>(r => { entered = r; });
  const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    entered(); await paused; return decrypt(...args);
  });
  const pending = receiver.restoreEncryptedFile(descriptor);
  const rejected = expect(pending).rejects.toThrow();
  await decrypting;
  receiver.resetTransfers();
  release(); await rejected; spy.mockRestore();
  expect(downloaded).not.toHaveBeenCalled(); expect(receiver.getTransfers()).toEqual([]);
  expect(await receiver.restoreEncryptedFile(descriptor)).toBe(true);
  expect(await downloaded.mock.calls[0][1].text()).toBe(await original.text());
});
