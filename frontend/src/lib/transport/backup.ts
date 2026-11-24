/**
 * backup.ts - the on-disk/on-wire shape of a database export.
 *
 * Format logic only (no DOM, no IndexedDB reads/writes, no runes) so it can be
 * unit tested: a backup file is untrusted input, and both the file restore and
 * the QR device sync depend on it round-tripping without silently dropping
 * data. The one import outside that rule is identity.ts's password-KDF helper,
 * which the encrypted-file envelope below derives its key with.
 */

import { base64ToBytes, bytesToBase64, utf8 } from "../utils";
import { AESFromPassword, PBKDF2_ITERATIONS } from "../identity/identity";
import { MessageType } from "../types/message";
import type { Message, Attachment, PendingMessage } from "../types/message";
import { encryptedFileSize } from "../room-security/file-descriptor";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
  OwnRoomProfileRecord,
  RoomDeletionMarker,
  BlockEntry,
  PhonebookEntry,
} from "../storage";
import type { RoomProfileField } from "../room-profile";
import { judgeRoomName } from "../room-name";
import { isChannelId, mergeChannelLists, normalizeChannelList, parseChannelList } from "../channels";

export type RoomProfileExport = Omit<OwnRoomProfileRecord, "fields"> & {
  fields: Partial<Record<RoomProfileField, string | boolean | null>>;
};

/** JSON has no ArrayBuffer representation, including inside nested overrides. */
export function roomProfileToExport(record: OwnRoomProfileRecord): RoomProfileExport {
  const fields = { ...record.fields } as RoomProfileExport["fields"];
  for (const key of ["pfpData", "bannerData"] as const) {
    const bytes = record.fields[key];
    if (bytes instanceof ArrayBuffer) fields[key] = bytesToBase64(new Uint8Array(bytes));
  }
  return { ...record, fields };
}

export interface AttachmentExport {
  encryption?: Attachment["encryption"];
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

/**
 * The data sections of an export, in the order the device sync sends them
 * and the import counts them. One list: the transfer's progress, the
 * import's total and the export itself used to spell it out separately.
 */
export const EXPORT_SECTIONS = [
  "messages",
  "attachments",
  "rooms",
  "profiles",
  "roomProfiles",
  "roomDeletions",
  "watermarks",
  "yjsDocs",
  "savedGifs",
  "phonebook",
  "blocks",
  "pending",
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

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
  roomProfiles?: RoomProfileExport[];
  roomDeletions?: RoomDeletionMarker[];
  savedGifs: SavedGif[];
  // Optional because exports from before they were carried lack them, and
  // a missing list must not read as an empty one on a merge.
  phonebook?: PhonebookEntry[];
  /** Soft blocks, lifted ones included for their refusal windows. */
  blocks?: BlockEntry[];
  localState?: LocalStateExport;
}

/**
 * Account state the app keeps in localStorage rather than IndexedDB, which
 * an export of the database alone used to leave behind. Every field is
 * optional: absent means the exporting build did not carry it, which is not
 * the same as empty.
 */
export interface LocalStateExport {
  /** transport/audio-prefs.ts: per-person volumes, by did:key. */
  peerVolumes?: Record<string, number>;
  /** transport/audio-prefs.ts: who gets none of your voice. */
  voiceWithheld?: string[];
  /** dm-call-joined.ts: the DM calls taken part in. */
  dmCallsJoined?: string[];
  /**
   * transport/dm-queue.ts: the DM retry queue exactly as stored, sealed
   * under the account's at-rest key - which every device of the account
   * derives alike, so it travels without being opened.
   */
  dmQueue?: string;
}

export const BACKUP_FORMAT = "awful.chat/backup";
// v2: attachment and saved-gif bytes are base64 strings, not number[]. An
// old build restoring a v2 file would coerce the string to garbage bytes, so
// it must refuse cleanly on the version instead.
// v3 adds room overrides and leave markers. A v2 reader would discard them.
// v4 adds the phonebook, soft blocks and the localStorage-held account state
// (LocalStateExport), which a v3 reader would discard just as quietly.
// v5 holds channels: messages tagged with one, and rooms' channel lists,
// read marks and pins. A v4 reader shows every channel's messages mixed in
// the room's one chat, so it must refuse. A file with no channel data is
// still written as v4 (backupVersionFor), which a v4 reader restores fine.
export const BACKUP_VERSION = 5;

/** The version to write this export as: the lowest one that reads it correctly (see BACKUP_VERSION). */
export function backupVersionFor(data: Pick<DatabaseExport, "messages" | "rooms">): number {
  const tagged = data.messages.some((m) => typeof (m as { channel?: unknown }).channel === "string");
  const listed = data.rooms.some((r) => {
    const room = r as { channels?: unknown[]; channelSeen?: object; channelPins?: object };
    return (
      (Array.isArray(room.channels) && room.channels.length > 0) ||
      (!!room.channelSeen && Object.keys(room.channelSeen).length > 0) ||
      (!!room.channelPins && Object.keys(room.channelPins).length > 0)
    );
  });
  return tagged || listed ? BACKUP_VERSION : 4;
}

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
 * mode, or a backup merged in).
 *
 * This device's record is the base: most of a room's fields are about how
 * this device shows it (layout, what was read, a legacy room's move), and an
 * import that took every field it did not name used to clobber those, or
 * drop the ones only this device had. The fields with a rule of their own
 * mirror the monotonic guards used at runtime: the seen watermark and
 * per-participant activity never move backwards, membership is a union, the
 * newer name wins with the stamp it was chosen at, and a request accepted on
 * either device stays accepted.
 */
export function mergeImportedRoom<T extends Room>(local: Room, imported: T, now = Date.now()): T {
  if (local.roomSecret && imported.roomSecret && local.roomSecret !== imported.roomSecret) {
    throw new Error("Imported room capability conflicts with the local room");
  }
  const localPq = (local as { pq?: unknown }).pq;
  const importedPq = (imported as { pq?: unknown }).pq;
  const participantLastSeen: Record<string, number> = {};
  for (const [did, ts] of Object.entries(local.participantLastSeen ?? {})) {
    participantLastSeen[did] = ts ?? 0;
  }
  for (const [did, ts] of Object.entries(imported.participantLastSeen ?? {})) {
    participantLastSeen[did] = Math.max(participantLastSeen[did] ?? 0, ts ?? 0);
  }
  // The name and its stamp travel together, decided the way members decide
  // between announced names (room-name.ts). Keeping the local name but taking
  // the imported stamp made an old name look newer than a rename, and the
  // next announcement put the old name back for the whole room.
  const takeName = judgeRoomName(local, imported.name, imported.nameAt) === "take";
  const named = takeName ? imported : local;
  // A room avatar has no stamp to decide by, so it is this device's when it
  // has one, and a pair either way: a URL from one side beside bytes from
  // the other showed neither's choice.
  const pictured = local.pfpData || local.pfpURL ? local : imported;
  const localRequest = (local as { request?: boolean }).request;
  const importedRequest = (imported as { request?: boolean }).request;
  // Room is an interface, so neither side spreads as a plain record.
  const merged: Record<string, unknown> = {
    ...(imported as unknown as Record<string, unknown>),
    ...(local as unknown as Record<string, unknown>),
    ...(local.roomSecret || imported.roomSecret
      ? { roomSecret: local.roomSecret ?? imported.roomSecret }
      : {}),
    // A DM's post-quantum state: this device's own wins. Ours came out of an
    // introduction that confirmed it; an imported one only came out of a
    // file, and on the decapsulating side a ciphertext cannot be checked
    // without that confirmation (room-security/pq-dm.ts).
    ...(localPq || importedPq ? { pq: localPq ?? importedPq } : {}),
    lastSeenLamport: Math.max(
      local.lastSeenLamport ?? 0,
      imported.lastSeenLamport ?? 0
    ),
    // A text room's createdAt is its membership generation (room-profile.ts):
    // a deliberate rejoin creates a newer one, and an older snapshot must not
    // roll it back below a leave marker. Anything else keeps the earliest,
    // which is what the sidebar falls back to for ordering.
    createdAt: local.type === "text"
      ? Math.max(local.createdAt ?? 0, imported.createdAt ?? 0)
      : Math.min(local.createdAt ?? Infinity, imported.createdAt ?? Infinity),
    participants: [
      ...new Set([
        ...(local.participants ?? []),
        ...(imported.participants ?? []),
      ]),
    ],
    participantLastSeen,
    name: named.name,
    // This device's sidebar layout wins, the same way its room name does;
    // the import only fills in rooms this device never arranged.
    pinnedAt: local.pinnedAt ?? imported.pinnedAt,
    position: local.position ?? imported.position,
    // A union, like membership: a message pinned on either device stays so.
    pinnedMessages: [
      ...new Set([
        ...(local.pinnedMessages ?? []),
        ...(imported.pinnedMessages ?? []),
      ]),
    ],
    // Only the user moves it, so the later read is the real one.
    seenAt: Math.max(local.seenAt ?? 0, imported.seenAt ?? 0) || undefined,
    archiveOf: local.archiveOf ?? imported.archiveOf,
    movedTo: local.movedTo ?? imported.movedTo,
    pfpData: pictured.pfpData,
    pfpURL: pictured.pfpURL,
    // The channel list is the room's, not this device's: merged entry by
    // entry the way members merge announcements (channels.ts), never taken
    // whole from either side - an older copy must not bring a deleted
    // channel back, nor drop one made since.
    channels: mergeChannelLists(local.channels ?? [], parseChannelList(imported.channels), now).merged,
    // Read marks only move forward, like lastSeenLamport; pins are a union,
    // like pinnedMessages - per channel.
    channelSeen: mergeMarks(local.channelSeen, imported.channelSeen),
    channelPins: mergePins(local.channelPins, imported.channelPins),
  };
  if (named.nameAt !== undefined) merged.nameAt = named.nameAt;
  else delete merged.nameAt;
  // Accepting a request is the user's decision and only ever goes one way.
  // A request on both devices stays one; accepted (or from before requests,
  // which counts the same) on either, it is accepted here. The import's
  // `request: true` used to land over a conversation this device had long
  // accepted and put it back among the requests.
  if (localRequest === true || importedRequest === true) {
    merged.request = localRequest === true && importedRequest === true ? true : false;
  }
  for (const key of ["seenAt", "archiveOf", "movedTo", "pfpData", "pfpURL", "pinnedAt", "position"]) {
    if (merged[key] === undefined) delete merged[key];
  }
  // A room nobody made a channel in stays exactly the record it was.
  if (!(merged.channels as unknown[]).length) delete merged.channels;
  if (!Object.keys(merged.channelSeen as object).length) delete merged.channelSeen;
  if (!Object.keys(merged.channelPins as object).length) delete merged.channelPins;
  return merged as T;
}

function mergeMarks(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): Record<string, number> {
  const out: Record<string, number> = { ...sanitizeChannelMarks(a) };
  for (const [id, mark] of Object.entries(sanitizeChannelMarks(b))) {
    out[id] = Math.max(out[id] ?? 0, mark);
  }
  return out;
}

function mergePins(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...sanitizeChannelPins(a) };
  for (const [id, pins] of Object.entries(sanitizeChannelPins(b))) {
    out[id] = [...new Set([...(out[id] ?? []), ...pins])];
  }
  return out;
}

/** Per-channel read marks from a file: channel ids to finite, non-negative lamports. */
export function sanitizeChannelMarks(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, mark] of Object.entries(raw as Record<string, unknown>)) {
    if (isChannelId(id) && isFiniteNonNegative(mark)) out[id] = mark;
  }
  return out;
}

/** Per-channel pins from a file: channel ids to lists of message ids. */
export function sanitizeChannelPins(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, pins] of Object.entries(raw as Record<string, unknown>)) {
    if (!isChannelId(id) || !Array.isArray(pins)) continue;
    const ids = pins.filter(isNonEmptyString).slice(0, MAX_PINS_PER_CHANNEL);
    if (ids.length) out[id] = [...new Set(ids)];
  }
  return out;
}

/** More pins than anybody makes by hand; only a hostile file gets near it. */
const MAX_PINS_PER_CHANNEL = 1000;

/**
 * A room record's channel fields, as a file holds them, made safe to store:
 * the list parsed entry by entry and normalized, the marks and pins checked.
 * A room is never dropped over them - losing a room is data loss, a bad
 * channel entry is not - so what does not parse is left out instead.
 */
export function sanitizeRoomChannels<T extends Room>(room: T): T {
  const r = room as T & Record<string, unknown>;
  if (r.channels === undefined && r.channelSeen === undefined && r.channelPins === undefined) {
    return room;
  }
  const out: Record<string, unknown> = { ...r };
  delete out.channels;
  delete out.channelSeen;
  delete out.channelPins;
  // DMs have no channels.
  if (room.roomCode.startsWith("dm-")) return out as T;
  const channels = normalizeChannelList(parseChannelList(r.channels));
  const seen = sanitizeChannelMarks(r.channelSeen);
  const pins = sanitizeChannelPins(r.channelPins);
  if (channels.length) out.channels = channels;
  if (Object.keys(seen).length) out.channelSeen = seen;
  if (Object.keys(pins).length) out.channelPins = pins;
  return out as T;
}

/**
 * One soft block, from both devices (backup.ts has no storage, so
 * blocks.svelte.ts's own helpers are not used here; the rule is the same
 * one storeBlock applies). A block active on either device stays active:
 * lifting it on one is not a decision about the other, and the safe answer
 * to the disagreement is the block. Every lifted window from both is kept,
 * because DMs refused in them must stay refused (dmRefusedAt).
 */
export function mergeImportedBlock(local: BlockEntry | undefined, imported: BlockEntry): BlockEntry {
  if (!local) return imported;
  const windowsOf = (e: BlockEntry): [number, number][] => [
    ...(e.earlier ?? []),
    ...(e.unblockedAt !== undefined ? [[e.blockedAt, e.unblockedAt] as [number, number]] : []),
  ];
  const seen = new Set<string>();
  const windows = [...windowsOf(local), ...windowsOf(imported)]
    .filter(([from, until]) => {
      const key = `${from}:${until}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const name = local.name || imported.name;
  const active = [local, imported].filter((e) => e.unblockedAt === undefined);
  if (active.length > 0) {
    return {
      did: local.did,
      name,
      blockedAt: Math.min(...active.map((e) => e.blockedAt)),
      ...(windows.length ? { earlier: windows } : {}),
    };
  }
  // Lifted on both: the latest window is the entry's own, the rest earlier.
  const [blockedAt, unblockedAt] = windows[windows.length - 1];
  const earlier = windows.slice(0, -1);
  return { did: local.did, name, blockedAt, unblockedAt, ...(earlier.length ? { earlier } : {}) };
}

/**
 * One phonebook row, from both devices, under the same key. A union, like
 * dedupePhonebook's: the earliest addedAt, a favorite on either side, and
 * this device's nickname when it has one.
 */
export function mergeImportedContact(
  local: PhonebookEntry | undefined,
  imported: PhonebookEntry
): PhonebookEntry {
  if (!local) return imported;
  const favorite = !!(local.favorite || imported.favorite);
  const did = local.did ?? imported.did;
  return {
    ...imported,
    ...local,
    nickname: local.nickname || imported.nickname,
    addedAt: Math.min(local.addedAt, imported.addedAt),
    ...(did ? { did } : {}),
    ...(favorite ? { favorite } : {}),
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
  return parseBackupValue(parsed);
}

/** parseBackup on an already-parsed value, so a file is only parsed once. */
function parseBackupValue(parsed: unknown): BackupFile {
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
    roomProfiles: arr(d.roomProfiles),
    roomDeletions: arr(d.roomDeletions),
    savedGifs: arr(d.savedGifs),
    // Left absent rather than coerced to [] when the file never had them:
    // see DatabaseExport.
    ...(Array.isArray(d.phonebook) ? { phonebook: d.phonebook } : {}),
    ...(Array.isArray(d.blocks) ? { blocks: d.blocks } : {}),
    ...(d.localState !== undefined ? { localState: d.localState } : {}),
  };
}

// ── Encrypted backup file ────────────────────────────────────────────────────
//
// The export above is PLAINTEXT apart from the mnemonic: every message, room
// code, DID and attachment sits in the clear, so a leaked file leaked the
// whole account's history even though nobody could sign as it. The encrypted
// file wraps that entire export in one AES-GCM blob under a passphrase the
// user types at export time.
//
// It carries its own `format` marker rather than bumping `version`, because
// the plaintext format is already at version 2 (base64 attachment bytes).
// Older plaintext files keep restoring untouched, with no passphrase.
export const BACKUP_ENC_FORMAT = "awful.chat/backup-encrypted";
export const BACKUP_ENC_VERSION = 2;
/** A hostile file must not be able to pin the CPU for hours on PBKDF2. */
const MAX_KDF_ITERATIONS = 10_000_000;

export interface EncryptedBackupFile {
  format: typeof BACKUP_ENC_FORMAT;
  version: number;
  /** PBKDF2-SHA256 parameters; salt is base64. */
  kdf: { salt: string; iterations: number };
  /** Base64 12-byte AES-GCM IV. */
  iv: string;
  /** Base64 AES-GCM ciphertext of the JSON of a BackupFile. */
  ciphertext: string;
}

export type ParsedBackupFile =
  | { encrypted: false; backup: BackupFile }
  | { encrypted: true; envelope: EncryptedBackupFile };

/**
 * Read a backup file's text without decrypting it: the caller only knows
 * whether to ask for a passphrase after seeing which of the two shapes it is.
 *
 * @throws if the text is not a backup this build understands.
 */
export function parseBackupFileText(text: string): ParsedBackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON");
  }
  const d = parsed as Record<string, unknown> | null;
  if (d && typeof d === "object" && d.format === BACKUP_ENC_FORMAT) {
    return { encrypted: true, envelope: parseEncryptedBackup(d) };
  }
  return { encrypted: false, backup: parseBackupValue(parsed) };
}

function parseEncryptedBackup(d: Record<string, unknown>): EncryptedBackupFile {
  if (typeof d.version !== "number" || d.version > BACKUP_ENC_VERSION) {
    throw new Error("That backup was made by a newer version of the app");
  }
  const kdf = d.kdf as { salt?: unknown; iterations?: unknown } | undefined;
  if (
    typeof d.iv !== "string" ||
    typeof d.ciphertext !== "string" ||
    !kdf ||
    typeof kdf.salt !== "string" ||
    typeof kdf.iterations !== "number" ||
    !Number.isFinite(kdf.iterations) ||
    kdf.iterations <= 0 ||
    kdf.iterations > MAX_KDF_ITERATIONS
  ) {
    throw new Error("That encrypted backup file is damaged");
  }
  return {
    format: BACKUP_ENC_FORMAT,
    version: d.version,
    kdf: { salt: kdf.salt, iterations: kdf.iterations },
    iv: d.iv,
    ciphertext: d.ciphertext,
  };
}

/** Wrap a backup in AES-GCM under a passphrase-derived key. */
export async function encryptBackup(
  backup: BackupFile,
  passphrase: string
): Promise<EncryptedBackupFile> {
  if (!passphrase) throw new Error("A passphrase is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await AESFromPassword(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    utf8(JSON.stringify(backup))
  );
  return {
    format: BACKUP_ENC_FORMAT,
    version: BACKUP_ENC_VERSION,
    kdf: { salt: bytesToBase64(salt), iterations: PBKDF2_ITERATIONS },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Open an encrypted backup. The AES-GCM tag is what tells a wrong passphrase
 * from a corrupt file, and neither is worth distinguishing to the user.
 *
 * @throws if the passphrase is wrong or the file was tampered with.
 */
export async function decryptBackup(
  envelope: EncryptedBackupFile,
  passphrase: string
): Promise<BackupFile> {
  const aesKey = await AESFromPassword(
    passphrase,
    base64ToBytes(envelope.kdf.salt),
    envelope.kdf.iterations
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      aesKey,
      base64ToBytes(envelope.ciphertext)
    );
  } catch {
    throw new Error("Wrong passphrase for this backup file");
  }
  return parseBackup(new TextDecoder().decode(plaintext));
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
  MessageType.CallEvent,
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
  // A channel tag keys a storage index: a malformed one, or one in a DM
  // (which has no channels), is refused like any other broken field.
  if (
    r.channel !== undefined &&
    (!isChannelId(r.channel) || (typeof r.roomCode === "string" && r.roomCode.startsWith("dm-")))
  ) {
    return false;
  }
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
  if (r.encryption !== undefined) {
    try {
      const expected = encryptedFileSize(a as Attachment);
      if (!/^[a-f0-9]{40}$/i.test(String(r.infoHash))) return false;
      if (r.data !== undefined) {
        const bytes = typeof r.data === "string" ? base64ToBytes(r.data) : Array.isArray(r.data) ? r.data : null;
        if (!bytes || bytes.length !== expected) return false;
      }
    } catch { return false; }
  }
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

const ROOM_PROFILE_FIELDS = new Set([
  "nickname", "pfpURL", "pfpData", "color", "bannerURL", "bannerData",
  "tagText", "tagTextColor", "tagChipColor", "bio", "nameEffect",
  "nameShimmer", "nameGlow", "gradient2", "gradient3",
]);

export function isValidRoomProfileRecord(value: unknown): value is RoomProfileExport {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (!isNonEmptyString(r.roomCode) || !isNonEmptyString(r.did) ||
      !isFiniteNonNegative(r.generation) || !r.fields || typeof r.fields !== "object" ||
      Array.isArray(r.fields)) return false;
  const fields = r.fields as Record<string, unknown>;
  if (Object.entries(fields).some(([key, field]) =>
    !ROOM_PROFILE_FIELDS.has(key) ||
    (field !== null && (key === "nameShimmer" || key === "nameGlow"
      ? typeof field !== "boolean" : typeof field !== "string"))
  )) return false;
  if (r.fieldEdits === undefined) return true;
  if (!r.fieldEdits || typeof r.fieldEdits !== "object" || Array.isArray(r.fieldEdits)) return false;
  return Object.entries(r.fieldEdits as Record<string, unknown>).every(([key, edit]) => {
    if (!ROOM_PROFILE_FIELDS.has(key) || !edit || typeof edit !== "object") return false;
    const e = edit as Record<string, unknown>;
    return isFiniteNonNegative(e.at) && isNonEmptyString(e.id) &&
      (e.reset === undefined || typeof e.reset === "boolean");
  });
}

export function isValidRoomDeletionMarker(value: unknown): value is RoomDeletionMarker {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return isNonEmptyString(r.roomCode) && isFiniteNonNegative(r.generation) &&
    isFiniteNonNegative(r.deletedAt);
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

export function isValidPhonebookRecord(p: unknown): p is PhonebookEntry {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  return (
    isNonEmptyString(r.peerId) &&
    r.peerId.length <= 256 &&
    typeof r.nickname === "string" &&
    r.nickname.length <= 1024 &&
    isFiniteNonNegative(r.addedAt) &&
    (r.did === undefined || (typeof r.did === "string" && r.did.startsWith("did:") && r.did.length <= 256)) &&
    (r.favorite === undefined || typeof r.favorite === "boolean")
  );
}

function isRefusalWindow(w: unknown): w is [number, number] {
  return Array.isArray(w) && w.length === 2 && isFiniteNonNegative(w[0]) && isFiniteNonNegative(w[1]);
}

export function isValidBlockRecord(b: unknown): b is BlockEntry {
  if (!b || typeof b !== "object") return false;
  const r = b as Record<string, unknown>;
  return (
    // storeBlock's own rule: only a did:key can be blocked.
    isNonEmptyString(r.did) &&
    r.did.startsWith("did:") &&
    r.did.length <= 256 &&
    typeof r.name === "string" &&
    isFiniteNonNegative(r.blockedAt) &&
    (r.unblockedAt === undefined || isFiniteNonNegative(r.unblockedAt)) &&
    (r.earlier === undefined ||
      (Array.isArray(r.earlier) && r.earlier.length <= 1000 && r.earlier.every(isRefusalWindow)))
  );
}

/** The largest DM retry queue blob taken in: the queue itself is bounded at 200 frames. */
const MAX_DM_QUEUE_BLOB = 8 * 1024 * 1024;

/**
 * LocalStateExport with every field of the wrong shape left out. The
 * importers check their own contents (audio-prefs.ts, dm-call-joined.ts,
 * dm-queue.ts); this only stops a field of the wrong TYPE reaching them.
 */
export function sanitizeLocalState(value: unknown): LocalStateExport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const out: LocalStateExport = {};
  if (r.peerVolumes && typeof r.peerVolumes === "object" && !Array.isArray(r.peerVolumes)) {
    out.peerVolumes = r.peerVolumes as Record<string, number>;
  }
  if (Array.isArray(r.voiceWithheld)) out.voiceWithheld = r.voiceWithheld as string[];
  if (Array.isArray(r.dmCallsJoined)) out.dmCallsJoined = r.dmCallsJoined as string[];
  if (typeof r.dmQueue === "string" && r.dmQueue.length <= MAX_DM_QUEUE_BLOB) out.dmQueue = r.dmQueue;
  return out;
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
  roomProfiles: RoomProfileExport[];
  roomDeletions: RoomDeletionMarker[];
  savedGifs: SavedGif[];
  /** Undefined when the export never carried the list (see DatabaseExport). */
  phonebook?: PhonebookEntry[];
  blocks?: BlockEntry[];
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
  roomProfiles?: unknown[];
  roomDeletions?: unknown[];
  savedGifs: unknown[];
  phonebook?: unknown[];
  blocks?: unknown[];
}): SanitizedCollections {
  const messages = sanitize(data.messages, isValidMessageRecord);
  const attachments = sanitize(data.attachments, isValidAttachmentRecord);
  const pending = sanitize(data.pending, isValidPendingRecord);
  const watermarks = sanitize(data.watermarks, isValidWatermarkRecord);
  const yjsDocs = sanitize(data.yjsDocs, isValidYjsDocRecord);
  const rooms = sanitize(data.rooms, isValidRoomRecord);
  rooms.records = rooms.records.map(sanitizeRoomChannels);
  const profiles = sanitize(data.profiles, isValidProfileRecord);
  const roomProfiles = sanitize(data.roomProfiles ?? [], isValidRoomProfileRecord);
  const roomDeletions = sanitize(data.roomDeletions ?? [], isValidRoomDeletionMarker);
  const savedGifs = sanitize(data.savedGifs, isValidSavedGifRecord);
  const phonebook = data.phonebook ? sanitize(data.phonebook, isValidPhonebookRecord) : undefined;
  const blocks = data.blocks ? sanitize(data.blocks, isValidBlockRecord) : undefined;

  return {
    messages: messages.records,
    attachments: attachments.records,
    pending: pending.records,
    watermarks: watermarks.records,
    yjsDocs: yjsDocs.records,
    rooms: rooms.records,
    profiles: profiles.records,
    roomProfiles: roomProfiles.records,
    roomDeletions: roomDeletions.records,
    savedGifs: savedGifs.records,
    ...(phonebook ? { phonebook: phonebook.records } : {}),
    ...(blocks ? { blocks: blocks.records } : {}),
    dropped:
      messages.dropped +
      attachments.dropped +
      pending.dropped +
      watermarks.dropped +
      yjsDocs.dropped +
      rooms.dropped +
      profiles.dropped +
      roomProfiles.dropped +
      roomDeletions.dropped +
      savedGifs.dropped +
      (phonebook?.dropped ?? 0) +
      (blocks?.dropped ?? 0),
  };
}
