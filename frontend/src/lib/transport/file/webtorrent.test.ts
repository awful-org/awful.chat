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
    connected = false;
    /** What was handed to signal(), in order. */
    signals: unknown[] = [];
    constructor() {
      super();
      livePeers.push(this as never);
    }
    signal(s: unknown): void {
      this.signals.push(s);
    }
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

  it("a seed serving block after block has nothing new to tell the app", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    await t.seedFiles([new File([new Uint8Array(10)], "cat.png", { type: "image/png" })]);
    const torrent = torrents.get(HASH)!;
    torrent.progress = 1;
    const snapshots: unknown[] = [];
    t.on("transfer", (s) => snapshots.push(s));
    // A request in, a header and a block out: three reports per 16 KiB.
    for (let i = 0; i < 300; i++) torrent.emit(i % 3 ? "upload" : "download");
    await new Promise((r) => setTimeout(r, 300));
    expect(snapshots).toHaveLength(0);
    expect(t.getTransfer(HASH)?.status).toBe("seeding");
  });

  it("a download's progress becomes a snapshot at most every quarter second", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.ensureDownload(file);
    await tick();
    await tick();
    const torrent = torrents.get(HASH)!;
    const snapshots: Array<{ progress: number }> = [];
    t.on("transfer", (s) => snapshots.push(s));
    vi.useFakeTimers();
    try {
      for (let i = 1; i <= 300; i++) {
        torrent.progress = i / 300;
        torrent.emit("download");
      }
      expect(snapshots).toHaveLength(1);
      vi.advanceTimersByTime(250);
      // The latest progress, not the second report's.
      expect(snapshots.map((s) => s.progress)).toEqual([1 / 300, 1]);
      vi.advanceTimersByTime(1_000);
      expect(snapshots).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("dials two holders of one file at a time, not all of them", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    for (let i = 0; i < 50; i++) {
      const peerId = `peer${i}`;
      t.onPeerConnect(peerId);
      t.registerSeeder(file, peerId);
    }
    t.ensureDownload(file);
    await tick();
    const links = (t as never as { wtPeers: Map<string, EventEmitter> }).wtPeers;
    // The author (learned first) and one spare.
    expect([...links.keys()]).toEqual([`${HASH}:peer0`, `${HASH}:peer1`]);

    // A holder that does not answer makes room for the next one.
    links.get(`${HASH}:peer0`)!.emit("error", new Error("ice failed"));
    (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
    expect([...links.keys()]).toEqual([`${HASH}:peer1`, `${HASH}:peer2`]);
    t.destroy();
  });

  it("caps the links it dials, however many files a room holds", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    // Four holders so the per-peer ceiling is not what stops it.
    for (const peerId of ["a", "b", "c", "d"]) t.onPeerConnect(peerId);
    for (let i = 0; i < 40; i++) {
      const desc = { ...file, infoHash: (i + 1).toString(16).padStart(40, "0") };
      for (const peerId of ["a", "b", "c", "d"]) t.registerSeeder(desc, peerId);
      t.ensureDownload(desc);
    }
    await tick();
    expect(livePeers.length).toBe(24);
    t.destroy();
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

  it.each(["image/png", "application/octet-stream"])("completed %s downloads free slots for queued large files", async (mimeType) => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    const files = Array.from({ length: 9 }, (_, i) => ({
      ...file, infoHash: (i + 1).toString(16).padStart(40, "0"),
      filename: `large-${i}`, mimeType, size: 1024 * 1024,
    }));
    for (const desc of files) {
      t.registerSeeder(desc, "alice");
      t.ensureDownload(desc);
    }
    await tick();
    await tick();
    const peers = (t as never as { wtPeers: Map<string, EventEmitter & { destroyed: boolean }> }).wtPeers;
    expect(peers.size).toBe(8);
    const firstKey = `${files[0].infoHash}:alice`;
    const first = peers.get(firstKey)!;
    const queuedKey = `${files[8].infoHash}:alice`;
    expect(peers.has(queuedKey)).toBe(false);
    const torrent = torrents.get(files[0].infoHash)!;
    const blob = new Blob([new Uint8Array(files[0].size)], { type: mimeType });
    torrent.files = [{ getBlob: (cb: (err: null, blob: Blob) => void) => cb(null, blob) }];
    const downloaded = vi.fn();
    t.on("downloaded", downloaded);
    torrent.done = true;
    torrent.progress = 1;
    torrent.emit("done");
    expect(first.destroyed).toBe(true);
    expect(peers.has(firstKey)).toBe(false);
    expect(peers.has(queuedKey)).toBe(true);
    expect(peers.size).toBe(8);
    expect(downloaded).toHaveBeenCalledWith(files[0].infoHash, blob);
    expect(t.getTransfer(files[0].infoHash)?.blobURL).toBeTruthy();
    // Releasing a wire must not remove the torrent or the downloaded bytes.
    expect(torrents.get(files[0].infoHash)).toBe(torrent);
    t.handleSignal("bob", {
      kind: "file-wt-signal", infoHash: files[0].infoHash, signal: { type: "offer" },
    } as never);
    peers.get(`${files[0].infoHash}:bob`)!.emit("connect");
    await tick();
    expect(addedPeers.some((peer) => peer.id === "bob")).toBe(true);
    t.destroy();
  });

  it("late close and error events cannot remove a replacement file link", async () => {
    const t = new WebTorrentFileTransport(() => "me");
    t.onPeerConnect("alice");
    t.registerSeeder(file, "alice");
    t.ensureDownload(file);
    await tick();
    const peers = (t as never as { wtPeers: Map<string, EventEmitter> }).wtPeers;
    const key = `${HASH}:alice`;
    const old = peers.get(key)!;
    (iceServerList as never as { __fireIceServersChanged: () => void }).__fireIceServersChanged();
    const replacement = peers.get(key)!;
    expect(replacement).not.toBe(old);
    old.emit("close");
    old.emit("error", new Error("late ICE failure"));
    expect(peers.get(key)).toBe(replacement);
    t.destroy();
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

  it("shows a protected file this device holds instead of fetching it again", async () => {
    // A hash of its own: other tests' fake adds land in the shared map late.
    const hash = "e".repeat(40);
    const encrypted = {
      ...file,
      infoHash: hash,
      encryption: { version: 2, key: "A".repeat(43), id: "A".repeat(22), size: 10, chunkSize: 1024 * 1024 },
    } as never;
    const t = new WebTorrentFileTransport(() => "me");
    const held = new Set([hash]);
    const restore = vi.fn(async (infoHash: string) => held.has(infoHash));
    t.setLocalFileLookup(async () => null, restore);
    t.onPeerConnect("alice");
    t.registerSeeder(encrypted, "alice");
    t.ensureDownload(encrypted, { retry: true });
    t.ensureDownload(encrypted); // asked twice while looking: one look
    await tick();
    await tick();
    expect(restore).toHaveBeenCalledOnce();
    expect(addCalls).toEqual([]);
    expect(livePeers.length).toBe(0);

    // Not here after all: fetched, as before.
    held.clear();
    t.ensureDownload(encrypted, { retry: true });
    await vi.waitFor(() => expect(addCalls).toEqual([hash]));
    expect(livePeers.length).toBe(1);
    expect(t.getTransfer(hash)?.status).toBe("downloading");
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
      signal: { type: "offer" },
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
    t.handleSignal("alice", { kind: "file-wt-signal", infoHash: HASH, signal: { type: "offer" } } as never);
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

  describe("dial sessions", () => {
    type Peer = EventEmitter & {
      destroyed: boolean;
      connected: boolean;
      signals: unknown[];
      destroy(): void;
    };
    const linksOf = (t: unknown) =>
      (t as { wtPeers: Map<string, Peer> }).wtPeers;
    const key = `${HASH}:alice`;
    const sig = (signal: unknown, session?: string) =>
      ({ kind: "file-wt-signal", infoHash: HASH, signal, session }) as never;

    it("a retry's offer replaces what the sender has left of the last one", () => {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      t.handleSignal("alice", sig({ type: "offer" }, "one"));
      const first = linksOf(t).get(key)!;

      t.handleSignal("alice", sig({ type: "offer" }, "two"));
      const second = linksOf(t).get(key)!;
      expect(first.destroyed).toBe(true);
      expect(second).not.toBe(first);
      // The new offer went to the new link, not into the dead one.
      expect(second.signals).toEqual([{ type: "offer" }]);
      t.destroy();
    });

    it("ignores the tail of an attempt that was replaced", () => {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      t.handleSignal("alice", sig({ type: "offer" }, "one"));
      t.handleSignal("alice", sig({ type: "offer" }, "two"));
      const current = linksOf(t).get(key)!;

      t.handleSignal("alice", sig({ type: "candidate" }, "one"));
      t.handleSignal("alice", sig({ type: "offer" }, "one"));
      expect(linksOf(t).get(key)).toBe(current);
      expect(current.signals).toEqual([{ type: "offer" }]);
      t.destroy();
    });

    it("builds nothing for an answer or candidate with no link to land on", () => {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      t.handleSignal("alice", sig({ type: "answer" }, "gone"));
      t.handleSignal("alice", sig({ type: "candidate" }));
      expect(linksOf(t).size).toBe(0);
      t.destroy();
    });

    it("stamps the dialler's session on its signals and keeps other sessions off its link", async () => {
      const t = new WebTorrentFileTransport(() => "me");
      const sent: Array<{ session?: string }> = [];
      t.on("signal", (_peer, envelope) => sent.push(envelope as never));
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      await tick();
      const link = linksOf(t).get(key)!;
      link.emit("signal", { type: "offer" });
      const session = sent.at(-1)?.session;
      expect(session).toMatch(/^[0-9a-f]{12}$/);

      t.handleSignal("alice", sig({ type: "answer" }, "someone-else"));
      expect(link.signals).toEqual([]);
      t.handleSignal("alice", sig({ type: "answer" }, session));
      expect(link.signals).toEqual([{ type: "answer" }]);
      t.destroy();
    });

    it("drops a late answer for its own dial once that dial is over", async () => {
      const t = new WebTorrentFileTransport(() => "me");
      const sent: Array<{ session?: string }> = [];
      t.on("signal", (_peer, envelope) => sent.push(envelope as never));
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      await tick();
      const link = linksOf(t).get(key)!;
      link.emit("signal", { type: "offer" });
      const session = sent.at(-1)?.session;
      link.destroy();

      t.handleSignal("alice", sig({ type: "answer" }, session));
      expect(linksOf(t).size).toBe(0);
      t.destroy();
    });

    it("still talks to a client that sends no session", () => {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      t.handleSignal("alice", sig({ type: "offer" }));
      const first = linksOf(t).get(key)!;
      t.handleSignal("alice", sig({ type: "candidate" }));
      expect(first.signals).toEqual([{ type: "offer" }, { type: "candidate" }]);

      // A fresh offer while the old link never connected: a new attempt.
      t.handleSignal("alice", sig({ type: "offer" }));
      expect(first.destroyed).toBe(true);
      expect(linksOf(t).get(key)).not.toBe(first);
      t.destroy();
    });
  });

  describe("a busy room", () => {
    type Link = EventEmitter & { destroyed: boolean; signals: unknown[]; destroy(): void };
    const linksOf = (t: unknown) => (t as { wtPeers: Map<string, Link> }).wtPeers;
    const hashOf = (i: number) => (i + 1).toString(16).padStart(40, "0");

    /** Fill our dialling budget: 24 downloads across three holders. */
    function fillDials(t: InstanceType<typeof WebTorrentFileTransport>) {
      for (const peerId of ["a", "b", "c"]) t.onPeerConnect(peerId);
      for (let i = 0; i < 24; i++) {
        const desc = { ...file, infoHash: hashOf(i) };
        const holder = ["a", "b", "c"][i % 3];
        t.registerSeeder(desc, holder);
        t.ensureDownload(desc);
      }
      expect(linksOf(t).size).toBe(24);
    }

    it("still serves while its own downloads fill their budget", () => {
      const t = new WebTorrentFileTransport(() => "me");
      fillDials(t);
      t.onPeerConnect("bob");
      t.handleSignal("bob", {
        kind: "file-wt-signal",
        infoHash: HASH,
        signal: { type: "offer" },
        session: "s1",
      } as never);
      // The image we just sent reaches bob although we are busy catching up.
      expect(linksOf(t).has(`${HASH}:bob`)).toBe(true);
      t.destroy();
    });

    it("answers busy instead of dropping an offer it has no room for", () => {
      const t = new WebTorrentFileTransport(() => "me");
      const sent: Array<{ peer: string; envelope: { signal: unknown; session?: string } }> = [];
      t.on("signal", (peer, envelope) => sent.push({ peer, envelope: envelope as never }));
      for (let i = 0; i < 24; i++) {
        const peer = `p${i}`;
        t.onPeerConnect(peer);
        t.handleSignal(peer, {
          kind: "file-wt-signal",
          infoHash: HASH,
          signal: { type: "offer" },
          session: `s${i}`,
        } as never);
      }
      expect(linksOf(t).size).toBe(24);

      t.onPeerConnect("late");
      t.handleSignal("late", {
        kind: "file-wt-signal",
        infoHash: HASH,
        signal: { type: "offer" },
        session: "late-session",
      } as never);
      expect(linksOf(t).has(`${HASH}:late`)).toBe(false);
      expect(sent.at(-1)).toEqual({
        peer: "late",
        envelope: {
          kind: "file-wt-signal",
          infoHash: HASH,
          signal: { type: "busy" },
          session: "late-session",
        },
      });
      t.destroy();
    });

    it("hears busy as a wait, not a failed attempt", async () => {
      const t = new WebTorrentFileTransport(() => "me");
      const sent: Array<{ session?: string }> = [];
      t.on("signal", (_peer, envelope) => sent.push(envelope as never));
      t.onPeerConnect("alice");
      t.registerSeeder(file, "alice");
      t.ensureDownload(file);
      await tick();
      const key = `${HASH}:alice`;
      const link = linksOf(t).get(key)!;
      link.emit("signal", { type: "offer" });
      const session = sent.at(-1)?.session;

      t.handleSignal("alice", {
        kind: "file-wt-signal",
        infoHash: HASH,
        signal: { type: "busy" },
        session,
      } as never);
      expect(link.destroyed).toBe(true);
      const internals = t as never as {
        wtAttempts: Map<string, number>;
        wtNextTry: Map<string, number>;
      };
      expect(internals.wtAttempts.get(key)).toBe(0);
      expect(internals.wtNextTry.get(key)!).toBeGreaterThan(Date.now() + 5_000);
      expect(t.getTransfer(HASH)?.status).toBe("downloading");
      t.destroy();
    });

    it("gives a free slot to the newest download first", () => {
      const t = new WebTorrentFileTransport(() => "me");
      t.onPeerConnect("alice");
      // Eight downloads from alice: her share of our table.
      for (let i = 0; i < 8; i++) {
        const desc = { ...file, infoHash: hashOf(i) };
        t.registerSeeder(desc, "alice");
        t.ensureDownload(desc);
      }
      // Two more wait for a slot: an old one, then the image just sent.
      const older = { ...file, infoHash: hashOf(100) };
      const newest = { ...file, infoHash: hashOf(101) };
      for (const desc of [older, newest]) {
        t.registerSeeder(desc, "alice");
        t.ensureDownload(desc);
      }
      const links = linksOf(t);
      expect(links.has(`${newest.infoHash}:alice`)).toBe(false);

      links.get(`${hashOf(0)}:alice`)!.destroy();
      (t as never as { reconcileWtPeers: () => void }).reconcileWtPeers();
      expect(links.has(`${newest.infoHash}:alice`)).toBe(true);
      expect(links.has(`${older.infoHash}:alice`)).toBe(false);
      t.destroy();
    });
  });
});
