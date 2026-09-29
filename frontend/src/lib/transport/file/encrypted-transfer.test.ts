import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "./opfs-test-helper";
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
  expect(seeds[0].opts.store).toBeTruthy();
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
  expect(seeds[1].file.name).toBe(seeds[0].file.name);
  expect(await seeds[1].file.arrayBuffer()).toEqual(bytes);
  expect(restarted.getTransfer(descriptor.infoHash)?.blobURL).toBeTruthy();
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
