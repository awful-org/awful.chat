import {
  attachmentEpoch,
  getAttachmentsByInfoHash,
  getAttachmentsByMessage,
  getAttachmentsWithData,
  getRoomParticipants,
  getSeedableFiles,
  putAttachment,
  updateAttachmentStatus,
  updateAttachmentData,
} from "$lib/storage";
import {
  _peerIdToDid,
  _transport,
  MAX_PERSISTED_ATTACHMENT_BYTES,
  transportState,
} from "./transport.svelte";
import type {
  Attachment,
  FileEntry,
  FileSignalWireMessage,
} from "$lib/types/message";
import { base64ToBytes, encode } from "$lib/utils";
import { mediaPrefs } from "$lib/media-prefs.svelte";
import { SvelteSet } from "svelte/reactivity";
import type { FileTransferSnapshot } from "./types";
import type { WebTorrentFileTransport } from "./file/webtorrent";

let _fileTransport: WebTorrentFileTransport | null = null;
let _initialized = false;

function getFileTransport(): WebTorrentFileTransport {
  if (!_fileTransport)
    throw new Error("File transport not initialized. Call initFiles() first.");
  return _fileTransport;
}

async function _persistAttachmentStatusForInfoHash(
  infoHash: string,
  status: Attachment["status"]
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  await Promise.all(
    attachments.map((attachment) =>
      updateAttachmentStatus(attachment.id, status)
    )
  );
}

async function _persistDownloadedBlob(
  infoHash: string,
  blob: Blob
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  if (!attachments.length) return;

  // The BLOB's real length decides this, not attachment.size - that is the
  // sender's claim, taken from a wire descriptor. A row claiming 1 KB passed
  // the gate and whatever the torrent actually delivered was then read whole
  // and written to IndexedDB, so the cap bounded nothing an attacker cared
  // about. The bytes are in hand here; there is no reason to ask anyone else.
  const data =
    blob.size <= MAX_PERSISTED_ATTACHMENT_BYTES
      ? await blob.arrayBuffer()
      : undefined;

  // Patch, never whole-record put: the record read above predates the (long)
  // blob read, and a blind put clobbered whatever status the seeding path
  // wrote in the meantime.
  await Promise.all(
    attachments.map((attachment) =>
      data
        ? updateAttachmentData(attachment.id, data)
        : updateAttachmentStatus(attachment.id, "complete")
    )
  );
}

export function initFiles(fileTransport: WebTorrentFileTransport): void {
  if (_initialized) return;
  _initialized = true;
  _fileTransport = fileTransport;

  // Anything whose bytes we still hold can be served, whether or not its
  // conversation is the one currently open.
  _fileTransport.setLocalFileLookup(async (infoHash) => {
    const stored = (await getAttachmentsByInfoHash(infoHash)).find(
      (attachment) => attachment.data
    );
    if (!stored?.data) return null;
    return new File([stored.data], stored.filename, {
      type: stored.mimeType,
      lastModified: stored.createdAt,
    });
  });

  _fileTransport.on("signal", (peerId, envelope) => {
    _transport.send(
      peerId,
      encode({
        type: "__file_signal",
        payload: envelope,
      } satisfies FileSignalWireMessage)
    );
  });

  _fileTransport.on("transfer", (snapshot) => {
    withFileTransfer(snapshot);

    if (
      snapshot.status === "seeding" ||
      snapshot.status === "complete" ||
      snapshot.status === "failed"
    ) {
      _persistAttachmentStatusForInfoHash(
        snapshot.infoHash,
        snapshot.status
      ).catch(() => {});
    }
  });

  _fileTransport.on("downloaded", (infoHash, blob) => {
    _persistDownloadedBlob(infoHash, blob).catch(() => {});

    getAttachmentsByInfoHash(infoHash)
      .then(async (attachments) => {
        const existingTransfer = transportState.fileTransfers.get(infoHash);
        if (existingTransfer?.seeding) return;
        const attachment = attachments[0];
        if (!attachment) return;
        const file = new File([blob], attachment.filename, {
          type: attachment.mimeType,
          lastModified: Date.now(),
        });
        await getFileTransport().seedFiles([file]);
        await _persistAttachmentStatusForInfoHash(infoHash, "seeding");
      })
      .catch(() => {});
  });
}

/**
 * Ceiling for bytes that ride inline in the message itself. Kept well under
 * the 4MB frame limit even inside a sync batch (batches are size-aware).
 */
export const INLINE_FILE_MAX_BYTES = 512 * 1024;

/**
 * Pull the wire-only inline bytes out of a file message - ALWAYS, before the
 * message is stored anywhere - and adopt them in the background: verify
 * against the signed infoHash, persist, seed, render.
 */
export function stripAndAdoptInlineFiles(msg: {
  id: string;
  roomCode: string;
  meta?: { files: FileEntry[] };
}): void {
  for (const file of msg.meta?.files ?? []) {
    const b64 = file.inline;
    if (b64 === undefined) continue;
    delete file.inline;
    if (typeof b64 !== "string" || b64.length > INLINE_FILE_MAX_BYTES * 1.5) {
      continue;
    }
    _adoptInline(msg.roomCode, msg.id, file, b64).catch(() => {});
  }
}

async function _adoptInline(
  roomCode: string,
  messageId: string,
  file: FileEntry,
  b64: string
): Promise<void> {
  const existing = await getAttachmentsByInfoHash(file.infoHash);
  if (existing.some((a) => a.data)) return; // already hold the bytes
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return;
  }
  if (bytes.byteLength !== file.size) return;

  const f = new File([bytes], file.filename, { type: file.mimeType });
  // The infoHash is inside the message signature and seeding recomputes it
  // from the bytes, so a match proves these are the bytes the sender signed -
  // inline data needs no trust in the peer that relayed it.
  const [desc] = await getFileTransport().seedFiles([f]);
  if (desc?.infoHash !== file.infoHash) {
    console.warn(
      "[files] inline bytes do not match the signed infoHash - ignored"
    );
    return;
  }

  // The live message handler creates the attachment records; give it a
  // moment before concluding this message has none (the sync path never
  // creates any, so after the wait we make our own). A short POLL, not one
  // blind 2s sleep - that sleep was a 2-second floor on every received
  // image before its bytes registered and the picture appeared.
  let records = await getAttachmentsByMessage(messageId);
  for (let i = 0; i < 10 && !records.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
    records = await getAttachmentsByMessage(messageId);
  }
  const buf = bytes.buffer as ArrayBuffer;
  if (records.length) {
    await Promise.all(
      records
        .filter((r) => r.infoHash === file.infoHash && !r.data)
        .map((r) => updateAttachmentData(r.id, buf))
    );
  } else {
    await putAttachment({
      id: crypto.randomUUID(),
      roomCode,
      messageId,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      infoHash: file.infoHash,
      width: file.width,
      height: file.height,
      status: "seeding",
      createdAt: Date.now(),
      data: buf,
    });
  }

  withFileTransfer({
    ...file,
    status: "seeding",
    progress: 1,
    done: true,
    seeding: true,
    peers: 0,
    seeders: 1,
    blobURL: URL.createObjectURL(f),
  });
}

export function isFileSignalWireMessage(
  value: unknown
): value is FileSignalWireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "__file_signal" &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    (value as { payload?: unknown }).payload !== null
  );
}

export function maybePeerIdFromSenderId(senderId: string): string | null {
  const connectedPeers = _transport.peers();
  if (connectedPeers.includes(senderId)) return senderId;
  for (const [peerId, did] of _peerIdToDid) {
    if (did === senderId && connectedPeers.includes(peerId)) return peerId;
  }
  return null;
}

/**
 * Ceiling on a fetch nobody asked for.
 *
 * Auto-download is ON by default for image/video/audio, so a single message
 * naming a large file makes every recipient pull it without a click - and the
 * size that decides "large" is the sender's own claim, checked against the
 * torrent's real length only once the metadata lands. 64 MB is well past any
 * ordinary photo, voice note or clip; anything bigger waits for its Download
 * button, which has no ceiling because a person asked for it.
 */
export const AUTO_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export function shouldAutoDownload(mimeType: string, size?: number): boolean {
  // The preference gates every automatic fetch path in one place - message
  // receipt, seeder announce and render-time backfill all route through
  // here. Off means media waits for its Download button like any other file.
  if (!mediaPrefs.autoDownloadMedia) return false;
  if (typeof size === "number" && size > AUTO_DOWNLOAD_MAX_BYTES) return false;
  // Audio joins the list so a track can just be played: the inline player has
  // nothing to play until the bytes are here, and audio is smaller than the
  // video already being fetched.
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/")
  );
}

export async function fileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function withFileTransfer(snapshot: FileTransferSnapshot): void {
  const prev = transportState.fileTransfers.get(snapshot.infoHash);

  // Determine which blobURL to use: defensively prefer existing one unless
  // snapshot provides a new one with a status indicating completion
  let blobURLToUse = prev?.blobURL;
  if (snapshot.blobURL) {
    // Only accept snapshot's blobURL if we don't have one yet, or if status
    // indicates a fresh transfer (complete or seeding)
    if (!prev?.blobURL || snapshot.status === "complete" || snapshot.status === "seeding") {
      blobURLToUse = snapshot.blobURL;
    }
  }

  // Revoke previous blobURL if we're replacing it with a different one
  if (prev?.blobURL && blobURLToUse && prev.blobURL !== blobURLToUse) {
    URL.revokeObjectURL(prev.blobURL);
  }

  const nextSnapshot: FileTransferSnapshot = {
    ...(prev ?? {}),
    ...snapshot,
    blobURL: blobURLToUse,
  } as FileTransferSnapshot;
  const next = new Map(transportState.fileTransfers);
  next.set(snapshot.infoHash, nextSnapshot);
  transportState.fileTransfers = next;
}

/**
 * The seedable set, cached until the attachment store changes. Peers reconnect
 * often enough that re-walking every stored blob on each one is not free.
 */
let _seedable: { epoch: number; entries: Awaited<ReturnType<typeof getSeedableFiles>> } | null =
  null;

async function _seedableEntries() {
  if (_seedable?.epoch === attachmentEpoch()) return _seedable.entries;
  const entries = await getSeedableFiles();
  _seedable = { epoch: attachmentEpoch(), entries };
  return entries;
}

/**
 * Tell a peer about every file we hold that belongs to a room they are in.
 *
 * Seeding is resumed only for the conversation that is open, and a peer only
 * ever dials a seeder it was told about - so a file in any other room was
 * invisible even though its bytes were sitting right here. The room-membership
 * filter is the point: an inventory of everything we hold is not a peer's
 * business, and for a room they ARE in they already have this metadata from
 * the message itself.
 */
export async function _announceStoredFilesTo(peerId: string): Promise<void> {
  const did = _peerIdToDid.get(peerId);
  if (!did) return;
  const entries = await _seedableEntries();
  const shared = new Map<string, boolean>();
  for (const { roomCode, file } of entries) {
    let isMember = shared.get(roomCode);
    if (isMember === undefined) {
      isMember = (await getRoomParticipants(roomCode)).includes(did);
      shared.set(roomCode, isMember);
    }
    if (!isMember) continue;
    _transport.send(
      peerId,
      encode({
        type: "__file_signal",
        payload: { kind: "file-seeder", file },
      } satisfies FileSignalWireMessage)
    );
  }
}

export async function _hydrateFileTransfersFromStorage(
  roomCode: string
): Promise<Attachment[]> {
  const seedable = await getAttachmentsWithData(roomCode);
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
  }

  for (const attachment of dedup.values()) {
    if (!attachment.data) continue;
    const file: FileEntry = {
      infoHash: attachment.infoHash,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    const blobURL = URL.createObjectURL(
      new Blob([attachment.data], { type: attachment.mimeType })
    );
    withFileTransfer({
      ...file,
      status: attachment.status,
      progress: 1,
      done: true,
      seeding: attachment.status === "seeding",
      peers: 0,
      seeders: attachment.status === "seeding" ? 1 : 0,
      blobURL,
    });
  }
  return [...dedup.values()];
}

export async function _resumeAttachmentSeeding(
  roomCode: string,
  prefetched?: Attachment[]
): Promise<void> {
  // `prefetched` skips a SECOND full decrypt pass when hydration just did
  // one - hydrate + reseed each decrypting every image in the room doubled
  // the heaviest work a room open does.
  const seedable = prefetched ?? (await getAttachmentsWithData(roomCode));
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
  }

  const files = [...dedup.values()].map(
    (attachment) =>
      new File([attachment.data!], attachment.filename, {
        type: attachment.mimeType,
        lastModified: attachment.createdAt,
      })
  );
  if (!files.length) return;

  const seeded = await getFileTransport().seedFiles(files);
  await Promise.all(
    seeded.map((entry) =>
      _persistAttachmentStatusForInfoHash(entry.infoHash, "seeding")
    )
  );
}

/**
 * Blob URLs + torrent re-seeding from ONE decrypt pass, meant to run in the
 * BACKGROUND of a room open. Awaiting this in the open path froze the UI
 * for as long as it takes to decrypt every stored image and re-hash it for
 * WebTorrent - after a restart with a picture-heavy room, that read as the
 * app being dead. Images now pop in as they hydrate instead.
 */
/**
 * Which room's stored attachments are being read back right now. Between a
 * room opening and this finishing, a file this device holds has no transfer
 * entry yet, and its chip read "0 seeders" as if it would never arrive; the
 * chip says "loading" instead while this names the room.
 */
export const attachmentHydration = { rooms: new SvelteSet<string>() };
const _hydrating = new Map<string, number>();

export async function _hydrateAndSeedAttachments(
  roomCode: string
): Promise<void> {
  // Counted per room: a room and a DM hydrate at the same time, and the
  // same room can be reopened while its first pass is still reading, so a
  // single flag was cleared by whichever finished first.
  _hydrating.set(roomCode, (_hydrating.get(roomCode) ?? 0) + 1);
  attachmentHydration.rooms.add(roomCode);
  try {
    const rows = await _hydrateFileTransfersFromStorage(roomCode);
    await _resumeAttachmentSeeding(roomCode, rows);
  } finally {
    const left = (_hydrating.get(roomCode) ?? 1) - 1;
    if (left <= 0) {
      _hydrating.delete(roomCode);
      attachmentHydration.rooms.delete(roomCode);
    } else {
      _hydrating.set(roomCode, left);
    }
  }
}
