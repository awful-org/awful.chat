import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "$lib/transport/file/opfs-test-helper";
import { newRoomSecret, deriveRoomKeys } from "$lib/room-security/keys";
import type { FileDescriptor } from "$lib/transport/types";

// The quick controller, encryption, staging, descriptor and torrent lifecycle
// are real. Replace only browser disk/network devices with deterministic peers.
class Torrent extends EventEmitter {
  infoHash = ""; done = false; progress = 0; numPeers = 0;
  length?: number; files: any[] = []; destroyed = false;
  destroy() { this.destroyed = true; }
}
const clients: Client[] = [];
const seeded: File[] = [];
class Client {
  torrents = new Map<string, Torrent>();
  constructor() { clients.push(this); }
  get(hash: string) { return this.torrents.get(hash); }
  add(hash: string) { const t = new Torrent(); t.infoHash = hash; this.torrents.set(hash, t); return t; }
  seed(file: File, opts: any, cb: (t: Torrent) => void) {
    seeded.push(file); const t = new Torrent();
    void file.arrayBuffer().then(bytes => {
      t.infoHash = createHash("sha1").update(file.name).update(String(opts.pieceLength)).update(new Uint8Array(bytes)).digest("hex");
      t.done = true; t.length = file.size; t.files = [{ name: file.name }];
      this.torrents.set(t.infoHash, t); cb(t);
    }); return t;
  }
  destroy(cb: () => void) { for (const t of this.torrents.values()) t.destroy(); cb(); }
}
class Peer extends EventEmitter { signal() {} destroy() { this.emit("close"); } }
vi.mock("webtorrent", () => ({ default: Client }));
vi.mock("simple-peer", () => ({ default: Peer }));
vi.mock("$lib/transport/ice-server-list", () => ({ getIceServers: () => [], onIceServersChanged: () => () => {}, refreshTurnCredentials: async () => {} }));
vi.mock("$lib/telemetry/recorder", () => ({ rec: () => {}, refs: () => ({ fileRef: () => "file" }) }));
vi.mock("$lib/runtime-config", () => ({ isConfigured: () => true }));
const SECRET = newRoomSecret(); const ROOM = deriveRoomKeys(SECRET).discoveryId;
class Transport extends EventEmitter {
  members = new Set<string>();
  sendRoom = vi.fn(async (_peer: string, _room: string, _data: Uint8Array) => true);
  async connect() {} async disconnect() {} joinSecureRoom() {} leaveRoom() {}
  selfId() { return "self"; }
  isRoomPeer(room: string, peer: string) { return room === ROOM && this.members.has(peer); }
  peersInRoom() { return [...this.members]; }
  message(payload: unknown, room = ROOM) { this.emit("message", "friend", new TextEncoder().encode(JSON.stringify(payload)), room); }
}
let network: Transport;
vi.mock("$lib/transport/libp2p/transport", () => ({ LibP2PTransport: class { constructor() { return network; } } }));
let qs: typeof import("./quick-send.svelte");
let disk: ReturnType<typeof fakeOPFS>;
beforeEach(async () => {
  vi.resetModules(); clients.length = 0; seeded.length = 0; network = new Transport();
  disk = fakeOPFS(); vi.stubGlobal("navigator", disk);
  qs = await import("./quick-send.svelte"); await qs.startQuickSend(SECRET);
  network.members.add("friend"); network.emit("roomPeers", ROOM, ["friend"]);
});
afterEach(() => { qs.stopQuickSend(); vi.unstubAllGlobals(); });
function messages() { return network.sendRoom.mock.calls.map(([, room, bytes]) => ({ room, payload: JSON.parse(new TextDecoder().decode(bytes)) })); }
async function encryptedOffer() {
  const { WebTorrentFileTransport } = await import("$lib/transport/file/webtorrent");
  const sender = new WebTorrentFileTransport(() => "sender");
  const [file] = await sender.seedEncryptedFiles([new File(["SECRET SENTINEL"], "private-diagnosis.txt", { type: "text/plain" })]);
  const bytes = await sender.persistableCiphertext(file.infoHash, 1000); sender.destroy();
  return { file, bytes: bytes! };
}
async function receive(file: FileDescriptor, bytes: ArrayBuffer) {
  const count = clients.length;
  network.message({ type: "__file_signal", payload: { kind: "file-seeder", file } });
  qs.acceptFile(file.infoHash);
  await vi.waitFor(() => {
    expect(clients.length).toBe(count + 1);
    expect(clients.at(-1)?.get(file.infoHash)).toBeTruthy();
  });
  const t = clients.at(-1)!.get(file.infoHash)!;
  t.length = bytes.byteLength;
  t.files = [{ name: `${file.encryption!.id}.bin`, async *createReadStream() { yield new Uint8Array(bytes); } }];
  t.emit("metadata"); t.done = true; t.emit("done");
}
it("quick offers seed opaque ciphertext, announce protected keys and delete owned ciphertext on stop", async () => {
  await qs.offerFiles([new File(["SECRET SENTINEL"], "private-diagnosis.txt")]);
  const file = qs.quickSend.offered[0]; expect(file.encryption).toBeTruthy();
  expect(seeded[0].name).toBe(`${file.encryption!.id}.bin`);
  expect(await seeded[0].text()).not.toContain("SECRET SENTINEL");
  expect(messages()).toContainEqual({ room: ROOM, payload: { type: "__file_signal", payload: { kind: "file-seeder", file } } });
  expect(disk.entries.has(`room-v2-ciphertext/${file.infoHash}`)).toBe(true);
  qs.stopQuickSend(); await vi.waitFor(() => expect(disk.entries.has(`room-v2-ciphertext/${file.infoHash}`)).toBe(false));
  expect(clients[0].get(file.infoHash)?.destroyed).toBe(true);
});
it("quick receiver authenticates then reannounces identical ciphertext without a second plaintext seed", async () => {
  const { file, bytes } = await encryptedOffer(); await receive(file, bytes);
  await vi.waitFor(() => expect(qs.quickSend.transfers.get(file.infoHash)?.done).toBe(true));
  const url = qs.quickSend.transfers.get(file.infoHash)!.blobURL!;
  expect(await (await fetch(url)).text()).toBe("SECRET SENTINEL");
  expect(seeded).toHaveLength(1);
  expect(messages()).toContainEqual({ room: ROOM, payload: { type: "__file_signal", payload: { kind: "file-seeder", file } } });
  network.members.add("later"); network.emit("roomPeers", ROOM, ["friend", "later"]);
  expect(network.sendRoom.mock.calls.some(([peer, , raw]) => peer === "later" && new TextDecoder().decode(raw).includes(file.encryption!.key))).toBe(true);
});
it("wrong-room offers and corrupted ciphertext never produce a download URL or acknowledgement", async () => {
  const { file, bytes } = await encryptedOffer();
  network.message({ type: "__file_signal", payload: { kind: "file-seeder", file } }, "rd2_wrong" as typeof ROOM);
  expect(qs.quickSend.incoming).toEqual([]);
  const damaged = new Uint8Array(bytes.slice(0)); damaged[0] ^= 1;
  await receive(file, damaged.buffer);
  await vi.waitFor(() => expect(qs.quickSend.transfers.get(file.infoHash)?.status).toBe("failed"));
  expect(qs.quickSend.transfers.get(file.infoHash)?.blobURL).toBeUndefined();
  expect(messages().some(m => m.payload.type === "__qs_ack")).toBe(false);
  expect(seeded).toHaveLength(1);
});
