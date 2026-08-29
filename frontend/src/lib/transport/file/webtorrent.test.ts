import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HASH = "a".repeat(40);
const addedPeers: Array<{ id?: string }> = [];

class FakeTorrent extends EventEmitter {
  infoHash = "";
  progress = 0;
  done = false;
  numPeers = 0;
  files: unknown[] = [];
  addPeer(peer: { id?: string }): boolean {
    addedPeers.push(peer);
    return true;
  }
}

const torrents = new Map<string, FakeTorrent>();

vi.mock("simple-peer", () => {
  class FakePeer extends EventEmitter {
    destroyed = false;
    signal(): void {}
    destroy(): void {
      this.destroyed = true;
      this.emit("close");
    }
  }
  return { default: FakePeer };
});

vi.mock("webtorrent", () => {
  class FakeClient {
    get(infoHash: string) {
      return torrents.get(infoHash) ?? null;
    }
    add(infoHash: string) {
      const torrent = new FakeTorrent();
      torrent.infoHash = infoHash;
      torrents.set(infoHash, torrent);
      return torrent;
    }
    seed(_file: File, _opts: unknown, cb: (t: FakeTorrent) => void) {
      const torrent = new FakeTorrent();
      torrent.infoHash = HASH;
      torrent.done = true;
      torrents.set(HASH, torrent);
      cb(torrent);
      return torrent;
    }
    destroy(cb: () => void) {
      cb();
    }
  }
  return { default: FakeClient };
});

vi.mock("../ice-server-list", () => ({ getIceServers: () => [] }));

const { WebTorrentFileTransport } = await import("./webtorrent");

const file = {
  infoHash: HASH,
  filename: "cat.png",
  mimeType: "image/png",
  size: 10,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WebTorrentFileTransport", () => {
  beforeEach(() => {
    addedPeers.length = 0;
    torrents.clear();
  });

  it("gives every wire a distinct id so webtorrent can hold more than one", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.onPeerConnect("bob");
    t.registerSeeder(file, "alice");
    t.registerSeeder(file, "bob");
    t.ensureDownload(file);
    await tick();

    const peers = (t as never as { wtPeers: Map<string, EventEmitter> }).wtPeers;
    expect(peers.size).toBe(2);
    for (const peer of peers.values()) peer.emit("connect");
    await tick();

    // Two wires, two ids: keyed on `undefined` the second overwrote the first.
    expect(addedPeers).toHaveLength(2);
    expect(new Set(addedPeers.map((p) => p.id))).toEqual(
      new Set(["alice", "bob"])
    );
  });

  it("restarts a download when a seeder comes back after failing it", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.registerSeeder(file, "alice");
    t.ensureDownload(file);
    await tick();
    expect(t.getTransfer(HASH)?.status).toBe("downloading");

    t.onPeerDisconnect("alice");
    expect(t.getTransfer(HASH)?.status).toBe("failed");

    t.onPeerConnect("alice");
    t.registerSeeder(file, "alice");
    expect(t.getTransfer(HASH)?.status).toBe("downloading");
  });

  it("seeds a stored file on demand when a peer dials for it", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.setLocalFileLookup(async () =>
      new File([new Uint8Array(10)], "cat.png", { type: "image/png" })
    );
    // No ensureDownload and no seedFiles: this file belongs to a conversation
    // we never opened, so nothing has built a torrent for it.
    t.onPeerConnect("alice");
    t.handleSignal("alice", {
      kind: "file-wt-signal",
      infoHash: HASH,
      signal: {},
    } as never);

    const peers = (t as never as { wtPeers: Map<string, EventEmitter> }).wtPeers;
    expect(peers.size).toBe(1);
    [...peers.values()][0].emit("connect");
    await tick();

    expect(torrents.has(HASH)).toBe(true);
    expect(addedPeers.map((p) => p.id)).toEqual(["alice"]);
  });

  it("caps the distinct infoHashes a single peer may register", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    // None of these ever start a transfer, so every registration is inert
    // and eligible for eviction - the peer should never exceed the cap.
    for (let i = 0; i < 70; i++) {
      const infoHash = i.toString(16).padStart(40, "0");
      t.registerSeeder({ ...file, infoHash }, "alice");
    }
    const peerSeeded = (
      t as never as { peerSeeded: Map<string, Set<string>> }
    ).peerSeeded;
    expect(peerSeeded.get("alice")?.size).toBe(64);
    // The oldest registrations were evicted, the newest kept.
    const last = (69).toString(16).padStart(40, "0");
    const first = (0).toString(16).padStart(40, "0");
    expect(peerSeeded.get("alice")?.has(last)).toBe(true);
    expect(peerSeeded.get("alice")?.has(first)).toBe(false);
  });

  it("does not evict an infoHash with an active transfer under the per-peer cap", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    const activeHash = "b".repeat(40);
    t.registerSeeder({ ...file, infoHash: activeHash }, "alice");
    t.onPeerConnect("alice");
    t.ensureDownload({ ...file, infoHash: activeHash });
    await tick();
    expect(t.getTransfer(activeHash)?.status).toBe("downloading");

    for (let i = 0; i < 70; i++) {
      const infoHash = i.toString(16).padStart(40, "1");
      t.registerSeeder({ ...file, infoHash }, "alice");
    }

    const peerSeeded = (
      t as never as { peerSeeded: Map<string, Set<string>> }
    ).peerSeeded;
    // The active transfer survives even though the cap was hit repeatedly.
    expect(peerSeeded.get("alice")?.has(activeHash)).toBe(true);
  });
});
