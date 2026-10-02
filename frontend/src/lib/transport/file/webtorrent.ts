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
import { getIceServers, onIceServersChanged } from "../ice-server-list";
import { ev, errText } from "../../telemetry/event";
import { rec, refs } from "../../telemetry/recorder";
import type { FileEntry } from "../../types/message";
import { encryptedFileSize, opaqueFileName } from "../../room-security/file-descriptor";
import { stageEncryptedFile, stageDecryptedFile, type StagedFile } from "../../room-security/file-staging";
import { readCiphertext, writeCiphertext, removeCiphertext } from "./ciphertext-store";
import { CiphertextChunkStore, OPFSChunkStore } from "./opfs-store";
import { OPFSLease, STAGING_DIR } from "./opfs-lease";

type TorrentLike = {
  infoHash: string;
  name?: string;
  length?: number;
  progress: number;
  done: boolean;
  numPeers?: number;
  files?: Array<{
    name?: string;
    createReadStream?: () => AsyncIterable<Uint8Array>;
    getBlob: (cb: (err: unknown, blob?: Blob) => void) => void;
  }>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  addPeer?: (peer: unknown) => void;
  destroy?: (opts?: unknown, cb?: (err?: Error) => void) => void;
};

/** How often the file links are compared against the seeders we know of. */
const WT_RECONCILE_MS = 5_000;
/**
 * How often one torrent's progress may become a snapshot. webtorrent reports
 * every block that moves - a request in, a header and a block out, about
 * three reports per 16 KiB served - and each one was a full snapshot for the
 * app: the reactive transfer map copied, the stored status looked up again.
 * Four a second still moves a progress bar smoothly.
 */
const WT_PROGRESS_MS = 250;
/** Piece size of every protected file. Part of what the signed infoHash
 *  covers, so a file seeded again must be cut exactly the same way. */
const ENCRYPTED_PIECE_LENGTH = 256 * 1024;
/** Ceiling on the per-pair retry wait. */
const WT_RETRY_MAX_MS = 60_000;
/**
 * Dials per (file, peer) pair before the pair is given up on.
 *
 * A peer that reconnects without ever disconnecting (a second tab of the
 * same profile fighting over one peerId) re-announces its whole inventory
 * every time, and every announce used to re-dial every stuck file with no
 * ceiling: 520 file requests and 428 of Chrome's 500 PeerConnections in two
 * minutes. The backoff already spaces the dials out; this bounds them. A
 * real disconnect, or the user clicking the file, starts the count over.
 */
const WT_MAX_ATTEMPTS = 6;
/**
 * Live WebRTC links for file transfer, across every (file, peer) pair.
 *
 * Each pair gets its own RTCPeerConnection, and the pairs multiply: joining a
 * room replays its whole history, every image in it starts downloading, and
 * each one dials every seeder that has it. A room with a few hundred images
 * and a roomful of people asked for thousands of connections at once - Chrome
 * caps a tab at 500 and throws "Cannot create so many PeerConnections", which
 * took the call down with it because voice could no longer get one either.
 * Capped here rather than at any one caller: reconcile, registerSeeder,
 * ensureDownload and handleSignal all build links through createWTPeer. Pairs
 * over the cap are not dropped, just deferred - the reconcile tick dials them
 * as transfers finish and slots come free.
 */
/**
 * How long a file link may sit unconnected before it is given up on.
 *
 * A SimplePeer whose ICE finds no path does not necessarily fail. With a
 * STUN-only list between two NATs it can stay in `checking` and never emit
 * `error` or `close` at all - and nothing else here has a clock. The link
 * then lived for the rest of the session, which was worse than useless:
 * dial() skips a pair that already has a peer, and allExhausted() refuses to
 * give up while one exists, so the transfer sat at "downloading" with no
 * error and no retry button, holding one of the link slots the whole time.
 *
 * That is what a file over the inline limit looked like on an instance whose
 * relay hands out no TURN (an unset TURN_SECRET answers /turn-credentials
 * with 204): everything else worked - chat, voice, video, and any file small
 * enough to ride inline - while anything bigger never loaded and never said
 * why. Smaller files were fine because they never build one of these links
 * at all; they travel inside the message, over libp2p, which has the relay
 * circuit to fall back on. WebTorrent's own link has only TURN.
 *
 * Deliberately past the browser's own ICE failure detection (~15-30s), so a
 * link the browser would have failed by itself is never cut short by this.
 * On expiry the peer is destroyed, its close handler frees the slot, and the
 * reconcile tick dials again - which is what lets the attempt count climb to
 * WT_MAX_ATTEMPTS and the transfer finally say "Could not reach the sender".
 */
const WT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * The table is split by direction: links we dialled to FETCH a file, and
 * links other people dialled to fetch one from US.
 *
 * It used to be one table of 32 for both, which is what made big rooms
 * spotty while a room of two always worked. A person catching up on a busy
 * room's history filled all 32 with their own downloads - and then could
 * not serve anything, including the image they had just sent. Their side
 * dropped the request without a word, the downloader waited out the 30s
 * deadline, and a few rounds of that ended in "Could not reach the sender".
 * With a budget of its own, serving never waits on our own downloads.
 */
const MAX_WT_DIALS = 24;
const MAX_WT_SERVES = 24;
/**
 * Holders of one file dialled at the same time.
 *
 * A download dialled every holder at once, so with four people holding an
 * image it took four links, and a room's worth of images asked for many
 * times the table. Two keep a spare when one does not answer; the next
 * holder is dialled as a link fails, in the order they were learned - the
 * author first, since the message and its own announce come from them.
 */
const WT_HOLDERS_PER_FILE = 2;
/**
 * How long a downloader waits after a holder answered "busy" (its serving
 * budget was full). A busy answer is not a failed dial: it costs no attempt.
 */
const WT_BUSY_RETRY_MS = 10_000;
/**
 * One peer's share of that table.
 *
 * The global cap alone is a denial-of-service primitive: a single peer that
 * signals 32 infoHashes takes every slot, and then nobody else's file can get
 * a link at all - createWTPeer just returns false for the rest of the room.
 * A per-peer ceiling keeps one talkative (or hostile) peer from starving
 * everyone, and the reconcile tick dials the deferred pairs as slots free.
 */
const MAX_WT_PEERS_PER_PEER = 8;
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

/**
 * Which dial a file link belongs to.
 *
 * Links are keyed by (file, peer), and nothing said which ATTEMPT a signal
 * was for - so a retry collided with what was left of the attempt before
 * it. The sender still held its half of the dead link (its own deadline
 * runs later, and a torn-down initiator tells it nothing), fed the retry's
 * offer into it, and that link died on the mismatched DTLS fingerprint. The
 * retry's trickled candidates then built an orphan with no offer, which sat
 * for 30s and caught the NEXT retry's offer the same way. Late answers from
 * a dead attempt landed on the downloader's new link too. Files over the
 * inline limit went through this whenever a first dial failed - and the
 * first dials of a session fail by design while the TURN credentials are
 * still on their way - so a transfer either worked first time or burned
 * through WT_MAX_ATTEMPTS to "Could not reach the sender".
 *
 * The side that dials picks a session; both sides stamp it on every signal.
 * A new session replaces the sender's leftover link, and a session that has
 * ended is ignored wherever it turns up. Optional on the wire: an older
 * client sends none and is handled as before.
 */
const MAX_RETIRED_SESSIONS = 8;

function newSession(): string {
  // getRandomValues, not randomUUID: the latter only exists on a secure
  // page, and the app is also opened over plain http on a LAN address.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readSession(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64
    ? raw
    : undefined;
}

/**
 * The answer a holder sends when its serving budget is full, instead of
 * dropping the offer. Optional on the wire: an older client handed one gets
 * a signal SimplePeer rejects, which fails its link at once - still sooner
 * than the 30s it would otherwise have waited.
 */
const BUSY_SIGNAL = { type: "busy" } as const;

function isBusy(signal: unknown): boolean {
  return (
    typeof signal === "object" &&
    signal !== null &&
    (signal as { type?: unknown }).type === "busy"
  );
}

/**
 * The descriptor alone. A stored file arrives as its attachment row, which
 * also carries the row's ids, status and - up to 5 MB - its bytes, none of
 * which belong in the maps a transfer lives in.
 */
function fileEntry(file: FileEntry): FileEntry {
  const entry: FileEntry = {
    infoHash: file.infoHash, filename: file.filename, mimeType: file.mimeType, size: file.size,
  };
  if (file.encryption) entry.encryption = file.encryption;
  if (file.width !== undefined) entry.width = file.width;
  if (file.height !== undefined) entry.height = file.height;
  return entry;
}

/** Only an offer starts a link; see handleSignal. */
function isOffer(signal: unknown): boolean {
  return (
    typeof signal === "object" &&
    signal !== null &&
    (signal as { type?: unknown }).type === "offer"
  );
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
  /** Which dial each live link belongs to, and whether we made it. */
  private wtLinkMeta = new WeakMap<
    SimplePeerInstance,
    { session: string | undefined; initiator: boolean }
  >();
  /** Sessions of links that have ended, per pair: their signals are stale. */
  private wtRetired = new Map<string, Set<string>>();
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
  /** Consecutive dials that never connected, per pair. See WT_MAX_ATTEMPTS. */
  private wtAttempts = new Map<string, number>();
  private wtReconcileTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * When each download was asked for, as a sequence number. Free slots go
   * to the NEWEST first: the image just sent in the chat before the backlog
   * of history a join started fetching. Transfers are otherwise walked in
   * the order they were first seen, which is oldest first.
   */
  private wtRequested = new Map<string, number>();
  private wtRequestSeq = 0;
  private iceUnsubscribe: (() => void) | null = null;
  private attachedTorrents = new Set<string>();
  /**
   * infoHashes whose torrent is being added right now. ensureDownload reads
   * client.get() and calls client.add() on the far side of an await, so two
   * calls for the same file - and there are always two, because a message
   * arriving and a seeder announcing both trigger one - each saw no torrent
   * and each added it. webtorrent answers the second with "A torrent with the
   * same id is already being seeded" on an unhandled rejection.
   */
  private addingTorrents = new Set<string>();
  private seedingByHash = new Map<string, boolean>();
  private lifecycle = new AbortController();
  private plaintext = new Map<string, StagedFile>();
  private publishing = new Set<string>();
  /**
   * Owner of this session's piece stores and send staging in OPFS. A new one
   * per session (see resetTransfers), so the entries of the session that
   * ended can go without racing the one that starts.
   */
  private lease = new OPFSLease();

  /** New protected sends only. The returned descriptor contains a secret and
   * must travel inside an authenticated room message, never public discovery. */
  async seedEncryptedFiles(files: File[]): Promise<FileEntry[]> {
    const signal = this.lifecycle.signal;
    const descriptors: FileEntry[] = [];
    for (const source of files) {
      const staged = await stageEncryptedFile(source, await this.lease.directory(STAGING_DIR), signal);
      try {
        signal.throwIfAborted();
        // Served from the staged ciphertext itself, then from its durable
        // copy once that exists: no piece store copies it a third time.
        const pieces = new CiphertextChunkStore(ENCRYPTED_PIECE_LENGTH, staged.file);
        const descriptor = await this.seedSingle(staged.file, {
          infoHash: "", filename: source.name, mimeType: source.type || "application/octet-stream",
          size: source.size, encryption: staged.encryption,
        }, pieces);
        pieces.source = await writeCiphertext(descriptor.infoHash, staged.file, signal);
        pieces.reopen = () => readCiphertext(descriptor.infoHash);
        descriptors.push(descriptor);
      } finally { await staged.dispose(); }
    }
    return descriptors;
  }

  async persistableCiphertext(infoHash: string, maxBytes: number): Promise<ArrayBuffer | undefined> {
    const file = await readCiphertext(infoHash);
    return file && file.size <= maxBytes ? file.arrayBuffer() : undefined;
  }

  /** The durable copy, written only when it is not there already: every
   * session's first look at a file used to write all of it out again. */
  private async keepCiphertext(infoHash: string, ciphertext: Blob, signal: AbortSignal): Promise<File> {
    const held = await readCiphertext(infoHash);
    if (held && held.size === ciphertext.size) return held;
    return writeCiphertext(infoHash, ciphertext, signal);
  }

  /**
   * Show a stored attachment: decrypt its ciphertext - the durable copy, or
   * `data`, the attachment row's own - in memory and publish it the way a
   * finished download is published. Nothing is seeded and nothing is
   * rewritten: every room open used to decrypt, re-hash and write out every
   * file the room held, three times its size, on each session's first visit.
   * The file is still announced as held, and a peer that asks for it gets it
   * through seedStoredFile.
   */
  async restoreEncryptedFile(stored: FileEntry, data?: ArrayBuffer): Promise<boolean> {
    const { encryption } = stored;
    if (!encryption) throw new Error("Encrypted descriptor required");
    const signal = this.lifecycle.signal;
    const descriptor = fileEntry(stored);
    const { infoHash } = descriptor;
    const ciphertext = data ? new Blob([data]) : await readCiphertext(infoHash);
    if (!ciphertext) return false;
    const plain = await stageDecryptedFile(ciphertext, encryption, descriptor.filename, descriptor.mimeType, signal);
    signal.throwIfAborted();
    // A row restored from a backup, or synced from another device, can hold
    // the only copy: serving reads the durable one.
    if (data) await this.keepCiphertext(infoHash, ciphertext, signal);
    signal.throwIfAborted();
    this.plaintext.set(infoHash, plain);
    this.knownFiles.set(infoHash, descriptor);
    this.localSeedHashes.add(infoHash);
    this.seedingByHash.set(infoHash, true);
    let seeders = this.seedersByHash.get(infoHash);
    if (!seeders) this.seedersByHash.set(infoHash, (seeders = new Set()));
    seeders.add(this.selfId());
    const prev = this.transfers.get(infoHash);
    // The URL of an earlier publication holds the same bytes: let it go.
    if (prev?.blobURL) URL.revokeObjectURL(prev.blobURL);
    this.upsertTransfer({
      ...descriptor, status: "seeding", progress: 1, done: true, seeding: true,
      peers: prev?.peers ?? 0, seeders: seeders.size, error: undefined,
      blobURL: URL.createObjectURL(plain.file),
    });
    // The application deliberately does not adopt transport-owned blob URLs.
    // Recovery must deliver the authenticated file through the same publication
    // event as a network download so hydration can mint its own usable URL -
    // marked as read back from this device, so nothing stores it again.
    this.emit("downloaded", infoHash, plain.file, true);
    return true;
  }

  /** In-flight serves of stored files, one per file however many peers ask. */
  private storedSeeds = new Map<string, Promise<boolean>>();

  /**
   * Serve a stored attachment: seed its durable ciphertext as it is, never
   * decrypted and never copied (CiphertextChunkStore), with the original
   * opaque name and piece size so the signed infoHash comes out the same.
   * Never re-encrypt: doing so changes it. `data` is the attachment row's
   * copy, for a file this device's durable store does not hold.
   */
  seedStoredFile(descriptor: FileEntry, data?: ArrayBuffer): Promise<boolean> {
    const { infoHash } = descriptor;
    let seeding = this.storedSeeds.get(infoHash);
    if (!seeding) {
      seeding = this.seedStored(descriptor, data).finally(() => {
        if (this.storedSeeds.get(infoHash) === seeding) this.storedSeeds.delete(infoHash);
      });
      this.storedSeeds.set(infoHash, seeding);
    }
    return seeding;
  }

  private async seedStored(stored: FileEntry, data?: ArrayBuffer): Promise<boolean> {
    if (!stored.encryption) throw new Error("Encrypted descriptor required");
    const signal = this.lifecycle.signal;
    const descriptor = fileEntry(stored);
    const { infoHash } = descriptor;
    const expected = encryptedFileSize(descriptor);
    let file = await readCiphertext(infoHash);
    if (file?.size !== expected && data?.byteLength === expected) {
      file = await writeCiphertext(infoHash, new Blob([data]), signal);
    }
    if (!file || file.size !== expected) return false;
    signal.throwIfAborted();
    const pieces = new CiphertextChunkStore(ENCRYPTED_PIECE_LENGTH, file, () => readCiphertext(infoHash));
    await this.seedSingle(new File([file], opaqueFileName(descriptor), { type: "application/octet-stream" }), descriptor, pieces);
    return true;
  }

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
    // ICE servers are snapshotted when a SimplePeer is built (createWTPeer),
    // so a file link dialled before the TURN credentials landed is STUN-only
    // for its whole life - and the first dials of a session happen exactly
    // then: connect() kicks off the credential fetch and, in the same tick,
    // opening a room auto-downloads its images and dials their seeders.
    // Between two NATs (mobile, CGNAT, most home routers) a STUN-only link
    // never connects, so the transfer sat at zero peers forever with only
    // the skeleton showing, while voice kept working: it rides the SFU and
    // rebuilds on this same event (libp2p/voice.ts). Mirror that here: when
    // the list changes, tear down every link that has not connected yet,
    // clear its backoff so the redial is immediate, and let the reconcile
    // pass dial it again with TURN in hand. Established links are left alone.
    this.iceUnsubscribe = onIceServersChanged(() => {
      for (const [key, peer] of [...this.wtPeers]) {
        if (peer.connected) continue;
        // Delete before destroy: destroy() fires the close handler, which
        // deletes too, and this keeps the redial below from racing it.
        this.wtPeers.delete(key);
        // A dial made without TURN was never going to land; it does not
        // count against the pair either.
        this.forgetRetryState(key);
        peer.destroy();
      }
      this.reconcileWtPeers();
    });
    // What earlier sessions left in OPFS goes as this one starts: nothing
    // removes it on the way out of a closed tab, a crash or an OS kill.
    void this.lease.sweep().catch(() => {});
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
    // Only what we are still trying to fetch. "pending" is a file nobody
    // asked for yet; dialling those built links that attachToTorrent then
    // dropped for having no torrent, over and over, for every file in the
    // room.
    const wanted = [...this.transfers]
      .filter(([, snapshot]) => snapshot.status === "downloading")
      .sort(
        ([a], [b]) => (this.wtRequested.get(b) ?? 0) - (this.wtRequested.get(a) ?? 0)
      );
    for (const [infoHash, snapshot] of wanted) {
      const seeders = this.seedersByHash.get(infoHash);
      if (!seeders?.size) continue;
      for (const peerId of seeders) this.dial(infoHash, peerId, now);
      // Every reachable seeder capped and no link left: stop pretending. The
      // card shows its download button and a click starts the count over.
      if (this.allExhausted(infoHash)) {
        this.upsertTransfer({
          ...snapshot,
          status: "failed",
          error: "Could not reach the sender",
        });
      }
    }
  }

  /**
   * Dial one pair through its backoff. Every initiator-side dial goes
   * through here - the first request, a re-announce, the reconcile tick - so
   * none of them can skip the wait the last failure earned. A seeder we
   * cannot currently reach is not worth a link. False when nothing was built.
   */
  private dial(infoHash: string, peerId: string, now: number): boolean {
    if (peerId === this.selfId()) return false;
    if (!this.connectedPeers.has(peerId)) return false;
    const key = wtKey(infoHash, peerId);
    if (this.wtPeers.has(key)) return false;
    if (now < (this.wtNextTry.get(key) ?? 0)) return false;
    const attempts = this.wtAttempts.get(key) ?? 0;
    if (attempts >= WT_MAX_ATTEMPTS) return false;
    if (this.dialledHolders(infoHash) >= WT_HOLDERS_PER_FILE) return false;
    // Backoff is for a peer that will not answer. A pair held back by the
    // cap has not been tried at all, so it keeps its place at the front of
    // the queue instead of being pushed out to the next retry window.
    if (!this.createWTPeer(infoHash, peerId, true)) return false;
    const wait = Math.min(
      Math.max((this.wtBackoff.get(key) ?? 0) * 2, WT_RECONCILE_MS),
      WT_RETRY_MAX_MS
    );
    this.wtBackoff.set(key, wait);
    this.wtNextTry.set(key, now + wait);
    this.wtAttempts.set(key, attempts + 1);
    return true;
  }

  /** Links we dialled for this file, whatever state they are in. */
  private dialledHolders(infoHash: string): number {
    let n = 0;
    for (const [key, peer] of this.wtPeers) {
      if (key.startsWith(`${infoHash}:`) && this.wtLinkMeta.get(peer)?.initiator) n += 1;
    }
    return n;
  }

  /** Links in one direction: ours to fetch (true) or theirs to fetch from us. */
  private linkCount(initiator: boolean): number {
    let n = 0;
    for (const peer of this.wtPeers.values()) {
      if (!!this.wtLinkMeta.get(peer)?.initiator === initiator) n += 1;
    }
    return n;
  }

  /** Every reachable seeder of the file is capped and none has a link. */
  private allExhausted(infoHash: string): boolean {
    let reachable = 0;
    for (const peerId of this.seedersByHash.get(infoHash) ?? []) {
      if (peerId === this.selfId() || !this.connectedPeers.has(peerId)) continue;
      reachable += 1;
      const key = wtKey(infoHash, peerId);
      if (this.wtPeers.has(key)) return false;
      if ((this.wtAttempts.get(key) ?? 0) < WT_MAX_ATTEMPTS) return false;
    }
    return reachable > 0;
  }

  private forgetRetryState(key: string): void {
    this.wtNextTry.delete(key);
    this.wtBackoff.delete(key);
    this.wtAttempts.delete(key);
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
    try { encryptedFileSize(file); } catch { return; }
    const held = this.knownFiles.get(file.infoHash) as FileEntry | undefined;
    // Seeder announcements must not replace the authenticated message's key.
    if (held?.encryption && JSON.stringify(held.encryption) !== JSON.stringify((file as FileEntry).encryption)) return;
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
      this.dial(file.infoHash, seederPeerId, Date.now());
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

  ensureDownload(file: FileDescriptor, opts?: { retry?: boolean }): void {
    try { encryptedFileSize(file); } catch { return; }
    const signal = this.lifecycle.signal;
    if (!isValidInfoHash(file.infoHash)) {
      console.warn(`Rejecting download with invalid infoHash: ${file.infoHash}`);
      return;
    }

    this.knownFiles.set(file.infoHash, file);
    const existing = this.transfers.get(file.infoHash);
    if (existing?.status === "complete" || existing?.status === "seeding") {
      return;
    }
    const seeders = this.seedersByHash.get(file.infoHash);
    if (opts?.retry) {
      // The user asked: whatever the pairs earned before is forgiven.
      for (const peerId of seeders ?? []) {
        this.forgetRetryState(wtKey(file.infoHash, peerId));
      }
    } else if (existing?.status === "failed" && this.allExhausted(file.infoHash)) {
      // Given up on stays given up on. A re-announce from the same peer used
      // to flip this back to "downloading" (skeleton, a fresh file.request,
      // no dial because every pair is capped) and the tick flipped it back.
      return;
    }

    if (!this.addingTorrents.has(file.infoHash)) {
      this.addingTorrents.add(file.infoHash);
      void this.client()
        .then((client) => {
          if (signal.aborted) return;
          const torrent = client.get(
            file.infoHash
          ) as unknown as TorrentLike | null;
          if (torrent) {
            this.attachTorrent(torrent, false, file);
            return;
          }
          const added = client.add(file.infoHash, {
            announce: [],
            ...((file as FileEntry).encryption ? { store: OPFSChunkStore as unknown as WebTorrentType.TorrentOptions["store"], storeOpts: { lease: this.lease }, storeCacheSlots: 2 } : {}),
          }) as TorrentLike;
          this.attachTorrent(added, false, file);
        })
        .catch(() => {})
        .finally(() => this.addingTorrents.delete(file.infoHash));
    }

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

    // One request per download, not one per announce: this is called again
    // for every file every time its sender reconnects.
    if (existing?.status !== "downloading") {
      this.wtRequested.set(file.infoHash, ++this.wtRequestSeq);
      rec(
        ev("file.request", {
          d: {
            peers: seeders?.size ?? 0,
            fileRef: refs().fileRef(file.infoHash),
          },
        })
      );
    }
    if (!seeders || seeders.size === 0) return;

    const now = Date.now();
    for (const peerId of seeders) this.dial(file.infoHash, peerId, now);
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
    const session = readSession(envelope.session);
    // The tail of a link that is already over: an answer or candidates from
    // an attempt we replaced or gave up on.
    if (session !== undefined && this.wtRetired.get(key)?.has(session)) return;

    let peer = this.wtPeers.get(key);
    const meta = peer && this.wtLinkMeta.get(peer);
    if (peer && meta) {
      if (meta.initiator) {
        // Our own dial: only its own session belongs on it.
        if (session !== undefined && meta.session !== undefined && session !== meta.session) {
          return;
        }
        if (isBusy(envelope.signal)) {
          // They are serving all they can. Not a failed dial: the attempt is
          // handed back, and the pair waits a while before trying again.
          const attempts = this.wtAttempts.get(key) ?? 0;
          if (attempts > 0) this.wtAttempts.set(key, attempts - 1);
          this.wtNextTry.set(key, Date.now() + WT_BUSY_RETRY_MS);
          this.wtPeers.delete(key);
          peer.destroy();
          // Another holder may have room; the tick dials it.
          this.reconcileWtPeers();
          return;
        }
      } else if (
        session !== undefined
          ? session !== meta.session
          : isOffer(envelope.signal) && !peer.connected
      ) {
        // They dialled again. Whatever is left of the last attempt goes; the
        // new offer gets a link of its own instead of dying on the old one.
        this.retireSession(key, meta.session);
        this.wtPeers.delete(key);
        peer.destroy();
        peer = undefined;
      }
    }

    if (!peer) {
      // Only an offer starts a link. An answer or a candidate with nothing to
      // land on belongs to an attempt that is over, and a link built for it
      // sat on the pair for WT_CONNECT_TIMEOUT_MS - blocking the next dial,
      // which skips a pair that already has one.
      if (!isOffer(envelope.signal)) return;
      if (!this.createWTPeer(envelope.infoHash, fromPeerId, false, session)) {
        // Full. Say so, rather than leave them waiting out their deadline.
        this.emit("signal", fromPeerId, {
          kind: "file-wt-signal",
          infoHash: envelope.infoHash,
          signal: BUSY_SIGNAL,
          ...(session !== undefined ? { session } : {}),
        });
        return;
      }
      peer = this.wtPeers.get(key);
    }
    peer?.signal(envelope.signal as never);
  }

  private retireSession(key: string, session: string | undefined): void {
    if (session === undefined) return;
    let retired = this.wtRetired.get(key);
    if (!retired) {
      retired = new Set();
      this.wtRetired.set(key, retired);
    }
    retired.add(session);
    // Oldest first out: a pair only ever needs its last few attempts.
    while (retired.size > MAX_RETIRED_SESSIONS) {
      retired.delete(retired.values().next().value as string);
    }
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
    for (const key of new Set([...this.wtNextTry.keys(), ...this.wtAttempts.keys()])) {
      if (key.endsWith(`:${peerId}`)) this.forgetRetryState(key);
    }
    for (const key of [...this.wtRetired.keys()]) {
      if (key.endsWith(`:${peerId}`)) this.wtRetired.delete(key);
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
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    for (const staged of this.plaintext.values()) void staged.dispose();
    this.plaintext.clear();
    this.publishing.clear();
    this.storedSeeds.clear();
    // A lock/reset must also stop torrents serving ciphertext and free stores.
    const client = this.clientP;
    this.clientP = null;
    void client?.then(c => c.destroy(() => {}));
    // Their files go with them, under a lease of their own: the next session
    // writes under a new one, so nothing it makes can be caught up in this.
    // Then whatever closed tabs left behind, as at startup.
    const ended = this.lease;
    this.lease = new OPFSLease();
    const lease = this.lease;
    void ended.end().catch(() => {}).then(() => lease.sweep()).catch(() => {});
    for (const peer of this.wtPeers.values()) {
      peer.destroy();
    }
    this.wtPeers.clear();
    this.wtRetired.clear();
    this.wtRequested.clear();

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
    this.iceUnsubscribe?.();
    this.iceUnsubscribe = null;
    this.resetTransfers();
    // No session follows a destroy: its fresh lease goes too.
    void this.lease.end().catch(() => {});
    this.connectedPeers.clear();
    this.clientP?.then((client) => client.destroy(() => {}));
    this.clientP = null;
  }

  private async seedSingle(
    file: File,
    protectedDescriptor?: FileEntry,
    /** The ciphertext's own pieces, so seeding copies nothing (see CiphertextChunkStore). */
    pieces?: CiphertextChunkStore,
  ): Promise<FileEntry> {
    const signal = this.lifecycle.signal;
    const client = await this.client();
    signal.throwIfAborted();
    return new Promise<FileEntry>((resolve, reject) => {
      const torrent = client.seed(
        file,
        { announce: [], ...(protectedDescriptor ? {
          name: file.name, pieceLength: ENCRYPTED_PIECE_LENGTH, private: true, storeCacheSlots: 2,
          ...(pieces
            ? { preloadedStore: pieces as unknown as WebTorrentType.TorrentOptions["preloadedStore"] }
            : { store: OPFSChunkStore as unknown as WebTorrentType.TorrentOptions["store"], storeOpts: { lease: this.lease } }),
        } : {}) },
        (created: any) => {
          if (signal.aborted || (protectedDescriptor?.infoHash && protectedDescriptor.infoHash !== created.infoHash)) {
            created.destroy();
            reject(new Error("Encrypted torrent identity mismatch or cancelled"));
            return;
          }
          const descriptor: FileEntry = {
            ...protectedDescriptor,
            infoHash: created.infoHash,
            filename: protectedDescriptor?.filename ?? file.name,
            mimeType: protectedDescriptor?.mimeType ?? (file.type || "application/octet-stream"),
            size: protectedDescriptor?.size ?? file.size,
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
          rec(
            ev("file.announce", {
              d: { fileRef: refs().fileRef(descriptor.infoHash) },
            })
          );

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
            if (signal.aborted || (protectedDescriptor?.infoHash && protectedDescriptor.infoHash !== existing.infoHash)) {
              reject(new Error("Encrypted torrent identity mismatch or cancelled"));
              return;
            }
            const descriptor: FileEntry = {
              ...protectedDescriptor,
              infoHash: existing.infoHash,
              filename: protectedDescriptor?.filename ?? file.name,
              mimeType: protectedDescriptor?.mimeType ?? (file.type || "application/octet-stream"),
              size: protectedDescriptor?.size ?? file.size,
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
   * A stored file is seeded only when somebody asks for it, whichever
   * conversation it belongs to: before, every file of every other room and DM
   * had no torrent behind it, and the peer asking for one connected fine and
   * then found nothing to talk to. Doing it here covers every dial - first
   * download, manual retry, and the reconcile tick.
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
        const descriptor = this.knownFiles.get(infoHash) as FileEntry | undefined;
        // Served as ciphertext, never decrypted on its way out.
        if (descriptor?.encryption) await this.seedStoredFile(descriptor, await file.arrayBuffer()).catch(() => {});
        else await this.seedFiles([file]).catch(() => {});
        torrent = client.get(infoHash) as unknown as TorrentLike | null;
      }
      torrent = client.get(infoHash) as unknown as TorrentLike | null;
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
    initiator: boolean,
    /** The dialler's session, for a link we answer. */
    answering?: string
  ): boolean {
    const key = wtKey(infoHash, peerId);
    if (this.wtPeers.has(key)) return false;
    if (this.linkCount(initiator) >= (initiator ? MAX_WT_DIALS : MAX_WT_SERVES)) {
      return false;
    }
    let mine = 0;
    for (const existing of this.wtPeers.keys()) {
      if (existing.endsWith(`:${peerId}`)) mine += 1;
    }
    if (mine >= MAX_WT_PEERS_PER_PEER) return false;

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
    const session = initiator ? newSession() : answering;
    this.wtLinkMeta.set(peer, { session, initiator });

    peer.on("signal", (signal: unknown) => {
      this.emit("signal", peerId, {
        kind: "file-wt-signal",
        infoHash,
        signal,
        ...(session !== undefined ? { session } : {}),
      });
    });

    // webtorrent keys torrent._peers by `peer.id` and a bare SimplePeer has
    // none, so every WebRTC peer landed on the same `undefined` slot: the
    // second one silently overwrote the first, and either one closing called
    // removePeer(undefined) and tore down the survivor. One seeder/leecher
    // pair per file was the most that could ever work.
    (peer as unknown as { id: string }).id = peerId;

    // Cleared by whichever of connect/error/close arrives first; the whole
    // point is the case where none of them ever does.
    const connectDeadline = setTimeout(() => {
      if (this.wtPeers.get(key) !== peer) return;
      this.retireSession(key, session);
      this.wtPeers.delete(key);
      peer.destroy();
    }, WT_CONNECT_TIMEOUT_MS);

    peer.on("connect", () => {
      clearTimeout(connectDeadline);
      this.forgetRetryState(key);
      void this.attachToTorrent(infoHash, peer);
    });

    // Whichever way a link ends, its session is over: a late answer or
    // candidate for it must not start a link of its own.
    peer.on("error", () => {
      clearTimeout(connectDeadline);
      this.retireSession(key, session);
      if (this.wtPeers.get(key) === peer) this.wtPeers.delete(key);
    });

    peer.on("close", () => {
      clearTimeout(connectDeadline);
      this.retireSession(key, session);
      if (this.wtPeers.get(key) === peer) this.wtPeers.delete(key);
    });
    return true;
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

    const descriptor: FileEntry = this.knownFiles.get(infoHash) ?? fallback;
    const encrypted = !!descriptor.encryption;
    const signal = this.lifecycle.signal;

    /**
     * The torrent's REAL length against the size the sender signed.
     *
     * Nothing compared the two, so `size` was a claim the whole pipeline
     * then trusted: it decides the inline path, the persistence cap and
     * (now) the auto-download ceiling, while the bytes actually arriving
     * were whatever the swarm served. A file that announces 1 KB and
     * delivers 4 GB downloaded to completion. The metadata is authenticated
     * by the infoHash, so a mismatch is the SENDER lying about the size -
     * stop, do not keep fetching, and say so.
     */
    const enforceSignedLength = (): boolean => {
      if (seeding) return false;
      const actual = torrent.length;
      if (typeof actual !== "number") return false;
      const expected = encryptedFileSize(descriptor);
      if (encrypted ? actual === expected && (!torrent.files || (torrent.files.length === 1 && torrent.files[0].name === opaqueFileName(descriptor))) : actual <= expected) return false;
      this.attachedTorrents.delete(infoHash);
      try {
        torrent.destroy?.();
      } catch {
        // A torrent that will not tear down is still one we stop tracking.
      }
      const prev = this.transfers.get(infoHash);
      this.upsertTransfer({
        ...(prev ?? descriptor),
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status: "failed",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: this.seedersByHash.get(infoHash)?.size ?? prev?.seeders ?? 0,
        blobURL: prev?.blobURL,
        error: "File is larger than the sender announced",
      });
      rec(
        ev("file.fail", {
          d: {
            err: "size-mismatch",
            fileRef: refs().fileRef(infoHash),
          },
        })
      );
      return true;
    };

    const pushUpdate = () => {
      if (signal.aborted) return;
      const isSeeding = this.seedingByHash.get(infoHash) ?? seeding;
      const existing = this.transfers.get(infoHash);
      // A torrent we seed is "seeding" whatever webtorrent's done flag
      // says: it stays false for a seed here, and the first wire event
      // used to rewrite the sender's own file to "downloading" - which
      // then had the reconcile tick dialling peers for a file we hold.
      const status = isSeeding
        ? "seeding"
        : torrent.done && (!encrypted || this.plaintext.has(infoHash))
          ? "complete"
          : "downloading";
      const progress = torrent.progress ?? existing?.progress ?? 0;
      const done = isSeeding || (torrent.done && (!encrypted || this.plaintext.has(infoHash)));
      const peers = torrent.numPeers ?? existing?.peers ?? 0;
      const seeders = this.seedersByHash.get(infoHash)?.size ?? existing?.seeders ?? 0;
      // Nothing anyone can see moved - a seed serving one more block - so
      // there is nothing to tell the app.
      if (
        existing?.status === status && existing.progress === progress &&
        existing.done === done && existing.seeding === isSeeding &&
        existing.peers === peers && existing.seeders === seeders
      ) return;
      this.upsertTransfer({
        ...descriptor,
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status,
        progress,
        done,
        seeding: isSeeding,
        peers,
        seeders,
        blobURL: existing?.blobURL,
        error: existing?.error,
      });
    };
    // Progress, at most once a WT_PROGRESS_MS: the first report at once,
    // the latest of any that follow when the interval is up.
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let progressDue = false;
    const pushProgress = () => {
      if (progressTimer) {
        progressDue = true;
        return;
      }
      pushUpdate();
      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (!progressDue) return;
        progressDue = false;
        // Not for a torrent given up on since (a size lie, a failed
        // authentication, a reset): its last word stands.
        if (!this.attachedTorrents.has(infoHash) || (torrent as { destroyed?: boolean }).destroyed) return;
        pushProgress();
      }, WT_PROGRESS_MS);
    };

    if (this.attachedTorrents.has(infoHash)) {
      pushUpdate();
      return;
    }

    this.attachedTorrents.add(infoHash);
    // Length is unknown until the metadata lands for a hash-only add, and
    // already known when we picked up a torrent the client held - check both.
    torrent.on("metadata", () => {
      if (!enforceSignedLength()) pushUpdate();
    });
    if (enforceSignedLength()) return;
    torrent.on("download", pushProgress);
    torrent.on("upload", pushProgress);
    torrent.on("wire", pushProgress);

    torrent.on("done", () => {
      if (signal.aborted || enforceSignedLength()) return;
      pushUpdate();
      if (this.seedingByHash.get(infoHash)) return;
      // Manual WebRTC peers have no tracker to rotate idle connections for
      // us. Finished downloads otherwise occupy the per-peer cap forever,
      // starving every subsequent image above the inline limit. Keep the
      // torrent (and its bytes) available for new inbound seeding requests.
      for (const [key, peer] of this.wtPeers) {
        if (!key.startsWith(`${infoHash}:`)) continue;
        this.wtPeers.delete(key);
        peer.destroy();
      }
      this.reconcileWtPeers();
      const file = torrent.files?.[0];
      if (!file) return;
      if (encrypted) {
        if (this.publishing.has(infoHash)) return;
        this.publishing.add(infoHash);
        void (async () => {
          if (!file.createReadStream) throw new Error("Streaming torrent support required");
          const ciphertext = await writeCiphertext(infoHash, file.createReadStream(), signal);
          const plain = await stageDecryptedFile(ciphertext, descriptor.encryption!, descriptor.filename, descriptor.mimeType, signal);
          if (signal.aborted) { await plain.dispose(); return; }
          this.plaintext.set(infoHash, plain);
          this.localSeedHashes.add(infoHash);
          this.seedingByHash.set(infoHash, true);
          this.upsertTransfer({ ...descriptor, status: "seeding", done: true, seeding: true,
            progress: 1, peers: torrent.numPeers ?? 0, seeders: 1, blobURL: URL.createObjectURL(plain.file) });
          this.emit("downloaded", infoHash, plain.file);
        })().catch(async () => {
          await removeCiphertext(infoHash).catch(() => {});
          torrent.destroy?.();
          this.attachedTorrents.delete(infoHash);
          if (!signal.aborted) this.upsertTransfer({ ...descriptor, status: "failed", done: false,
            seeding: false, progress: 0, peers: 0, seeders: 0, blobURL: undefined,
            error: "Encrypted file authentication failed" });
        }).finally(() => this.publishing.delete(infoHash));
        return;
      }
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
      rec(
        ev("file.fail", {
          d: { err: errText(err), fileRef: refs().fileRef(infoHash) },
        })
      );
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
