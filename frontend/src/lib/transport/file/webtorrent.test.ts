import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as iceServerList from "../ice-server-list";

const HASH = "a".repeat(40);
const addedPeers: Array<{ id?: string }> = [];
const livePeers: Array<unknown> = [];
const addCalls: string[] = [];

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
    constructor() {
      super();
      livePeers.push(this as never);
    }
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
      addCalls.push(infoHash);
      const torrent = new FakeTorrent();
      torrent.infoHash = infoHash;
      // webtorrent parses the torrent id asynchronously, so client.get() does
      // not find a just-added torrent on the same tick - the window a second
      // add() lands in and gets destroyed with "Cannot add duplicate torrent".
      setTimeout(() => torrents.set(infoHash, torrent), 0);
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

vi.mock("../ice-server-list", () => {
  // The real module notifies subscribers when TURN credentials land; the
  // transport rebuilds unconnected file links on that event. Capture the
  // subscriber so a test can fire it.
  let onChange: (() => void) | null = null;
  return {
    getIceServers: () => [],
    onIceServersChanged: (cb: () => void) => {
      onChange = cb;
      return () => {
        if (onChange === cb) onChange = null;
      };
    },
    __fireIceServersChanged: () => onChange?.(),
  };
});

const recorded: string[] = [];
vi.mock("../../telemetry/recorder", () => ({
  rec: (e: { kind: string }) => {
    recorded.push(e.kind);
  },
  refs: () => ({ fileRef: (h: string) => h }),
}));

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
    livePeers.length = 0;
    addCalls.length = 0;
    recorded.length = 0;
    torrents.clear();
  });

  it("a re-announce of a file already downloading neither redials nor re-requests", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.registerSeeder(file, "alice");
    t.ensureDownload(file);
    await tick();
    expect(livePeers.length).toBe(1);
    expect(recorded.filter((k) => k === "file.request")).toHaveLength(1);

    // The sender reconnects three times without ever disconnecting (two
    // tabs on one peerId): each time it announces its inventory again and
    // the transport asks for the file again.
    for (let i = 0; i < 3; i++) {
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
    }
    await tick();
    expect(livePeers.length).toBe(1);
    expect(recorded.filter((k) => k === "file.request")).toHaveLength(1);
  });

  it("gives a pair up after WT_MAX_ATTEMPTS and fails the transfer", async () => {
    vi.useFakeTimers();
    try {
      const t = new WebTorrentFileTransport(() => "me");
      const reconcile = () =>
        (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      // Every dial fails; the tick keeps redialling through the backoff.
      for (let i = 0; i < 12; i++) {
        (livePeers[livePeers.length - 1] as { destroy: () => void }).destroy();
        vi.advanceTimersByTime(60_000);
        reconcile();
        // A re-announce mid-way changes nothing either.
        t.registerSeeder(file, "alice");
        t.ensureDownload(file);
      }
      expect(livePeers.length).toBe(6);
      expect(t.getTransfer(HASH)?.status).toBe("failed");
      // Nor does another announce once it has been given up on.
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      expect(livePeers.length).toBe(6);
      expect(t.getTransfer(HASH)?.status).toBe("failed");

      // The user clicks the file: the count starts over.
      t.ensureDownload(file, { retry: true });
      expect(livePeers.length).toBe(7);
      expect(t.getTransfer(HASH)?.status).toBe("downloading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a link that neither connects nor fails", async () => {
    // The STUN-only-between-two-NATs case: ICE finds no path and the peer
    // just sits there. Nothing destroys it, so without a deadline the pair
    // is never redialled, the transfer never fails, and the file shows a
    // skeleton for the rest of the session.
    vi.useFakeTimers();
    try {
      const t = new WebTorrentFileTransport(() => "me");
      const reconcile = () =>
        (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      expect(livePeers.length).toBe(1);

      // Reconciling changes nothing while the dead link is still held.
      vi.advanceTimersByTime(20_000);
      reconcile();
      expect(livePeers.length).toBe(1);
      expect(t.getTransfer(HASH)?.status).toBe("downloading");

      // Past the deadline the link is dropped and dialling resumes, so the
      // pair can finally run out of attempts.
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(60_000);
        reconcile();
      }
      expect(livePeers.length).toBe(6);
      expect(t.getTransfer(HASH)?.status).toBe("failed");
      expect(t.getTransfer(HASH)?.error).toBe("Could not reach the sender");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a connected link alone when the deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      const peer = livePeers[0] as EventEmitter & { destroyed: boolean };
      peer.emit("connect");
      vi.advanceTimersByTime(120_000);
      expect(peer.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a seeded file stays seeding whatever the torrent's done flag says", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    await t.seedFiles([new File([new Uint8Array(10)], "cat.png", { type: "image/png" })]);
    expect(t.getTransfer(HASH)?.status).toBe("seeding");
    // webtorrent leaves `done` false on a seed; a peer connecting fires "wire".
    const torrent = torrents.get(HASH)!;
    torrent.done = false;
    torrent.emit("wire");
    expect(t.getTransfer(HASH)?.status).toBe("seeding");
    expect(t.getTransfer(HASH)?.done).toBe(true);
    // ...so the reconcile tick has nothing to dial for it.
    t.onPeerConnect("bob");
    t.registerSeeder(file, "bob");
    (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
    expect(livePeers.length).toBe(0);
  });

  it("a real disconnect starts the count over", async () => {
    vi.useFakeTimers();
    try {
      const t = new WebTorrentFileTransport(() => "me");
      const reconcile = () =>
        (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      for (let i = 0; i < 8; i++) {
        (livePeers[livePeers.length - 1] as { destroy: () => void }).destroy();
        vi.advanceTimersByTime(60_000);
        reconcile();
      }
      expect(livePeers.length).toBe(6);
      expect(t.getTransfer(HASH)?.status).toBe("failed");

      t.onPeerDisconnect("alice");
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      expect(t.getTransfer(HASH)?.status).toBe("downloading");
      expect(livePeers.length).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the WebRTC links a roomful of files can open at once", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    // One file, more seeders for it than the cap allows.
    for (let i = 0; i < 50; i++) {
      const peerId = `peer${i}`;
      t.onPeerConnect(peerId);
      t.registerSeeder(file, peerId);
    }
    t.ensureDownload(file);
    await tick();
    expect(livePeers.length).toBeLessThanOrEqual(32);
    expect(livePeers.length).toBe(32);
  });

  it("adds a torrent once when the same file is requested twice at once", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    // A message arriving and a seeder announcing both ask for the same file.
    t.ensureDownload(file);
    t.ensureDownload(file);
    await tick();
    await tick();
    expect(addCalls).toEqual([HASH]);
  });

  it("gives every wire a distinct id so webtorrent can hold more than one", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.onPeerConnect("bob");
    t.registerSeeder(file, "alice");
    t.registerSeeder(file, "bob");
    t.ensureDownload(file);
    await tick();
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

  it("redials an unconnected file link with TURN once the credentials land", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    const desc = { infoHash: HASH, filename: "cat.png", mimeType: "image/png", size: 10 };
    t.onPeerConnect("alice");
    t.registerSeeder(desc as never, "alice");
    // A dial that raced the credential fetch: built STUN-only, never connects.
    t.ensureDownload(desc as never);
    await tick();
    const peers = (t as never as { wtPeers: Map<string, EventEmitter & { destroyed: boolean; connected?: boolean }> }).wtPeers;
    expect(peers.size).toBe(1);
    const stunOnly = [...peers.values()][0];
    const dialsBefore = livePeers.length;

    (iceServerList as never as { __fireIceServersChanged: () => void }).__fireIceServersChanged();
    await tick();

    // The stale link is gone and a fresh one was dialled in its place.
    expect(stunOnly.destroyed).toBe(true);
    expect(livePeers.length).toBe(dialsBefore + 1);
    expect(peers.size).toBe(1);
    expect([...peers.values()][0]).not.toBe(stunOnly);
  });

  it("leaves an established file link alone when the credentials land", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.handleSignal("alice", { kind: "file-wt-signal", infoHash: HASH, signal: {} } as never);
    const peers = (t as never as { wtPeers: Map<string, EventEmitter & { destroyed: boolean; connected?: boolean }> }).wtPeers;
    const live = [...peers.values()][0];
    live.connected = true;

    (iceServerList as never as { __fireIceServersChanged: () => void }).__fireIceServersChanged();
    await tick();

    expect(live.destroyed).toBe(false);
    expect([...peers.values()][0]).toBe(live);
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
