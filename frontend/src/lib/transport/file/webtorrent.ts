import SimplePeer from "simple-peer";
import type { Instance as SimplePeerInstance } from "simple-peer";
import type WebTorrentType from "webtorrent";

type WTClient = InstanceType<typeof WebTorrentType>;
import type {
  FileDescriptor,
  FileSignalEnvelope,
  FileTransferEvents,
  FileTransferSnapshot,
  FileTransferTransport,
} from "../types";
import { getIceServers } from "../ice-server-list";

type TorrentLike = {
  infoHash: string;
  name?: string;
  length?: number;
  progress: number;
  done: boolean;
  numPeers?: number;
  files?: Array<{
    getBlob: (cb: (err: unknown, blob?: Blob) => void) => void;
  }>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  addPeer?: (peer: unknown) => void;
};

/** How often the file links are compared against the seeders we know of. */
const WT_RECONCILE_MS = 5_000;
/** Ceiling on the per-pair retry wait. */
const WT_RETRY_MAX_MS = 60_000;
/** Distinct infoHashes a single peer may have registered with us at once. */
const MAX_INFOHASHES_PER_PEER = 64;
/** Distinct infoHashes tracked in total, across every peer. */
const MAX_INFOHASHES_TOTAL = 4096;

function wtKey(infoHash: string, peerId: string): string {
  return `${infoHash}:${peerId}`;
}

function isValidInfoHash(h: string): boolean {
  return /^[a-f0-9]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

export class WebTorrentFileTransport implements FileTransferTransport {
  /**
   * Created on first use: the library is large and a session that never
   * touches a file should not pay for it at boot, in bundle or in memory.
   */
  private clientP: Promise<WTClient> | null = null;

  private client(): Promise<WTClient> {
    if (!this.clientP) {
      this.clientP = import("webtorrent").then(
        ({ default: WebTorrent }) =>
          new WebTorrent({
            dht: false,
            tracker: false,
            lsd: false,
            utPex: false,
          } as never)
      );
    }
    return this.clientP;
  }

  private handlers = new Map<keyof FileTransferEvents, Set<Function>>();
  private transfers = new Map<string, FileTransferSnapshot>();
  private knownFiles = new Map<string, FileDescriptor>();
  private localSeedHashes = new Set<string>();
  private connectedPeers = new Set<string>();
  private seedersByHash = new Map<string, Set<string>>();
  /** infoHashes registered by each peer, oldest-first (Set preserves insertion order) - bounds registerSeeder against a flooding peer. */
  private peerSeeded = new Map<string, Set<string>>();
  private wtPeers = new Map<string, SimplePeerInstance>();
  /**
   * Per-pair retry state for the WebRTC links that carry file data.
   *
   * Each (file, peer) pair gets its own SimplePeer, created either when a
   * download starts or when a signal arrives - and when one failed it was
   * deleted and never rebuilt. With one or two people that is rarely visible;
   * with a roomful it is the difference between a transfer and a stall,
   * because every additional person is another handful of connections that can
   * lose the ICE race, and each loss silently subtracted a seeder for the rest
   * of the transfer. Same shape as the voice reconcile: a tick that compares
   * what should exist against what does.
   */
  private wtNextTry = new Map<string, number>();
  private wtBackoff = new Map<string, number>();
  private wtReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private attachedTorrents = new Set<string>();
  private seedingByHash = new Map<string, boolean>();

  private localFileLookup: ((infoHash: string) => Promise<File | null>) | null =
    null;

  /** Storage lives a layer up; this is how it offers files we have not seeded. */
  setLocalFileLookup(fn: (infoHash: string) => Promise<File | null>): void {
    this.localFileLookup = fn;
  }

  constructor(private readonly selfId: () => string) {
    if (typeof window !== "undefined") {
      this.wtReconcileTimer = setInterval(
        () => this.reconcileWtPeers(),
        WT_RECONCILE_MS
      );
    }
  }

  /**
   * Rebuild the file links that should exist and do not.
   *
   * Costs nothing while everything is healthy - a walk over transfers that are
   * still downloading. Only pairs whose connection failed, or never got made,
   * are dialled, and each backs off on its own so an unreachable peer is not
   * retried every few seconds for the whole transfer.
   */
  private reconcileWtPeers(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    for (const [infoHash, snapshot] of this.transfers) {
      // Only what we are still trying to fetch.
      if (snapshot.status !== "downloading" && snapshot.status !== "pending") {
        continue;
      }
      const seeders = this.seedersByHash.get(infoHash);
      if (!seeders?.size) continue;
      for (const peerId of seeders) {
        if (peerId === this.selfId()) continue;
        // A seeder we cannot currently reach at all is not worth dialling.
        if (!this.connectedPeers.has(peerId)) continue;
        const key = wtKey(infoHash, peerId);
        if (this.wtPeers.has(key)) continue;
        if (now < (this.wtNextTry.get(key) ?? 0)) continue;
        const wait = Math.min(
          Math.max((this.wtBackoff.get(key) ?? 0) * 2, WT_RECONCILE_MS),
          WT_RETRY_MAX_MS
        );
        this.wtBackoff.set(key, wait);
        this.wtNextTry.set(key, now + wait);
        this.createWTPeer(infoHash, peerId, true);
      }
    }
  }

  async seedFiles(files: File[]): Promise<FileDescriptor[]> {
    const seeded = await Promise.all(
      files.map((file) => this.seedSingle(file))
    );
    for (const desc of seeded) {
      for (const peerId of this.connectedPeers) {
        this.emit("signal", peerId, {
          kind: "file-seeder",
          file: desc,
        });
      }
    }
    return seeded;
  }

  registerSeeder(file: FileDescriptor, seederPeerId: string): void {
    if (!isValidInfoHash(file.infoHash)) {
      console.warn(`Rejecting seeder registration with invalid infoHash: ${file.infoHash}`);
      return;
    }

    // Only a NEW (peer, infoHash) pair grows the bounded maps - a repeat
    // registration (e.g. a reconnect re-announcing) costs nothing extra.
    const isNewForPeer = !this.peerSeeded.get(seederPeerId)?.has(file.infoHash);
    if (isNewForPeer) {
      this._enforcePeerCap(seederPeerId);
      if (!this.seedersByHash.has(file.infoHash)) this._enforceGlobalCap();
    }

    this.knownFiles.set(file.infoHash, file);

    if (!this.seedersByHash.has(file.infoHash)) {
      this.seedersByHash.set(file.infoHash, new Set());
    }
    this.seedersByHash.get(file.infoHash)!.add(seederPeerId);

    let peerSet = this.peerSeeded.get(seederPeerId);
    if (!peerSet) {
      peerSet = new Set();
      this.peerSeeded.set(seederPeerId, peerSet);
    }
    peerSet.add(file.infoHash);

    const existing = this.transfers.get(file.infoHash);
    if (!existing) {
      this.upsertTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: this.seedersByHash.get(file.infoHash)?.size ?? 0,
      });
    } else {
      this.upsertTransfer({
        ...existing,
        seeders:
          this.seedersByHash.get(file.infoHash)?.size ?? existing.seeders,
      });
    }

    if (existing?.status === "downloading") {
      this.createWTPeer(file.infoHash, seederPeerId, true);
    } else if (existing?.status === "failed") {
      // The last seeder leaving fails the transfer; without this a seeder
      // coming back was recorded and then ignored, and the file stayed
      // undownloadable until the user hit retry by hand.
      this.ensureDownload(file);
    }
  }

  private _isActiveTransfer(infoHash: string): boolean {
    const status = this.transfers.get(infoHash)?.status;
    return status === "downloading" || status === "seeding";
  }

  /** Drop one (peer, infoHash) registration entirely - used by both caps. */
  private _forgetPeerSeed(peerId: string, infoHash: string): void {
    this.peerSeeded.get(peerId)?.delete(infoHash);
    const seeders = this.seedersByHash.get(infoHash);
    if (!seeders) return;
    seeders.delete(peerId);
    if (seeders.size === 0) {
      this.seedersByHash.delete(infoHash);
      this.knownFiles.delete(infoHash);
    }
  }

  /**
   * At the per-peer cap, drop that peer's oldest registration that has no
   * transfer in flight - never an active download/upload, just to make room.
   * If every one of the peer's registrations is active, let it exceed the
   * cap rather than kill a live transfer.
   */
  private _enforcePeerCap(peerId: string): void {
    const peerSet = this.peerSeeded.get(peerId);
    if (!peerSet || peerSet.size < MAX_INFOHASHES_PER_PEER) return;
    for (const infoHash of peerSet) {
      if (this._isActiveTransfer(infoHash)) continue;
      this._forgetPeerSeed(peerId, infoHash);
      return;
    }
  }

  /** Same idea as _enforcePeerCap, but for the total distinct infoHash count. */
  private _enforceGlobalCap(): void {
    if (this.seedersByHash.size < MAX_INFOHASHES_TOTAL) return;
    for (const [infoHash, seeders] of this.seedersByHash) {
      if (this._isActiveTransfer(infoHash)) continue;
      for (const peerId of seeders) this.peerSeeded.get(peerId)?.delete(infoHash);
      this.seedersByHash.delete(infoHash);
      this.knownFiles.delete(infoHash);
      return;
    }
  }

  ensureDownload(file: FileDescriptor): void {
    if (!isValidInfoHash(file.infoHash)) {
      console.warn(`Rejecting download with invalid infoHash: ${file.infoHash}`);
      return;
    }

    this.knownFiles.set(file.infoHash, file);
    const existing = this.transfers.get(file.infoHash);
    if (existing?.status === "complete" || existing?.status === "seeding") {
      return;
    }

    void this.client().then((client) => {
      const torrent = client.get(
        file.infoHash
      ) as unknown as TorrentLike | null;
      if (!torrent) {
        const added = client.add(file.infoHash, {
          announce: [],
        }) as TorrentLike;
        this.attachTorrent(added, false, file);
      } else {
        this.attachTorrent(torrent, false, file);
      }
    });

    this.upsertTransfer({
      ...file,
      status: "downloading",
      progress: existing?.progress ?? 0,
      done: false,
      seeding: false,
      peers: existing?.peers ?? 0,
      seeders:
        this.seedersByHash.get(file.infoHash)?.size ?? existing?.seeders ?? 0,
      blobURL: existing?.blobURL,
    });

    const seeders = this.seedersByHash.get(file.infoHash);
    if (!seeders || seeders.size === 0) return;

    for (const peerId of seeders) {
      if (peerId === this.selfId()) continue;
      this.createWTPeer(file.infoHash, peerId, true);
    }
  }

  handleSignal(fromPeerId: string, envelope: FileSignalEnvelope): void {
    if (envelope.kind === "file-seeder") {
      this.registerSeeder(envelope.file, fromPeerId);
      return;
    }

    if (!isValidInfoHash(envelope.infoHash)) {
      console.warn(`Rejecting signal with invalid infoHash: ${envelope.infoHash}`);
      return;
    }

    const key = wtKey(envelope.infoHash, fromPeerId);
    if (!this.wtPeers.has(key)) {
      this.createWTPeer(envelope.infoHash, fromPeerId, false);
    }
    this.wtPeers.get(key)?.signal(envelope.signal as never);
  }

  onPeerConnect(peerId: string): void {
    this.connectedPeers.add(peerId);
    for (const infoHash of this.localSeedHashes) {
      const file = this.knownFiles.get(infoHash);
      if (!file) continue;
      this.emit("signal", peerId, {
        kind: "file-seeder",
        file,
      });
    }
  }

  onPeerDisconnect(peerId: string): void {
    this.connectedPeers.delete(peerId);
    this.peerSeeded.delete(peerId);
    // Their retry state goes with them, so a peer that reconnects is dialled
    // straight away rather than inheriting a wait from before it dropped.
    for (const key of [...this.wtNextTry.keys()]) {
      if (key.endsWith(`:${peerId}`)) {
        this.wtNextTry.delete(key);
        this.wtBackoff.delete(key);
      }
    }

    for (const [infoHash, seeders] of this.seedersByHash) {
      if (seeders.delete(peerId)) {
        const existing = this.transfers.get(infoHash);
        if (existing) {
          this.upsertTransfer({
            ...existing,
            seeders: seeders.size,
          });
        }
      }
      if (seeders.size === 0) {
        // When last seeder disconnects, fail any in-flight downloads
        const transfer = this.transfers.get(infoHash);
        if (transfer && transfer.status === "downloading" && !transfer.done) {
          this.upsertTransfer({
            ...transfer,
            status: "failed",
            error: "Seeder disconnected",
          });
        }
        this.seedersByHash.delete(infoHash);
      }
    }

    for (const key of [...this.wtPeers.keys()]) {
      if (key.endsWith(`:${peerId}`)) {
        this.wtPeers.get(key)?.destroy();
        this.wtPeers.delete(key);
      }
    }
  }

  getTransfer(infoHash: string): FileTransferSnapshot | undefined {
    return this.transfers.get(infoHash);
  }

  getTransfers(): FileTransferSnapshot[] {
    return [...this.transfers.values()];
  }

  on<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void {
    this.handlers.get(event)?.delete(handler);
  }

  resetTransfers(): void {
    for (const peer of this.wtPeers.values()) {
      peer.destroy();
    }
    this.wtPeers.clear();

    const blobUrls = new Set(
      [...this.transfers.values()]
        .map((t) => t.blobURL)
        .filter(Boolean) as string[]
    );
    for (const url of blobUrls) URL.revokeObjectURL(url);

    this.transfers.clear();
    this.knownFiles.clear();
    this.seedersByHash.clear();
    this.peerSeeded.clear();
    this.localSeedHashes.clear();
    this.attachedTorrents.clear();
    this.seedingByHash.clear();
  }

  destroy(): void {
    this.resetTransfers();
    this.connectedPeers.clear();
    this.clientP?.then((client) => client.destroy(() => {}));
    this.clientP = null;
  }

  private async seedSingle(file: File): Promise<FileDescriptor> {
    const client = await this.client();
    return new Promise<FileDescriptor>((resolve, reject) => {
      const torrent = client.seed(
        file,
        { announce: [] },
        (created: any) => {
          const descriptor: FileDescriptor = {
            infoHash: created.infoHash,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          };

          this.knownFiles.set(descriptor.infoHash, descriptor);
          this.localSeedHashes.add(descriptor.infoHash);
          this.registerSeeder(descriptor, this.selfId());
          this.attachTorrent(created, true, descriptor);

          this.upsertTransfer({
            ...descriptor,
            status: "seeding",
            progress: 1,
            done: true,
            seeding: true,
            peers: created.numPeers ?? 0,
            seeders: this.seedersByHash.get(descriptor.infoHash)?.size ?? 1,
          });

          resolve(descriptor);
        }
      ) as unknown as TorrentLike;

      (torrent as unknown as { on: Function }).on("error", (err: Error) => {
        const message = err?.message ?? "";
        if (message.includes("Cannot add duplicate torrent")) {
          const existing = client.get(
            (torrent as any).infoHash
          ) as unknown as TorrentLike | null;
          if (existing?.infoHash) {
            const descriptor: FileDescriptor = {
              infoHash: existing.infoHash,
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              size: file.size,
            };
            this.knownFiles.set(descriptor.infoHash, descriptor);
            this.localSeedHashes.add(descriptor.infoHash);
            this.registerSeeder(descriptor, this.selfId());
            this.attachTorrent(existing, true, descriptor);
            this.upsertTransfer({
              ...descriptor,
              status: "seeding",
              progress: 1,
              done: true,
              seeding: true,
              peers: existing.numPeers ?? 0,
              seeders: this.seedersByHash.get(descriptor.infoHash)?.size ?? 1,
            });
            resolve(descriptor);
            return;
          }
        }
        reject(err);
      });
    });
  }

  /**
   * Hand a live wire to its torrent, seeding the file first if we hold the
   * bytes but have no torrent for them.
   *
   * Seeding is only resumed for the conversation that is OPEN, so every file
   * in every other room and DM had no torrent behind it: the peer asking for
   * it connected fine and then found nothing to talk to. Doing it here covers
   * every dial - first download, manual retry, and the reconcile tick.
   */
  private async attachToTorrent(
    infoHash: string,
    peer: SimplePeerInstance
  ): Promise<void> {
    const client = await this.client();
    let torrent = client.get(infoHash) as unknown as TorrentLike | null;
    if (!torrent && this.localFileLookup) {
      const file = await this.localFileLookup(infoHash).catch(() => null);
      if (file) {
        await this.seedFiles([file]).catch(() => {});
        torrent = client.get(infoHash) as unknown as TorrentLike | null;
      }
    }
    // The wire can die during the seed above, and a torrent we neither hold
    // nor can rebuild means dropping the link so the reconcile tick dials
    // again instead of counting a useless one as connected.
    if ((peer as unknown as { destroyed?: boolean }).destroyed) return;
    if (!torrent?.addPeer) {
      peer.destroy();
      return;
    }
    torrent.addPeer(peer);
  }

  private createWTPeer(
    infoHash: string,
    peerId: string,
    initiator: boolean
  ): void {
    const key = wtKey(infoHash, peerId);
    if (this.wtPeers.has(key)) return;

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      channelName: `wt:${infoHash}`,
      streams: [],
      config: {
        // No iceCandidatePoolSize: it pre-gathers N full candidate sets the
        // moment the connection is constructed - a TURN allocation per pool
        // per server - and it was set to 10. Pre-gathering only pays off when
        // the connection is built well before the offer; here the offer
        // follows immediately, so all it bought was ten times the allocations
        // against a TURN server that rate-limits.
        iceServers: getIceServers(),
      },
    });

    this.wtPeers.set(key, peer);

    peer.on("signal", (signal: unknown) => {
      this.emit("signal", peerId, {
        kind: "file-wt-signal",
        infoHash,
        signal,
      });
    });

    // webtorrent keys torrent._peers by `peer.id` and a bare SimplePeer has
    // none, so every WebRTC peer landed on the same `undefined` slot: the
    // second one silently overwrote the first, and either one closing called
    // removePeer(undefined) and tore down the survivor. One seeder/leecher
    // pair per file was the most that could ever work.
    (peer as unknown as { id: string }).id = peerId;

    peer.on("connect", () => {
      this.wtNextTry.delete(key);
      this.wtBackoff.delete(key);
      void this.attachToTorrent(infoHash, peer);
    });

    peer.on("error", () => {
      this.wtPeers.delete(key);
    });

    peer.on("close", () => {
      this.wtPeers.delete(key);
    });
  }

  private attachTorrent(
    torrent: TorrentLike,
    seeding: boolean,
    fallback: FileDescriptor
  ): void {
    const infoHash = torrent.infoHash;
    if (!infoHash) return;

    // Always update seeding state - seed wins over download
    if (seeding) {
      this.seedingByHash.set(infoHash, true);
    } else if (!this.seedingByHash.has(infoHash)) {
      this.seedingByHash.set(infoHash, false);
    }

    const descriptor = this.knownFiles.get(infoHash) ?? fallback;

    const pushUpdate = () => {
      const isSeeding = this.seedingByHash.get(infoHash) ?? seeding;
      const existing = this.transfers.get(infoHash);
      this.upsertTransfer({
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status: torrent.done
          ? isSeeding
            ? "seeding"
            : "complete"
          : "downloading",
        progress: torrent.progress ?? existing?.progress ?? 0,
        done: torrent.done,
        seeding: isSeeding,
        peers: torrent.numPeers ?? existing?.peers ?? 0,
        seeders:
          this.seedersByHash.get(infoHash)?.size ?? existing?.seeders ?? 0,
        blobURL: existing?.blobURL,
        error: existing?.error,
      });
    };

    if (this.attachedTorrents.has(infoHash)) {
      pushUpdate();
      return;
    }

    this.attachedTorrents.add(infoHash);
    torrent.on("download", pushUpdate);
    torrent.on("upload", pushUpdate);
    torrent.on("wire", pushUpdate);

    torrent.on("done", () => {
      pushUpdate();
      if (this.seedingByHash.get(infoHash)) return;
      const file = torrent.files?.[0];
      if (!file) return;
      file.getBlob((_err, blob) => {
        if (!blob) return;
        const prev = this.transfers.get(infoHash);
        if (prev?.blobURL) URL.revokeObjectURL(prev.blobURL);
        const blobURL = URL.createObjectURL(blob);
        this.upsertTransfer({
          ...prev,
          infoHash,
          filename: descriptor.filename,
          mimeType: descriptor.mimeType,
          size: descriptor.size,
          status: "complete",
          progress: 1,
          done: true,
          seeding: false,
          peers: torrent.numPeers ?? prev?.peers ?? 0,
          seeders: this.seedersByHash.get(infoHash)?.size ?? prev?.seeders ?? 0,
          blobURL,
        });
        this.emit("downloaded", infoHash, blob);
      });
    });

    torrent.on("error", (...args: unknown[]) => {
      const err = args[0] as Error;
      const prev = this.transfers.get(infoHash);
      // If currently seeding, keep it as seeding and just log the error
      if (prev?.seeding || prev?.status === "seeding") {
        console.error(`Transient error on seeded torrent ${infoHash}:`, err.message);
        return;
      }
      this.upsertTransfer({
        ...(prev ?? descriptor),
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status: "failed",
        progress: prev?.progress ?? 0,
        done: false,
        seeding: this.seedingByHash.get(infoHash) ?? false,
        peers: prev?.peers ?? 0,
        seeders: this.seedersByHash.get(infoHash)?.size ?? prev?.seeders ?? 0,
        blobURL: prev?.blobURL,
        error: err.message,
      });
    });

    pushUpdate();
  }

  private upsertTransfer(snapshot: FileTransferSnapshot): void {
    const existing = this.transfers.get(snapshot.infoHash);
    const next = {
      ...existing,
      ...snapshot,
    } as FileTransferSnapshot;
    this.transfers.set(snapshot.infoHash, next);
    this.emit("transfer", next);
  }

  private emit<K extends keyof FileTransferEvents>(
    event: K,
    ...args: Parameters<FileTransferEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
