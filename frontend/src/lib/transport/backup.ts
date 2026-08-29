/**
 * backup.ts - the on-disk/on-wire shape of a database export.
 *
 * Pure format logic only (no DOM, no IndexedDB, no runes) so it can be unit
 * tested: a backup file is untrusted input, and both the file restore and the
 * QR device sync depend on it round-tripping without silently dropping data.
 */

import { base64ToBytes, bytesToBase64 } from "../utils";
import { MessageType } from "../types/message";
import type { Message, Attachment, PendingMessage } from "../types/message";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
} from "../storage";

export interface AttachmentExport {
  id: string;
  roomCode: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string;
  /**
   * Base64 (current) or number[] (older exports). number[] quadrupled the
   * bytes as JSON text, which blew the 4MB sync frame cap on any real image
   * batch - the "stuck at 90%/20%" device sync.
   */
  data?: string | number[];
  status: Attachment["status"];
  createdAt: number;
}

export interface DatabaseExport {
  identity?: {
    mnemonic: {
      salt: number[];
      iv: number[];
      encrypted: number[];
      /**
       * PBKDF2 iteration count the mnemonic was encrypted with. MUST travel
       * with the record: the receiving device derives the key with it, and
       * guessing wrong makes the correct password look wrong. Absent means the
       * legacy 100k count (records written before this field existed).
       */
      iterations?: number;
    };
    keypair: { did: string; publicKey: number[] };
    // webauthn is intentionally NOT exported: the credential is bound to the
    // source device's authenticator and would only present a broken
    // biometric-unlock option elsewhere.
  };
  messages: Message[];
  attachments: AttachmentExport[];
  pending: PendingMessage[];
  watermarks: WatermarkRecord[];
  yjsDocs: { id: string; update: number[] }[];
  rooms: (Room | DMRoom)[];
  profiles: (PeerProfile | OwnProfile)[];
  savedGifs: SavedGif[];
}

export const BACKUP_FORMAT = "awful.chat/backup";
// v2: attachment and saved-gif bytes are base64 strings, not number[]. An
// old build restoring a v2 file would coerce the string to garbage bytes, so
// it must refuse cleanly on the version instead.
export const BACKUP_VERSION = 2;

export interface BackupFile extends DatabaseExport {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
}

export interface BackupSummary {
  hasIdentity: boolean;
  did: string | null;
  exportedAt: number | null;
  messages: number;
  rooms: number;
  attachments: number;
  profiles: number;
}

// Rooms and profiles carry avatar and banner bytes in an ArrayBuffer, which JSON
// turns into `{}` - silently losing the image on both a file backup and the QR sync.
// Convert to base64 strings on the way out and back on the way in.
export function pfpToJson<T extends { pfpData?: unknown; bannerData?: unknown }>(rec: T): T {
  const pfpData = rec?.pfpData;
  const bannerData = rec?.bannerData;
  const result = { ...rec };

  // Handle pfpData
  if (pfpData && !(pfpData instanceof Array)) {
    if (pfpData instanceof ArrayBuffer || ArrayBuffer.isView(pfpData)) {
      const bytes = ArrayBuffer.isView(pfpData)
        ? new Uint8Array(pfpData.buffer, pfpData.byteOffset, pfpData.byteLength)
        : new Uint8Array(pfpData);
      (result as any).pfpData = bytesToBase64(bytes);
    }
  }

  // Handle bannerData
  if (bannerData && !(bannerData instanceof Array)) {
    if (bannerData instanceof ArrayBuffer || ArrayBuffer.isView(bannerData)) {
      const bytes = ArrayBuffer.isView(bannerData)
        ? new Uint8Array(bannerData.buffer, bannerData.byteOffset, bannerData.byteLength)
        : new Uint8Array(bannerData);
      (result as any).bannerData = bytesToBase64(bytes);
    }
  }

  return result;
}

/**
 * Merge an imported room over the locally stored one (device sync, "add"
 * mode). Field rules mirror the monotonic guards used at runtime: the seen
 * watermark and per-participant activity never move backwards, membership is
 * a union, and a real local name is not overwritten by the import.
 */
export function mergeImportedRoom<T extends Room>(local: Room, imported: T): T {
  const participantLastSeen: Record<string, number> = {};
  for (const [did, ts] of Object.entries(local.participantLastSeen ?? {})) {
    participantLastSeen[did] = ts ?? 0;
  }
  for (const [did, ts] of Object.entries(imported.participantLastSeen ?? {})) {
    participantLastSeen[did] = Math.max(participantLastSeen[did] ?? 0, ts ?? 0);
  }
  return {
    ...imported,
    lastSeenLamport: Math.max(
      local.lastSeenLamport ?? 0,
      imported.lastSeenLamport ?? 0
    ),
    createdAt: Math.min(
      local.createdAt ?? Infinity,
      imported.createdAt ?? Infinity
    ),
    participants: [
      ...new Set([
        ...(local.participants ?? []),
        ...(imported.participants ?? []),
      ]),
    ],
    participantLastSeen,
    name:
      !local.name || local.name === local.roomCode ? imported.name : local.name,
  };
}

/** Accept both encodings of exported bytes; undefined for anything else. */
export function bytesFromExport(
  data: string | number[] | undefined
): ArrayBuffer | undefined {
  if (typeof data === "string") {
    try {
      return base64ToBytes(data).buffer;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  return undefined;
}

export function pfpFromJson<T extends { pfpData?: unknown; bannerData?: unknown }>(rec: T): T {
  const result = { ...rec } as Record<string, unknown>;

  // Handle pfpData - accept base64 string or legacy number[]
  const pfpData = rec?.pfpData;
  if (pfpData) {
    if (typeof pfpData === "string") {
      const bytes = bytesFromExport(pfpData);
      if (bytes) result.pfpData = bytes;
      else delete result.pfpData;
    } else if (Array.isArray(pfpData)) {
      result.pfpData = new Uint8Array(pfpData as number[]).buffer;
    } else if (!(pfpData instanceof ArrayBuffer)) {
      // `{}` from an older peer - drop it
      delete result.pfpData;
    }
  }

  // Handle bannerData - accept base64 string or legacy number[]
  const bannerData = rec?.bannerData;
  if (bannerData) {
    if (typeof bannerData === "string") {
      const bytes = bytesFromExport(bannerData);
      if (bytes) result.bannerData = bytes;
      else delete result.bannerData;
    } else if (Array.isArray(bannerData)) {
      result.bannerData = new Uint8Array(bannerData as number[]).buffer;
    } else if (!(bannerData instanceof ArrayBuffer)) {
      // `{}` from an older peer - drop it
      delete result.bannerData;
    }
  }

  return result as T;
}

/**
 * Parse and validate backup JSON.
 * Missing collections are coerced to empty arrays so a partial file cannot
 * crash the import half way through.
 *
 * @throws if the text is not a backup this build understands.
 */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON");
  }
  const d = parsed as Partial<BackupFile> | null;
  if (!d || typeof d !== "object" || d.format !== BACKUP_FORMAT) {
    throw new Error("That file is not an awful.chat backup");
  }
  if (typeof d.version !== "number" || d.version > BACKUP_VERSION) {
    throw new Error("That backup was made by a newer version of the app");
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    format: BACKUP_FORMAT,
    version: d.version,
    exportedAt: typeof d.exportedAt === "number" ? d.exportedAt : 0,
    identity: d.identity,
    messages: arr(d.messages),
    attachments: arr(d.attachments),
    pending: arr(d.pending),
    watermarks: arr(d.watermarks),
    yjsDocs: arr(d.yjsDocs),
    rooms: arr(d.rooms),
    profiles: arr(d.profiles),
    savedGifs: arr(d.savedGifs),
  };
}

export function summarizeBackup(data: BackupFile): BackupSummary {
  return {
    hasIdentity: !!data.identity,
    did: data.identity?.keypair?.did ?? null,
    exportedAt: data.exportedAt || null,
    messages: data.messages.length,
    rooms: data.rooms.length,
    attachments: data.attachments.length,
    profiles: data.profiles.length,
  };
}

// ── Record validation ─────────────────────────────────────────────────────────
//
// parseBackup only checks the envelope (format/version) and coerces each
// collection to an array - a hand-edited or truncated file, or a bug on the
// sending device, can still put per-record garbage into that array. This is
// NOT signature verification (a restored backup or a device-sync export is
// trusted at the file/transport level already; see verify-incoming.ts for
// why pre-v3 message history has none at all) - it only stops a malformed
// record from crashing the import partway through or writing something
// storage/UI code doesn't expect. Checks stay cheap: primitive type and
// presence only, no deep structural validation.

/** Records above this size are dropped rather than truncated - a truncated
 * message reads as a smaller, wrong message rather than as invalid. */
export const MAX_MESSAGE_CONTENT_LENGTH = 64 * 1024;

const VALID_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>([
  MessageType.Text,
  MessageType.Reply,
  MessageType.Reaction,
  MessageType.File,
  MessageType.PluginCard,
  MessageType.PluginUpdate,
]);

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Shape/size check for one imported message: id/roomCode/senderId as
 * strings, a known message type, a finite non-negative lamport, and content
 * within a sane size cap.
 */
export function isValidMessageRecord(m: unknown): m is Message {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.roomCode) &&
    isNonEmptyString(r.senderId) &&
    typeof r.type === "string" &&
    VALID_MESSAGE_TYPES.has(r.type) &&
    isFiniteNonNegative(r.lamport) &&
    (r.content === undefined ||
      r.content === null ||
      (typeof r.content === "string" &&
        r.content.length <= MAX_MESSAGE_CONTENT_LENGTH))
  );
}

export function isValidAttachmentRecord(a: unknown): a is AttachmentExport {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.roomCode) &&
    isNonEmptyString(r.messageId) &&
    typeof r.filename === "string" &&
    typeof r.mimeType === "string" &&
    isFiniteNonNegative(r.size) &&
    typeof r.infoHash === "string"
  );
}

export function isValidWatermarkRecord(w: unknown): w is WatermarkRecord {
  if (!w || typeof w !== "object") return false;
  const r = w as Record<string, unknown>;
  return (
    isNonEmptyString(r.roomCode) &&
    isNonEmptyString(r.senderId) &&
    isFiniteNonNegative(r.maxLamport)
  );
}

export function isValidRoomRecord(room: unknown): room is Room | DMRoom {
  if (!room || typeof room !== "object") return false;
  const r = room as Record<string, unknown>;
  return (
    // Only the key and the discriminator: rooms written by older builds
    // lack lastSeenLamport/createdAt, and a dropped room is data loss.
    isNonEmptyString(r.roomCode) &&
    typeof r.type === "string" &&
    (r.participants === undefined || Array.isArray(r.participants))
  );
}

export function isValidProfileRecord(
  p: unknown
): p is PeerProfile | OwnProfile {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  return (
    isNonEmptyString(r.did) && typeof r.nickname === "string"
  );
}

export function isValidSavedGifRecord(g: unknown): g is SavedGif {
  if (!g || typeof g !== "object") return false;
  const r = g as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.gifId) &&
    typeof r.title === "string"
  );
}

export function isValidPendingRecord(p: unknown): p is PendingMessage {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.to) &&
    !!r.message &&
    typeof r.message === "object"
  );
}

export function isValidYjsDocRecord(
  d: unknown
): d is { id: string; update: number[] } {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return isNonEmptyString(r.id) && Array.isArray(r.update);
}

export interface SanitizeResult<T> {
  records: T[];
  dropped: number;
}

function sanitize<T>(
  records: unknown[],
  isValid: (r: unknown) => r is T
): SanitizeResult<T> {
  const valid: T[] = [];
  let dropped = 0;
  for (const r of records) {
    if (isValid(r)) valid.push(r);
    else dropped++;
  }
  return { records: valid, dropped };
}

export interface SanitizedCollections {
  messages: Message[];
  attachments: AttachmentExport[];
  pending: PendingMessage[];
  watermarks: WatermarkRecord[];
  yjsDocs: { id: string; update: number[] }[];
  rooms: (Room | DMRoom)[];
  profiles: (PeerProfile | OwnProfile)[];
  savedGifs: SavedGif[];
  /** Total records dropped across every collection above. */
  dropped: number;
}

/**
 * Filter every collection of an untrusted DatabaseExport down to shape-valid
 * records, and report how many were dropped. Shared by the file-restore path
 * (applyBackup) and the device-sync import (both funnel through
 * importDatabase in backup-restore.ts), since both hand this module data
 * that only ever passed through JSON.parse/JSON.stringify - never re-checked
 * against the TypeScript types the app otherwise trusts at compile time.
 */
export function sanitizeCollections(data: {
  messages: unknown[];
  attachments: unknown[];
  pending: unknown[];
  watermarks: unknown[];
  yjsDocs: unknown[];
  rooms: unknown[];
  profiles: unknown[];
  savedGifs: unknown[];
}): SanitizedCollections {
  const messages = sanitize(data.messages, isValidMessageRecord);
  const attachments = sanitize(data.attachments, isValidAttachmentRecord);
  const pending = sanitize(data.pending, isValidPendingRecord);
  const watermarks = sanitize(data.watermarks, isValidWatermarkRecord);
  const yjsDocs = sanitize(data.yjsDocs, isValidYjsDocRecord);
  const rooms = sanitize(data.rooms, isValidRoomRecord);
  const profiles = sanitize(data.profiles, isValidProfileRecord);
  const savedGifs = sanitize(data.savedGifs, isValidSavedGifRecord);

  return {
    messages: messages.records,
    attachments: attachments.records,
    pending: pending.records,
    watermarks: watermarks.records,
    yjsDocs: yjsDocs.records,
    rooms: rooms.records,
    profiles: profiles.records,
    savedGifs: savedGifs.records,
    dropped:
      messages.dropped +
      attachments.dropped +
      pending.dropped +
      watermarks.dropped +
      yjsDocs.dropped +
      rooms.dropped +
      profiles.dropped +
      savedGifs.dropped,
  };
}
