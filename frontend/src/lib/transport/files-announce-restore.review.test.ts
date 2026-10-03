// Second-round review (wp02-files): the 64 MB room-open budget bounds one
// door into memory, not all of them. A peer that binds announces every file
// it holds in every room it shares with us (_announceStoredFilesTo, on every
// bind). The file-seeder handler in transport.svelte.ts then calls
// ensureDownload for each one we also hold a row for, and ensureDownload now
// answers a held protected file with the local restore: the whole file is
// decrypted into memory - for a room nobody opened, with no budget at all.
// A file this device already holds needs nothing from an announce.
//
// Real modules: transport.svelte.ts (the message handler), files.svelte.ts,
// webtorrent.ts (WebTorrentFileTransport), file-staging and file-crypto.
// Mocked: libp2p, webtorrent's own client, IndexedDB rows, OPFS (in memory).
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fakeOPFS } from "./file/opfs-test-helper";

const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rows: [] as any[],
  added: [] as string[],
  decrypts: 0,
}));

class Torrent extends EventEmitter {
  infoHash = ""; done = false; progress = 0; numPeers = 0; length?: number; files: any[] = [];
  destroy() {}
}
class Client {
  torrents = new Map<string, Torrent>();
  get(hash: string) { return this.torrents.get(hash); }
  add(hash: string) { s.added.push(hash); const t = new Torrent(); t.infoHash = hash; this.torrents.set(hash, t); return t; }
  seed(file: File, opts: any, cb: (t: Torrent) => void) {
    const t = new Torrent();
    void file.arrayBuffer().then((bytes) => {
      t.infoHash = createHash("sha1").update(file.name).update(String(opts.pieceLength)).update(new Uint8Array(bytes)).digest("hex");
      t.length = file.size; t.done = true; t.files = [{ name: file.name }];
      this.torrents.set(t.infoHash, t);
      cb(t);
    });
    return t;
  }
  destroy(cb: () => void) { cb(); }
}
vi.mock("webtorrent", () => ({ default: Client }));
vi.mock("simple-peer", () => ({ default: class extends EventEmitter {} }));
vi.mock("$lib/room-security/file-staging", async (original) => {
  const real = await original<typeof import("$lib/room-security/file-staging")>();
  return {
    ...real,
    stageDecryptedFile: (...args: Parameters<typeof real.stageDecryptedFile>) => {
      s.decrypts += 1;
      return real.stageDecryptedFile(...args);
    },
  };
});

vi.mock("$lib/identity/identity", () => ({
  requireSession: () => ({ did: "did:alice" }),
  onIdentityLock: () => () => {},
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room"]; }
  peers() { return ["peer1"]; } peersInRoom() { return ["peer1"]; }
  isRoomPeer(room: string, peer: string) { return room === "rd2_room" && peer === "peer1"; }
  isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
  send = async () => true; sendRoom = async () => true; leaveRoom() {}
  broadcast() {} disconnect() {}
} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class { setCallPeers() {} } }));
vi.mock("./mediasoup", () => ({ MediasoupVideo: class {
  setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {}
} }));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachment: async (id: string) => s.rows.find((r) => r.id === id),
  getAttachmentsByInfoHash: async (hash: string) => s.rows.filter((r) => r.infoHash === hash),
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async () => s.rows,
  putAttachment: async () => {},
  updateAttachmentStatus: async () => {},
  updateAttachmentData: async () => {},
}));
vi.mock("$lib/messaging", () => ({ signMessage: (m: any) => m, signPeerBinding: () => ({ bindingSig: "sig" }), verifyPeerBinding: async () => true }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, refreshDmRooms: async () => {}, roomsStore: { rooms: [], dmRooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ dmConversationCodeAsync: async () => "dm-peer", ensureDmRoomForPeer: async () => "dm-peer", dmPeerDid: () => "did:peer", flushQueuedDmForPeer: async () => {}, isDmRequestRoom: () => false, offerDmUpgrade: () => {} }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { _fileTransport, transportState } from "./transport.svelte";
import { WebTorrentFileTransport } from "./file/webtorrent";
import { removeCiphertext } from "./file/ciphertext-store";
import { AUTO_DOWNLOAD_MAX_BYTES } from "./files.svelte";
import { encode } from "$lib/utils";

it("a peer's inventory announce does not decrypt the held files of a room nobody opened", async () => {
  const disk = fakeOPFS();
  vi.stubGlobal("navigator", { storage: disk.storage });
  try {
    // Files this device holds from an earlier session (sent or downloaded):
    // the durable ciphertext is in OPFS, the rows in IndexedDB. A fourth was
    // never downloaded here: its row alone.
    const earlier = new WebTorrentFileTransport(() => "earlier-session");
    const size = 24 * 1024 * 1024;
    const pictures = [0, 1, 2, 3].map((i) => new File([new Uint8Array(size).fill(i + 1)], `photo-${i}.png`, { type: "image/png" }));
    const descriptors = await earlier.seedEncryptedFiles(pictures);
    earlier.destroy();
    const [notHeld] = descriptors.splice(3, 1);
    await removeCiphertext(notHeld.infoHash);
    s.rows = [...descriptors, notHeld].map((d, i) => ({
      id: `row-${i}`, roomCode: "rd2_room", messageId: `m-${i}`, filename: d.filename,
      mimeType: d.mimeType, size: d.size, infoHash: d.infoHash, status: i < 3 ? "seeding" : "pending",
      createdAt: i, encryption: d.encryption,
    }));
    // Another conversation is open; rd2_room is never opened, never hydrated.
    transportState.roomCode = "rd2_other";
    expect(descriptors.reduce((n, d) => n + d.size, 0)).toBeGreaterThan(AUTO_DOWNLOAD_MAX_BYTES);

    // peer1 binds and announces what it holds in the room we share with it.
    const onMessage = s.handlers.get("message")!;
    for (const file of [...descriptors, notHeld]) {
      onMessage("peer1", encode({ type: "__file_signal", payload: { kind: "file-seeder", file } }), "rd2_room");
    }
    // The file this device lacks is fetched: the announce path ran.
    await vi.waitFor(() => expect(s.added).toContain(notHeld.infoHash), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));

    // The ones it holds needed nothing: none decrypted into memory.
    expect(s.decrypts).toBe(0);
    for (const d of descriptors) {
      expect(transportState.fileTransfers.get(d.infoHash)?.blobURL).toBeUndefined();
      expect(_fileTransport.getTransfer(d.infoHash)?.blobURL).toBeUndefined();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}, 60_000);
