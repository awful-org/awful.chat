/**
 * /qs - send a file to one person, with no account and no room.
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

export type QuickSendStatus = "idle" | "connecting" | "ready" | "failed";

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
  refreshPeerCount();
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
      return; // not ours; this page speaks one message type
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
