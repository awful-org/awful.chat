/**
 * /qs - hand a file to one person or several, with no account and no room.
 *
 * Multi-peer: everyone holding the link is in one swarm. A receiver that
 * finishes a file starts serving it too, so the sender uploads once rather
 * than once per person - and can close the tab as soon as somebody has it,
 * because the others can now get it from each other.
 *
 * Deliberately built on the two storage-free layers and nothing else:
 * LibP2PTransport for introduction and signalling, WebTorrentFileTransport
 * for the bytes. It does NOT import transport.svelte.ts, which would drag in
 * the message store, the attachment store and at-rest crypto - all of which
 * exist to remember things this page must not remember. Nothing here touches
 * IndexedDB or localStorage, so "gone when the tab closes" is a property of
 * the code rather than a cleanup routine that has to run.
 *
 * The same two consequences as sync.svelte.ts, for the same reason: this is a
 * SECOND libp2p node in the profile, so it connects with no key seed (a fresh
 * random peerId, never the device key) and takes no node lock. Two nodes with
 * two peerIds coexist; two nodes with ONE peerId are the reconnect loop from
 * the 2026-09-04 and 09-06 diag packs.
 *
 * What is honestly true about "no relay": the relay introduces the two peers
 * and may carry the first hop, and TURN may carry WebRTC when both sides are
 * behind symmetric NAT. The FILE never touches a server - it goes over the
 * WebRTC link WebTorrent builds, peer to peer.
 */

import { LibP2PTransport } from "$lib/transport/libp2p/transport";
import { WebTorrentFileTransport } from "$lib/transport/file/webtorrent";
import { refreshTurnCredentials } from "$lib/transport/ice-server-list";
import { isConfigured } from "$lib/runtime-config";
import { newQuickCode, normalizeQuickCode } from "$lib/room-code";
import { quickSessionSeed } from "./session-key";
import { decode, encode } from "$lib/utils";
import {
  isFileSignalWireMessage,
  type FileSignalWireMessage,
} from "$lib/types/message";
import type {
  FileDescriptor,
  FileTransferSnapshot,
} from "$lib/transport/types";

export type QuickSendStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "failed"
  /** A one-time link that has delivered. Nothing more is served from here. */
  | "closed";

/**
 * What the link is for.
 *
 * `multi` - everyone holding it is in one swarm and serves what they have
 * finished, so the sender can leave once somebody has the file. The link
 * stays good for as long as anyone in it still holds the bytes.
 *
 * `once` - the link is for ONE delivery. Receivers do not serve it on, and
 * the sender stops the moment a receiver says it has the whole file, so the
 * link is dead from then on. This is about a link that LEAKS after you sent
 * it - a group chat scrolled back through, a forwarded message, a shared
 * laptop - not about the person you sent it to, who has the file and can do
 * what they like with it.
 */
export type QuickSendMode = "multi" | "once";

/**
 * /qs speaks two small messages of its own on top of the file signals.
 *
 * Deliberately NOT extra kinds on FileSignalEnvelope: the main app shares
 * that union and would have to grow a case for something only this page says.
 */
type QuickWire =
  | { type: "__qs_mode"; mode: QuickSendMode }
  | { type: "__qs_ack"; infoHash: string };

function isQuickWire(value: unknown): value is QuickWire {
  const t = (value as { type?: unknown } | null)?.type;
  return t === "__qs_mode" || t === "__qs_ack";
}

interface QuickSendState {
  status: QuickSendStatus;
  /** The room code, which IS the secret. Empty until start() runs. */
  code: string;
  /** True when this device generated the code rather than following a link. */
  isHost: boolean;
  error: string | null;
  /** How many other people the relay places in this code right now. */
  peers: number;
  /** Files this device is seeding, newest last. */
  offered: FileDescriptor[];
  /** Files the other side has offered, newest last. */
  incoming: FileDescriptor[];
  /** infoHash -> live progress, for both directions. */
  transfers: Map<string, FileTransferSnapshot>;
  /** What this page offers under. Only the page that minted the code sets it. */
  mode: QuickSendMode;
  /**
   * The strictest mode anyone in this room has announced.
   *
   * Strictest, not latest: everyone here already holds the link, so a peer
   * could otherwise announce "multi" and talk the others into serving on a
   * file whose sender asked for one delivery. Once heard, `once` sticks.
   */
  heardMode: QuickSendMode;
  /** A one-time link that has already delivered. */
  closed: boolean;
}

export const quickSend = $state<QuickSendState>({
  status: "idle",
  code: "",
  isHost: false,
  error: null,
  peers: 0,
  offered: [],
  incoming: [],
  transfers: new Map(),
  mode: "multi",
  heardMode: "multi",
  closed: false,
});

let transport: LibP2PTransport | null = null;
let files: WebTorrentFileTransport | null = null;
/**
 * The bytes behind everything this device offers, by infoHash.
 *
 * WebTorrent holds a seeded file itself, but a peer that arrives later asks
 * for it through the local lookup - which in the app reads the attachment
 * store. Here the File objects are simply kept, which is why closing the tab
 * ends the transfer: there is no copy anywhere else.
 *
 * ponytail: an in-memory Map, so an offered file is bounded by the tab's
 * memory and a received one by what a Blob can hold (~2 GB, less on mobile).
 * Streaming into showSaveFilePicker() lifts the receive side on Chromium; do
 * it when somebody actually hits the ceiling.
 */
const localFiles = new Map<string, File>();

/**
 * Whether to serve a file this device received.
 *
 * On by default: it is what makes the link multi-peer rather than a queue at
 * the sender, and the bytes are resident anyway - the received Blob is held
 * for the Save link whether or not anyone else wants it, so sharing costs
 * upload, not memory.
 *
 * Save-Data is the one honest exception. A receiver uploading is a cost they
 * never agreed to, and someone whose browser is asking every site on the
 * internet to use less data has agreed to it least of all. No setting for
 * this: the browser already carries the answer.
 */
function shouldReshare(): boolean {
  const conn = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return conn?.saveData !== true;
}

/** Peers we have wired into the file transport, so teardown is exact. */
const wired = new Set<string>();

function isRoomPeer(peerId: string): boolean {
  return !!transport && transport.isRoomPeer(quickSend.code, peerId);
}

/**
 * A peer only exists to this page once the RELAY places it in the code.
 *
 * The file transport announces our whole inventory to every peer it is told
 * about, so wiring a peer that merely dialled us would hand a stranger the
 * list of what this device is offering. Same attestation the app uses to
 * decide who may be told a room exists.
 */
function wirePeer(peerId: string): void {
  if (!files || wired.has(peerId) || !isRoomPeer(peerId)) return;
  wired.add(peerId);
  files.onPeerConnect(peerId);
  // Before anything is served: a receiver has to know not to serve it on.
  sendQuick(peerId, { type: "__qs_mode", mode: quickSend.mode });
  refreshPeerCount();
}

function sendQuick(peerId: string, msg: QuickWire): void {
  void transport?.send(peerId, encode(msg));
}

/** Tell everyone here what this link is for. */
function announceMode(): void {
  for (const peerId of wired) {
    sendQuick(peerId, { type: "__qs_mode", mode: quickSend.mode });
  }
}

/**
 * Set what the link is for. The page that minted the code owns this; a page
 * that followed a link takes the sender's word for it (see heardMode).
 */
export function setQuickSendMode(mode: QuickSendMode): void {
  if (quickSend.mode === mode) return;
  quickSend.mode = mode;
  if (mode === "once") quickSend.heardMode = "once";
  announceMode();
}

/**
 * A one-time link has done its job.
 *
 * Leaving the room is what closes it: a peer is only ever wired once the
 * relay places it here (wirePeer), so nobody new can be told what we hold.
 * Transfers already running are direct WebRTC links and finish on their own -
 * cutting somebody off mid-file to enforce a promise about NEW arrivals
 * would be pure spite. The seeded copy is deliberately left in place for
 * exactly that reason.
 */
function closeLink(): void {
  if (quickSend.closed) return;
  quickSend.closed = true;
  quickSend.status = "closed";
  transport?.leaveRoom(quickSend.code);
  wired.clear();
  quickSend.peers = 0;
}

function unwirePeer(peerId: string): void {
  if (!wired.delete(peerId)) return;
  files?.onPeerDisconnect(peerId);
  refreshPeerCount();
}

function refreshPeerCount(): void {
  quickSend.peers = transport?.peersInRoom(quickSend.code).length ?? 0;
}

function putTransfer(snapshot: FileTransferSnapshot): void {
  // A new Map, not a mutation: $state does not deep-proxy a Map, so .set on
  // the existing one updates the data and re-renders nothing.
  const next = new Map(quickSend.transfers);
  next.set(snapshot.infoHash, snapshot);
  quickSend.transfers = next;
}

function noteIncoming(file: FileDescriptor): void {
  if (localFiles.has(file.infoHash)) return; // our own, echoed back
  if (quickSend.incoming.some((f) => f.infoHash === file.infoHash)) return;
  quickSend.incoming = [...quickSend.incoming, file];
}

function handleQuickWire(msg: QuickWire): void {
  if (msg.type === "__qs_mode") {
    // Strictest wins and never relaxes - see heardMode.
    if (msg.mode === "once") quickSend.heardMode = "once";
    return;
  }
  // An ack for something WE offered, on a one-time link: delivered, so the
  // link is done. An ack for anything else is somebody else's business.
  if (quickSend.mode !== "once" || quickSend.closed) return;
  if (!quickSend.offered.some((f) => f.infoHash === msg.infoHash)) return;
  closeLink();
}

/**
 * Join a code, or mint one. Idempotent for the same code so a re-render or a
 * revisit does not build a second node.
 */
export async function startQuickSend(joinCode?: string): Promise<void> {
  const code = joinCode ? normalizeQuickCode(joinCode) : newQuickCode();
  if (!code) {
    quickSend.status = "failed";
    quickSend.error = "That does not look like a quick send code.";
    return;
  }
  if (transport && quickSend.code === code) return;
  if (transport) stopQuickSend();

  quickSend.code = code;
  quickSend.isHost = !joinCode;
  quickSend.status = "connecting";
  quickSend.error = null;

  if (!isConfigured()) {
    quickSend.status = "failed";
    quickSend.error = "This instance has no relay configured.";
    return;
  }

  // TURN before the first dial, exactly as the app's own connect does: the
  // list starts STUN-only and a pair behind symmetric NAT never links
  // without it.
  refreshTurnCredentials().catch(() => {});

  const t = new LibP2PTransport({ diagBus: "qs" });
  const f = new WebTorrentFileTransport(() => t.selfId());
  transport = t;
  files = f;

  f.setLocalFileLookup(async (infoHash) => localFiles.get(infoHash) ?? null);

  f.on("signal", (peerId, envelope) => {
    void t.send(
      peerId,
      encode({
        type: "__file_signal",
        payload: envelope,
      } satisfies FileSignalWireMessage)
    );
  });
  f.on("transfer", (snapshot) => putTransfer(snapshot));
  f.on("downloaded", (infoHash, blob) => {
    const desc = quickSend.incoming.find((f) => f.infoHash === infoHash);
    if (!desc) return;
    // Say so first, and whatever the mode: it is what lets a one-time link
    // know it is done, and it costs one small frame.
    for (const peerId of wired) {
      sendQuick(peerId, { type: "__qs_ack", infoHash });
    }
    // A one-time link is ONE delivery, so this copy goes no further. In
    // multi-peer this is what makes the swarm a swarm: seedFiles announces to
    // every peer we are wired to, so the next person to ask has two places to
    // pull from - and localFiles is what serves it, exactly as it serves the
    // sender's own.
    if (quickSend.heardMode === "once" || !shouldReshare()) return;
    const file = new File([blob], desc.filename, { type: desc.mimeType });
    localFiles.set(infoHash, file);
    void f.seedFiles([file]);
  });

  t.on("connect", wirePeer);
  t.on("disconnect", unwirePeer);
  // The relay's membership reply is what makes a peer real here, and it can
  // land either side of the connection - a peer already connected fires no
  // second connect event.
  t.on("roomPeers", (room, peerIds) => {
    if (room !== quickSend.code) return;
    for (const peerId of peerIds) wirePeer(peerId);
    refreshPeerCount();
  });
  t.on("message", (peerId, data) => {
    if (!isRoomPeer(peerId)) return;
    let decoded: unknown;
    try {
      decoded = decode(data);
    } catch {
      return; // not ours; this page speaks three message types
    }
    if (isQuickWire(decoded)) {
      handleQuickWire(decoded);
      return;
    }
    if (!isFileSignalWireMessage(decoded)) return;
    if (decoded.payload.kind === "file-seeder") {
      noteIncoming(decoded.payload.file);
    }
    f.handleSignal(peerId, decoded.payload);
  });

  try {
    // A per-page key, never the device key - and the SAME one on every
    // reconnect, so a relay bounce does not turn us into a stranger.
    await t.connect(quickSessionSeed());
    t.joinRoom(code);
    quickSend.status = "ready";
    refreshPeerCount();
  } catch (err) {
    quickSend.status = "failed";
    quickSend.error = err instanceof Error ? err.message : String(err);
  }
}

/** Seed files and announce them to whoever is already here. */
export async function offerFiles(picked: File[]): Promise<void> {
  if (!files || !picked.length) return;
  const descriptors = await files.seedFiles(picked);
  descriptors.forEach((desc, i) => {
    const file = picked[i];
    if (file) localFiles.set(desc.infoHash, file);
  });
  const known = new Set(quickSend.offered.map((f) => f.infoHash));
  quickSend.offered = [
    ...quickSend.offered,
    ...descriptors.filter((d) => !known.has(d.infoHash)),
  ];
}

/**
 * Pull a file the other side offered.
 *
 * A click, never automatic: the descriptor is the sender's own claim, and
 * bytes nobody asked for is the one thing a page like this must not do.
 */
export function acceptFile(infoHash: string, retry = false): void {
  const file = quickSend.incoming.find((f) => f.infoHash === infoHash);
  if (file) files?.ensureDownload(file, { retry });
}

export function stopQuickSend(): void {
  for (const snapshot of quickSend.transfers.values()) {
    if (snapshot.blobURL) URL.revokeObjectURL(snapshot.blobURL);
  }
  files?.destroy();
  void transport?.disconnect();
  transport = null;
  files = null;
  localFiles.clear();
  wired.clear();
  quickSend.status = "idle";
  quickSend.code = "";
  quickSend.peers = 0;
  quickSend.offered = [];
  quickSend.incoming = [];
  quickSend.transfers = new Map();
  quickSend.error = null;
  // `mode` survives: it is this person's choice for the page, not state of a
  // particular link. What the room told us does not.
  quickSend.heardMode = quickSend.mode;
  quickSend.closed = false;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle, same reasoning as transport.svelte.ts's __awful: a
  // two-peer transfer is only observable with two real browsers.
  (window as unknown as Record<string, unknown>).__qs = {
    state: quickSend,
    offerFiles,
    acceptFile,
  };
}

/** The link to hand a friend. The code stays in the fragment - see App.svelte. */
export function quickSendLink(code: string): string {
  return `${window.location.origin}/qs#${code}`;
}
