// Third-round review (wp02-files): a room open gives every row of 5 MB or
// less that lacks its copy of the file one, read from this device's durable
// ciphertext with no decrypt (_keepRowCopies) - and with no look at whether
// that durable copy is whole. writeCiphertext creates its entry before the
// bytes are committed, so a tab closed while a finished download was being
// kept leaves an empty room-v2-ciphertext/<infoHash>. A room open then
// copied that into the row: marked "complete", carrying 0 bytes where
// putAttachment and a backup import both demand the whole ciphertext, and
// counted as holding the file - so an ask nobody made (a message arriving
// again, a peer announcing it) left it "held" instead of fetching it again.
//
// Real modules: storage.ts (fake-indexeddb, at-rest crypto from
// test-setup), files.svelte.ts, webtorrent.ts (WebTorrentFileTransport),
// file-staging and file-crypto. Mocked: webtorrent's own client,
// simple-peer, transport.svelte (libp2p), OPFS (in memory).
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fakeOPFS } from "./file/opfs-test-helper";

const s = vi.hoisted(() => ({ added: [] as string[] }));

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

const transportState = vi.hoisted(() => ({
  roomCode: "rd2_room" as string | null,
  messages: [] as unknown[],
  fileTransfers: new Map<string, { blobURL?: string }>(),
}));
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  _transport: {},
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState,
}));

import { getAttachment, putAttachment, wipeLocalDatabase } from "$lib/storage";
import type { FileEntry } from "$lib/types/message";
import { WebTorrentFileTransport } from "./file/webtorrent";
import { _hydrateAndSeedAttachments, _resetAttachmentHydration, initFiles } from "./files.svelte";

const disk = fakeOPFS();
let transport: WebTorrentFileTransport;
beforeAll(() => {
  vi.stubGlobal("navigator", { storage: disk.storage });
  transport = new WebTorrentFileTransport(() => "me");
  initFiles(transport);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(async () => {
  _resetAttachmentHydration();
  await wipeLocalDatabase();
  s.added.length = 0;
  transportState.fileTransfers = new Map();
});

/** A picture this device kept in an earlier session, and its row, which
 *  never got its copy of the file. */
async function keptPicture(fill: number): Promise<FileEntry> {
  const earlier = new WebTorrentFileTransport(() => "earlier-session");
  const [descriptor] = await earlier.seedEncryptedFiles([
    new File([new Uint8Array(2000).fill(fill)], `photo-${fill}.png`, { type: "image/png" }),
  ]);
  earlier.destroy();
  await putAttachment({
    id: `row-${fill}`, roomCode: "rd2_room", messageId: `m-${fill}`, filename: descriptor.filename,
    mimeType: descriptor.mimeType, size: descriptor.size, infoHash: descriptor.infoHash,
    status: "downloading", createdAt: fill, encryption: descriptor.encryption,
  });
  return descriptor;
}

it("gives a row the copy of a whole durable file, never the empty one a write cut short leaves", async () => {
  const whole = await keptPicture(1);
  const cut = await keptPicture(2);
  // The tab went away while this finished download was being kept.
  disk.entries.set(`room-v2-ciphertext/${cut.infoHash}`, new Blob());
  await _hydrateAndSeedAttachments("rd2_room");
  // One file at a time, newest first: the cut one is settled by then.
  await vi.waitFor(async () =>
    expect((await getAttachment("row-1"))?.data?.byteLength)
      .toBe(disk.entries.get(`room-v2-ciphertext/${whole.infoHash}`)!.size));
  const row = await getAttachment("row-2");
  expect(row?.data).toBeUndefined();
  expect(row?.status).toBe("downloading");
  // A message naming it arriving again: it is not here, so it is fetched.
  transport.ensureDownload(cut);
  await vi.waitFor(() => expect(s.added).toContain(cut.infoHash));
});
