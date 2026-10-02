import {
  attachmentEpoch,
  getAttachment,
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
import type { FileTransferSnapshot, FileSignalEnvelope } from "./types";
import type { WebTorrentFileTransport } from "./file/webtorrent";
import { ROOM_SECURITY_V2_RELEASED } from "$lib/room-security/invitation-release";
import { isLegacyArchive } from "$lib/room-security/legacy-archive";
import { safeBlobType } from "$lib/safe-mime";

let _fileTransport: WebTorrentFileTransport | null = null;
let _initialized = false;
let _fileEpoch = 0;

function fileOperationGuard(): () => void {
  const epoch = _fileEpoch;
  return () => {
    if (epoch !== _fileEpoch) throw new Error("Attachment session ended");
  };
}

function getFileTransport(): WebTorrentFileTransport {
  if (!_fileTransport)
    throw new Error("File transport not initialized. Call initFiles() first.");
  return _fileTransport;
}

/** False when no row holds the file yet - its message is still being stored. */
async function _persistAttachmentStatusForInfoHash(
  infoHash: string,
  status: Attachment["status"],
  guard = fileOperationGuard(),
): Promise<boolean> {
  // The ids and statuses only: the file bytes stay sealed.
  const attachments = await getAttachmentsByInfoHash(infoHash, { skipBytes: true });
  guard();
  await Promise.all(
    attachments.map((attachment) =>
      attachment.status === status
        ? undefined
        : updateAttachmentStatus(attachment.id, status, guard)
    )
  );
  return attachments.length > 0;
}

/**
 * The status each file's rows were last brought to this session. A torrent
 * reports itself for every block it moves - a request in, a header and a
 * block out, three times per 16 KiB served - and every report re-read the
 * file's rows twice, decrypting the whole file each time, to find the
 * status already written: serving one 5 MB picture to one peer decrypted
 * gigabytes, and the reads queued up faster than they drained.
 */
const _persistedStatus = new Map<string, Attachment["status"]>();

async function _persistDownloadedBlob(
  infoHash: string,
  blob: Blob
): Promise<void> {
  const guard = fileOperationGuard();
  const fileTransport = getFileTransport();
  const attachments = await getAttachmentsByInfoHash(infoHash, { skipBytes: true });
  guard();
  if (!attachments.length) return;

  // The BLOB's real length decides this, not attachment.size - that is the
  // sender's claim, taken from a wire descriptor. A row claiming 1 KB passed
  // the gate and whatever the torrent actually delivered was then read whole
  // and written to IndexedDB, so the cap bounded nothing an attacker cared
  // about. The bytes are in hand here; there is no reason to ask anyone else.
  const data =
    attachments.some(attachment => !attachment.encryption) && blob.size <= MAX_PERSISTED_ATTACHMENT_BYTES
      ? await blob.arrayBuffer()
      : undefined;

  // Patch, never whole-record put: the record read above predates the (long)
  // blob read, and a blind put clobbered whatever status the seeding path
  // wrote in the meantime.
  await Promise.all(
    attachments.map((attachment) =>
      attachment.encryption
        ? fileTransport.persistableCiphertext(infoHash, MAX_PERSISTED_ATTACHMENT_BYTES).then(ciphertext => {
            guard();
            return ciphertext ? updateAttachmentData(attachment.id, ciphertext, guard) : updateAttachmentStatus(attachment.id, "seeding", guard);
          })
        : data
        ? updateAttachmentData(attachment.id, data, guard)
        : updateAttachmentStatus(attachment.id, "complete", guard)
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
    const epoch = _fileEpoch;
    const rows = await getAttachmentsByInfoHash(infoHash, { skipBytes: true });
    if (epoch !== _fileEpoch) return null;
    const encrypted = rows.find((attachment) => attachment.encryption);
    if (encrypted) {
      // Served as the ciphertext it is. This used to decrypt the file, and
      // publish it, just because a peer asked - for a conversation that need
      // not even be open.
      if (await getFileTransport().seedStoredFile(encrypted)) return null;
      // Not in this device's file store (a restored backup, a synced
      // device): the row's own copy, read only now that it is needed.
      const full = await getAttachment(encrypted.id);
      if (epoch === _fileEpoch && full?.data) await getFileTransport().seedStoredFile(full, full.data);
      return null;
    }
    if (!rows.length) return null;
    const stored = (await getAttachmentsByInfoHash(infoHash)).find((attachment) => attachment.data);
    if (epoch !== _fileEpoch) return null;
    if (!stored?.data) return null;
    if (stored.roomCode.startsWith("rd2_") || stored.roomCode.startsWith("dm-")) return null;
    return new File([stored.data], stored.filename, {
      type: stored.mimeType,
      lastModified: stored.createdAt,
    });
  }, async (infoHash, asked) => {
    // A download asked for a protected file: one this device holds is never
    // fetched again. One on screen already - sent from here this session,
    // or shown before - needs nothing.
    if (transportState.fileTransfers.get(infoHash)?.blobURL) return true;
    const epoch = _fileEpoch;
    const withBytes = new Set<string>();
    const rows = (await getAttachmentsByInfoHash(infoHash, { skipBytes: true, withBytes }))
      .filter((attachment) => attachment.encryption);
    const stored = rows.find((attachment) => withBytes.has(attachment.id)) ?? rows[0];
    if (epoch !== _fileEpoch || !stored) return false;
    // Its Download button, a plugin, auto-download as it comes on screen:
    // shown from here.
    if (asked) return restoreStoredFile(stored);
    // Nobody asked - a message arriving, a seeder announcing it. Held here,
    // it stays held until it is asked for or a room open shows it: every
    // peer announces all it holds on connecting, and showing each file it
    // named decrypted into memory the files of rooms nobody had opened.
    if (!withBytes.has(stored.id) && !(await getFileTransport().holdsCiphertext(stored))) return false;
    if (epoch !== _fileEpoch) return false;
    _markHeld(stored);
    return true;
  });

  _fileTransport.on("signal", (peerId, envelope) => {
    void routeFileSignal(peerId, envelope).catch(() => {});
  });

  _fileTransport.on("transfer", (snapshot) => {
    // A protected file seeded from its ciphertext alone - a peer asked for
    // it - is held here but was never decrypted, so it is not on screen:
    // it stays a file to ask for (auto-download, or its Download button),
    // which shows it from this device's copy. As "seeding" it showed
    // neither the picture nor the button.
    const unseen =
      !!snapshot.encryption && snapshot.status === "seeding" && !snapshot.blobURL &&
      !transportState.fileTransfers.get(snapshot.infoHash)?.blobURL;
    // Never adopt the file transport's own blobURL: it keeps that URL in its
    // own map and re-sends it on every wire/upload/seed event, so once this
    // map had swapped it for a URL of ours (and revoked it), the next event
    // swapped the dead one back in - and the room, already marked hydrated,
    // never rebuilt it. The picture for a download is minted below instead.
    withFileTransfer({
      ...snapshot,
      blobURL: undefined,
      ...(unseen ? { status: "pending" as const, done: false } : {}),
    });

    const { infoHash, status } = snapshot;
    if (
      (status === "seeding" || status === "complete" || status === "failed") &&
      _persistedStatus.get(infoHash) !== status
    ) {
      _persistedStatus.set(infoHash, status);
      // No row yet, or a write that failed: the next report tries again.
      const retry = () => {
        if (_persistedStatus.get(infoHash) === status) _persistedStatus.delete(infoHash);
      };
      _persistAttachmentStatusForInfoHash(infoHash, status).then(
        (stored) => { if (!stored) retry(); },
        retry,
      );
    }
  });

  _fileTransport.on("downloaded", (infoHash, blob, restored) => {
    const guard = fileOperationGuard();
    const current = transportState.fileTransfers.get(infoHash);
    if (current && !current.blobURL) {
      withFileTransfer({ ...current, blobURL: URL.createObjectURL(blob) });
    }
    // Read back from this device's own storage, there is nothing new to
    // keep: storing it anyway re-sealed the row of every file in every room
    // opened, once a session (a row missing its copy is mended by the room
    // open instead - see _keepRowCopies). Nor anything to seed below: a
    // stored file is always a protected one.
    if (restored) return;
    _persistDownloadedBlob(infoHash, blob).catch(() => {});

    getAttachmentsByInfoHash(infoHash, { skipBytes: true })
      .then(async (attachments) => {
        guard();
        const existingTransfer = transportState.fileTransfers.get(infoHash);
        if (existingTransfer?.seeding) return;
        const attachment = attachments[0];
        if (!attachment) return;
        if (attachment.encryption) return;
        if (attachment.roomCode.startsWith("rd2_") || attachment.roomCode.startsWith("dm-")) return;
        const file = new File([blob], attachment.filename, {
          type: attachment.mimeType,
          lastModified: Date.now(),
        });
        await getFileTransport().seedFiles([file]);
        guard();
        await _persistAttachmentStatusForInfoHash(infoHash, "seeding", guard);
      })
      .catch(() => {});
  });
}

/** A torrent announcing to all connected peers must not disclose a private
 * conversation's inventory. Resolve ownership before emitting any signaling.
 * Files not stored yet are announced by their signed chat message instead. */
async function routeFileSignal(peerId: string, envelope: FileSignalEnvelope): Promise<void> {
  const guard = fileOperationGuard();
  const infoHash = envelope.kind === "file-seeder" ? envelope.file.infoHash : envelope.infoHash;
  const room = await fileRoomForPeer(peerId, infoHash);
  guard();
  if (!room) return;
  _transport.sendRoom(peerId, room, encode({
    type: "__file_signal", payload: envelope,
  } satisfies FileSignalWireMessage));
}

/** Incoming v2 requests must arrive on the file's authenticated room channel,
 * not merely from someone who shares an unrelated conversation. */
export async function fileRoomForPeer(peerId: string, infoHash: string, incomingRoom?: string | null): Promise<string | null> {
  const epoch = _fileEpoch;
  // Every file signal asks this, once per candidate: rooms only, no bytes.
  const attachments = await getAttachmentsByInfoHash(infoHash, { skipBytes: true });
  if (epoch !== _fileEpoch) return null;
  const did = _peerIdToDid.get(peerId);
  const rooms = new Set(attachments.map(a => a.roomCode));
  for (const room of rooms) {
    if (ROOM_SECURITY_V2_RELEASED && !room.startsWith("rd2_") && !room.startsWith("dm-")) continue;
    if (incomingRoom !== undefined && (room.startsWith("rd2_") || room.startsWith("dm-")) && incomingRoom !== room) continue;
    const authorized = room.startsWith("rd2_") || room.startsWith("dm-")
      ? _transport.isRoomPeer(room, peerId)
      : !!did && (await getRoomParticipants(room)).includes(did);
    if (epoch !== _fileEpoch) return null;
    if (!authorized) continue;
    return room;
  }
  return null;
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
    if (file.encryption || msg.roomCode.startsWith("rd2_") || msg.roomCode.startsWith("dm-")) continue;
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
  const guard = fileOperationGuard();
  const existing = await getAttachmentsByInfoHash(file.infoHash);
  guard();
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
  guard();
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
  guard();
  for (let i = 0; i < 10 && !records.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
    guard();
    records = await getAttachmentsByMessage(messageId);
    guard();
  }
  const buf = bytes.buffer as ArrayBuffer;
  if (records.length) {
    await Promise.all(
      records
        .filter((r) => r.infoHash === file.infoHash && !r.data)
        .map((r) => updateAttachmentData(r.id, buf, guard))
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
    }, guard);
  }

  guard();
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

  // Every blobURL offered here was minted for this map alone, and an infoHash
  // names exactly one set of bytes - so the URL already on screen is as good
  // as any newer one. Keep it and drop the duplicate; swapping revoked a URL
  // that something still rendering (or re-sending) could hand back.
  const blobURLToUse = prev?.blobURL ?? snapshot.blobURL;
  if (snapshot.blobURL && snapshot.blobURL !== blobURLToUse) {
    URL.revokeObjectURL(snapshot.blobURL);
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
/**
 * The walk in progress, shared. Peers bind in bursts - every one at startup,
 * a roomful after a relay bounce - and each started a walk of its own over the
 * whole store before any of them could fill the cache.
 */
let _seedableRead: { epoch: number; fileEpoch: number; read: ReturnType<typeof getSeedableFiles> } | null =
  null;

async function _seedableEntries() {
  if (_seedable?.epoch === attachmentEpoch()) return _seedable.entries;
  const epoch = attachmentEpoch();
  const fileEpoch = _fileEpoch;
  let pending = _seedableRead;
  if (pending?.epoch !== epoch || pending.fileEpoch !== fileEpoch) {
    const read = getSeedableFiles();
    pending = _seedableRead = { epoch, fileEpoch, read };
    const clear = () => {
      if (_seedableRead?.read === read) _seedableRead = null;
    };
    read.then(clear, clear);
  }
  const entries = await pending.read;
  if (fileEpoch !== _fileEpoch) return [];
  if (epoch === attachmentEpoch()) _seedable = { epoch, entries };
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
  const epoch = _fileEpoch;
  const did = _peerIdToDid.get(peerId);
  if (!did) return;
  const entries = await _seedableEntries();
  if (epoch !== _fileEpoch) return;
  const shared = new Map<string, boolean>();
  for (const { roomCode, file } of entries) {
    if (ROOM_SECURITY_V2_RELEASED && !roomCode.startsWith("rd2_") && !roomCode.startsWith("dm-")) continue;
    let isMember = shared.get(roomCode);
    if (isMember === undefined) {
      isMember = roomCode.startsWith("rd2_") || roomCode.startsWith("dm-")
        ? _transport.isRoomPeer(roomCode, peerId)
        : (await getRoomParticipants(roomCode)).includes(did);
      shared.set(roomCode, isMember);
    }
    if (epoch !== _fileEpoch) return;
    if (!isMember) continue;
    _transport.sendRoom(
      peerId,
      roomCode,
      encode({
        type: "__file_signal",
        payload: { kind: "file-seeder", file },
      } satisfies FileSignalWireMessage)
    );
  }
}

/**
 * How much a room open decrypts by itself, every file together. A decrypted
 * file lives in memory for as long as it is shown (see stageDecryptedFile),
 * and reading back every file a room held cost as much memory as the room's
 * whole history: a picture-heavy room could end the tab on a phone. Newest
 * first, as long as a file fits; the rest wait to be asked for - auto-download
 * as they come on screen, or their Download button - and are then shown from
 * this device's copy (the restore handed to setLocalFileLookup), never
 * fetched again. A file already on screen, or being shown because it came on
 * screen, takes nothing from it.
 */
const EAGER_RESTORE_BUDGET_BYTES = AUTO_DOWNLOAD_MAX_BYTES;

export async function _hydrateFileTransfersFromStorage(
  roomCode: string
): Promise<Attachment[]> {
  if (isLegacyArchive(roomCode)) {
    await hydrateLegacyAttachments(roomCode);
    return [];
  }
  const epoch = _fileEpoch;
  // A secure room's files come back from this device's file store, so the
  // copies inside their rows stay sealed unless a file has nothing else.
  const secure = roomCode.startsWith("rd2_") || roomCode.startsWith("dm-");
  const withBytes = new Set<string>();
  const seedable = await getAttachmentsWithData(roomCode, { skipBytes: secure, withBytes });
  if (epoch !== _fileEpoch) return [];
  const dedup = new Map<string, Attachment>();
  /** Rows small enough to carry their file that do not: it is in this
   *  device's file store alone (see _keepRowCopies). */
  const bare = new Map<string, Attachment[]>();
  // Newest first: they are the ones on screen, and the room used to fill
  // in in storage key order - effectively at random.
  for (const attachment of [...seedable].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!attachment.data && !attachment.encryption) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
    if (attachment.encryption && !withBytes.has(attachment.id) && attachment.size <= MAX_PERSISTED_ATTACHMENT_BYTES) {
      bare.set(attachment.infoHash, [...(bare.get(attachment.infoHash) ?? []), attachment]);
    }
  }

  let budget = EAGER_RESTORE_BUDGET_BYTES;
  for (const attachment of dedup.values()) {
    if (epoch !== _fileEpoch) return [];
    if (attachment.encryption) {
      const { infoHash } = attachment;
      const current = transportState.fileTransfers.get(infoHash);
      // On screen already (sent, downloaded or opened before), being shown
      // because it came on screen, or being fetched.
      if (current?.blobURL || current?.status === "downloading" || _restoring.has(infoHash)) continue;
      if (attachment.size > budget) {
        _markHeld(attachment);
        continue;
      }
      budget -= attachment.size;
      // One file that will not open must not keep the rest of the room's
      // from showing.
      const shown = await restoreStoredFile(attachment).catch(() => false);
      const rows = bare.get(infoHash);
      if (shown && rows) void _keepRowCopies(rows).catch(() => {});
      continue;
    }
    if (roomCode.startsWith("rd2_") || roomCode.startsWith("dm-")) continue;
    if (!attachment.data) continue;
    const file: FileEntry = {
      infoHash: attachment.infoHash,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    // The type is the sender's claim: see safe-mime.ts.
    const blobURL = URL.createObjectURL(
      new Blob([attachment.data], { type: safeBlobType(attachment.mimeType) })
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

/** A held file a room open left for later: its Download button, with this
 *  device counted as a seeder. A transfer under way, or one that failed and
 *  says why, is left as it is. */
function _markHeld(attachment: Attachment): void {
  const current = transportState.fileTransfers.get(attachment.infoHash);
  if (current && current.status !== "pending") return;
  withFileTransfer({
    infoHash: attachment.infoHash, filename: attachment.filename,
    mimeType: attachment.mimeType, size: attachment.size,
    encryption: attachment.encryption, width: attachment.width, height: attachment.height,
    status: "pending", progress: 0, done: false, seeding: false, peers: 0,
    seeders: Math.max(1, current?.seeders ?? 0),
  });
}

/**
 * Rows that never got their copy of the file - its download finished before
 * the row was stored, or the write failed - get it now, once: a backup or a
 * synced device carries a file only in its row. Showing a stored file used to
 * rewrite every row it touched, every session; only these need it.
 */
async function _keepRowCopies(rows: Attachment[]): Promise<void> {
  const guard = fileOperationGuard();
  const ciphertext = await getFileTransport().persistableCiphertext(
    rows[0].infoHash,
    MAX_PERSISTED_ATTACHMENT_BYTES
  );
  guard();
  if (!ciphertext) return;
  await Promise.all(rows.map((row) => updateAttachmentData(row.id, ciphertext, guard)));
}

/**
 * Show one stored protected file at a time, whoever asks: a room open, the
 * file coming on screen (auto-download through the local restore) and a
 * plugin reading it used to decrypt it once each, all at once, and keep
 * every copy in memory.
 */
const _restoring = new Map<string, Promise<boolean>>();

/** Show one stored protected file: from this device's durable ciphertext
 *  when it holds it, else from the attachment row's own copy. False when
 *  neither is here. */
export function restoreStoredFile(attachment: Attachment): Promise<boolean> {
  const { infoHash } = attachment;
  let restoring = _restoring.get(infoHash);
  if (!restoring) {
    const restore = _restoreStoredFile(attachment).finally(() => {
      if (_restoring.get(infoHash) === restore) _restoring.delete(infoHash);
    });
    _restoring.set(infoHash, (restoring = restore));
  }
  return restoring;
}

async function _restoreStoredFile(attachment: Attachment): Promise<boolean> {
  const epoch = _fileEpoch;
  const transport = getFileTransport();
  if (attachment.data) return transport.restoreEncryptedFile(attachment, attachment.data);
  // A durable copy that will not open (damaged on disk) falls back to the
  // row's, as one that is missing does.
  if (await transport.restoreEncryptedFile(attachment).catch(() => false)) return true;
  const full = await getAttachment(attachment.id);
  if (epoch !== _fileEpoch || !full?.data) return false;
  return transport.restoreEncryptedFile(full, full.data);
}

export async function _resumeAttachmentSeeding(
  roomCode: string,
  prefetched?: Attachment[]
): Promise<void> {
  if (isLegacyArchive(roomCode)) return;
  const guard = fileOperationGuard();
  // `prefetched` skips a SECOND full decrypt pass when hydration just did
  // one - hydrate + reseed each decrypting every image in the room doubled
  // the heaviest work a room open does.
  const epoch = _fileEpoch;
  const seedable = prefetched ?? (await getAttachmentsWithData(roomCode));
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (epoch !== _fileEpoch) return;
    // Protected files are seeded when a peer asks for one (seedStoredFile,
    // through the local file lookup), straight from their ciphertext.
    if (attachment.encryption) continue;
    if (roomCode.startsWith("rd2_") || roomCode.startsWith("dm-")) continue;
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
  guard();
  await Promise.all(
    seeded.map((entry) =>
      _persistAttachmentStatusForInfoHash(entry.infoHash, "seeding", guard)
    )
  );
}

/**
 * Blob URLs for the room's stored files, meant to run in the BACKGROUND of a
 * room open. Awaiting this in the open path froze the UI for as long as it
 * takes to decrypt every stored image - after a restart with a picture-heavy
 * room, that read as the app being dead. Images now pop in as they hydrate
 * instead. Protected files are not seeded here: a peer that asks for one
 * gets it from its ciphertext (seedStoredFile), with nothing decrypted,
 * re-hashed or written for the files nobody asks for.
 */
/**
 * Which room's stored attachments are being read back right now. Between a
 * room opening and this finishing, a file this device holds has no transfer
 * entry yet, and its chip read "0 seeders" as if it would never arrive; the
 * chip says "loading" instead while this names the room.
 */
export const attachmentHydration = { rooms: new SvelteSet<string>() };
/** Storage-only restoration: never construct a file transport or announce bytes. */
export async function hydrateLegacyAttachments(
  roomCode: string,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isLegacyArchive(roomCode)) throw new Error("Not a legacy archive");
  const epoch = _fileEpoch;
  const rows = await getAttachmentsWithData(roomCode);
  if (epoch !== _fileEpoch || !stillCurrent()) return;
  for (const row of rows) {
    // Capability-bearing rows never fall back to plaintext restoration.
    if (row.roomCode !== roomCode || row.encryption || !row.data) continue;
    withFileTransfer({
      infoHash: row.infoHash, filename: row.filename, mimeType: row.mimeType,
      size: row.size, status: "complete", progress: 1, done: true,
      seeding: false, peers: 0, seeders: 0,
      blobURL: URL.createObjectURL(new Blob([row.data], { type: safeBlobType(row.mimeType) })),
    });
  }
}
const _hydrating = new Map<string, number>();
/**
 * Rooms whose attachments have already been decrypted and blob-URL'd this
 * session. A room switch does NOT clear transportState.fileTransfers, so
 * that work survives a reopen - redoing it (decrypt every stored image) on
 * every back-and-forth was the heaviest thing a room open did, for no gain.
 * New attachments that arrive while away are hydrated by their own receipt
 * path, not this bulk pass. Cleared by _resetAttachmentHydration when the
 * transfer map itself is reset (a new session), so a reconnect rebuilds from
 * scratch.
 */
const _hydratedRooms = new Set<string>();

export function _resetAttachmentHydration(): void {
  _fileEpoch++;
  _seedable = null;
  _seedableRead = null;
  _persistedStatus.clear();
  _restoring.clear();
  _hydratedRooms.clear();
  _hydrating.clear();
  attachmentHydration.rooms.clear();
}

export async function _hydrateAndSeedAttachments(
  roomCode: string
): Promise<void> {
  // Once per room per session. Skip a room already hydrated, and skip one
  // whose first pass is still running (a reopen mid-read would double the
  // decrypt work the counter below was only papering over).
  if (_hydratedRooms.has(roomCode) || _hydrating.has(roomCode)) return;
  const epoch = _fileEpoch;
  _hydrating.set(roomCode, (_hydrating.get(roomCode) ?? 0) + 1);
  attachmentHydration.rooms.add(roomCode);
  try {
    const rows = await _hydrateFileTransfersFromStorage(roomCode);
    if (epoch !== _fileEpoch) return;
    await _resumeAttachmentSeeding(roomCode, rows);
    if (epoch !== _fileEpoch) return;
    _hydratedRooms.add(roomCode);
  } finally {
    if (epoch !== _fileEpoch) return;
    const left = (_hydrating.get(roomCode) ?? 1) - 1;
    if (left <= 0) {
      _hydrating.delete(roomCode);
      attachmentHydration.rooms.delete(roomCode);
    } else {
      _hydrating.set(roomCode, left);
    }
  }
}
