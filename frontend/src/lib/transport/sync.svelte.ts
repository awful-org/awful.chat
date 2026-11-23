/**
 * sync.svelte.ts
 *
 * Device-to-device sync using QR codes and P2P connection.
 * Both devices connect to a temporary sync room via the standard transport layer.
 */

import QRCode from "qrcode";
import { stopQrScan } from "../qr-scanner.svelte";
import type { PeerTransport } from "./types";
import { SecureSyncTransport } from "$lib/room-security/sync-transport";
import { deriveRoomKeys, newRoomSecret, parseRoomSecret, type RoomSecret } from "$lib/room-security/keys";
import {
  getDB,
  wipeLocalDatabase,
  putIdentityRecord,
  bulkPutMessages,
  putAttachment,
  putRoom,
  putPeerProfile,
  putOwnProfile,
  putSavedGif,
  getRoom,
  setWatermark,
  getOwnProfile,
  getPeerProfile,
  getAllOwnRoomProfiles,
  getAllRoomDeletionMarkers,
  roomDeletionCutoff,
  getKeypairRecord,
  getBlockEntries,
  getPhonebookEntries,
} from "../storage";
import type { Message, Attachment, PendingMessage } from "../types/message";
import { bytesToBase64 } from "../utils";
import {
  openRows,
  sealRow,
  STORE_SPECS,
  beginPlaintextImport,
  clearStorageCrypto,
  storageCryptoReady,
} from "../storage-crypto";
import { markAtRestSweepNeeded } from "../storage";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
} from "../storage";
import {
  BACKUP_FORMAT,
  backupVersionFor,
  bytesFromExport,
  encryptBackup,
  parseBackup,
  mergeImportedRoom,
  pfpFromJson,
  pfpToJson,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
  type LocalStateExport,
  EXPORT_SECTIONS,
  roomProfileToExport,
} from "./backup";
import {
  SYNC_PROTOCOL_VERSION,
  SYNC_VERSION_MISMATCH,
  SendWindow,
  manifestProblems,
  newSyncNonce,
  syncComparisonCode,
  type ReceivedSection,
  type SyncManifest,
} from "./sync-protocol";
import { signPeerBinding, verifyPeerBinding } from "../messaging";
import { peerAudioPrefs } from "./audio-prefs";
import { dmCallsJoined } from "../dm-call-joined";
import { readDmQueueBlob } from "./dm-queue";

export { summarizeBackup, decryptBackup } from "./backup";
// The apply/import half lives in a transport-free module so it can be tested;
// re-exported here because the UI has always imported it from this path.
export {
  applyBackup,
  readBackupFile,
  importDatabase,
} from "./backup-restore";
import {
  applyRoomDeletionMarkers,
  importDatabase,
  DIFFERENT_ACCOUNT_MERGE,
  type ImportOptions,
} from "./backup-restore";
export type { ImportOptions } from "./backup-restore";
export type {
  BackupFile,
  BackupSummary,
  EncryptedBackupFile,
  ParsedBackupFile,
} from "./backup";

export interface SyncPayload {
  roomSecret?: string;
  roomCode: string;
  token: string;
  expires: number;
  mode?: "add" | "replace";
  password?: string;
  /**
   * The source's libp2p peerId (full form, from the QR payload). The
   * transport authenticates the remote peerId via Noise, so pinning to it
   * is what stops the FIRST peer to join the ephemeral sync room - which
   * the relay operator can trivially arrange - from impersonating the
   * source. Optional only for the short-code path below, which carries
   * `peerPrefix` instead.
   */
  peerId?: string;
  /**
   * Short-code path: the 8 chars of the source's peerId after the constant
   * Ed25519 prefix `12D3KooW` (see peerIdShortPrefix / parseShortCode below).
   */
  peerPrefix?: string;
}

enum SyncMessageType {
  ExportRequest = "sync_export_request",
  /**
   * Source to target: `{ nonce }`. The request is waiting for the source's
   * user to allow it; both ends derive the comparison code from the nonce.
   */
  ApprovalPending = "sync_approval_pending",
  /** Source to target: `{ section, data, seq, ... }`; acked by seq. */
  ExportData = "sync_export_data",
  /** Target to source: `{ seq }`, once the frame was taken in. Paces the export. */
  ExportAck = "sync_export_ack",
  /**
   * Source to target: `{ manifest, token }`, the transfer is over and this is
   * what it held. Target to source (no payload): the import landed.
   */
  ExportComplete = "sync_export_complete",
  SyncError = "sync_error",
  /** Target to source while importing: `{ percent }`. Restarts the ack clock. */
  ImportProgress = "sync_import_progress",
  /**
   * Target to source: its user is being asked for the account password. The
   * source stops timing the target's silence until the next frame.
   */
  AwaitingPassword = "sync_awaiting_password",
}

const SYNC_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(SyncMessageType));

interface SyncMessage {
  type: SyncMessageType;
  /** SYNC_PROTOCOL_VERSION of the sender; absent from version 1 builds. */
  v?: number;
  payload?: unknown;
}

/** A frame of this protocol version. */
function frame(type: SyncMessageType, payload?: unknown): Uint8Array {
  return encode(payload === undefined
    ? { type, v: SYNC_PROTOCOL_VERSION }
    : { type, v: SYNC_PROTOCOL_VERSION, payload });
}

/** An error frame: readable by builds of every version, which all show `error`. */
function errorFrame(error: string): Uint8Array {
  return frame(SyncMessageType.SyncError, { error });
}

export interface SyncState {
  isGenerating: boolean;
  qrDataUrl: string | null;
  plaintextToken: string | null;
  isConnecting: boolean;
  isSyncing: boolean;
  syncProgress: number;
  /**
   * What the bar is measuring. "transfer" is frames on the wire; the last
   * ten percent is the import, on this device or the other one, which used
   * to sit at a frozen number with the transfer's label on it.
   */
  phase: "transfer" | "importing" | "importing-remote" | "remote-password";
  syncError: string | null;
  isComplete: boolean;
  /**
   * A request is waiting for the source's user. On the source: Allow or
   * Deny is being asked. On the target: it is waiting for that answer.
   */
  awaitingApproval: boolean;
  /** The six digits both devices show for the request in play. */
  pairingCode: string | null;
  /**
   * The target's import passed the point where it can be stopped: its writes
   * go on whatever happens, so the dialog stops offering Cancel and waits
   * for how it ends, which is always reported.
   */
  finishing: boolean;
}

export const syncState = $state<SyncState>({
  isGenerating: false,
  qrDataUrl: null,
  plaintextToken: null,
  isConnecting: false,
  isSyncing: false,
  syncProgress: 0,
  phase: "transfer",
  syncError: null,
  isComplete: false,
  awaitingApproval: false,
  pairingCode: null,
  finishing: false,
});

let _transport: PeerTransport | null = null;
// A committed multi-transaction import cannot be rolled back. Keep its write
// lease through cleanup so a replacement sync cannot overlap identity/storage.
let _importCommitDone: Promise<void> | null = null;
let _syncRoomCode: string | null = null;
let _syncRoomSecret: RoomSecret | null = null;
let _syncToken: string | null = null;
/**
 * The one peer this export goes to: set when the source's user allows the
 * request, never by the request alone. A token is something anybody who saw
 * the QR or the copied code holds.
 */
let _authorizedExportPeer: string | null = null;
/** Source-side: the request waiting for Allow or Deny. One at a time. */
interface PendingRequest {
  peerId: string;
  mode: "add" | "replace";
  roomDeletions: unknown[];
  nonce: string;
}
let _pendingRequest: PendingRequest | null = null;
/** Source-side: paces the export on the target's acks (SendWindow). */
let _sendWindow: SendWindow | null = null;
/** Source-side: the transfer is over; what is left is the target's import. */
let _exportSent = false;
/** Source-side: the target is asking its user for a password (AwaitingPassword). */
let _ackSuspended = false;
let _syncExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let _isSourceDevice = false;
/**
 * Source-side: has the user asked for the typed short code?
 *
 * The short code carries only the first 8 chars of the token, so honouring
 * that prefix costs 96 bits of the proof-of-scan secret. It is only honoured
 * once the user has actually revealed the short code on this device (see
 * revealShortCode) - a sync done by QR, which is the normal path, keeps the
 * full 128-bit token.
 */
let _shortCodeRevealed = false;
// Target-side: the one source peer we're syncing with, set only once
// matchesSourcePeer() confirms the connecting peerId is the one the
// QR/short code names. Once set, data from any other peer that joined the
// (ephemeral) sync room is ignored - otherwise the FIRST peer to join
// (trivially arranged by the relay operator) could impersonate the source.
let _targetSourcePeerId: string | null = null;

/**
 * Called by the UI when it shows the typed short code, which is what puts
 * the truncated token in play. Until then the source demands the full token.
 */
export function revealShortCode(): void {
  _shortCodeRevealed = true;
}

/** Reduce a full or short-code token to its comparable 8-char prefix. */
function tokenPrefix(t: string | undefined | null): string {
  return (t ?? "").slice(0, 8);
}

/**
 * Does `received` prove the sender holds the token `expected`?
 *
 * The short code truncates the 128-bit token to 8 hex chars - 32 bits, which
 * is guessable inside the code's 5-minute life - so a comparison on those 8
 * chars is only good enough when the short code is the form actually in play.
 * Both devices hold the full token otherwise (the QR, and the colon-form
 * manual code), and settling for a prefix threw the other 96 bits away.
 *
 * Either side can be the truncated one: the target that typed a short code
 * holds 8 chars while the source echoes all 32.
 */
export function tokenAccepted(
  received: string | undefined | null,
  expected: string | undefined | null,
  shortCodeInPlay: boolean
): boolean {
  if (!received || !expected) return false;
  if (received === expected) return true;
  if (!shortCodeInPlay) return false;
  return (
    (received.length === 8 || expected.length === 8) &&
    tokenPrefix(received) === tokenPrefix(expected)
  );
}

/**
 * True if `peerId` is the source device that generated `payload` - checked
 * against the full peerId (QR/manual-entry path) or the peerPrefix (short
 * code path). The libp2p connection is Noise-authenticated to this peerId,
 * so this is what makes pinning meaningful rather than trusting whoever
 * connects first.
 */
export function matchesSourcePeer(payload: SyncPayload, peerId: string): boolean {
  if (payload.peerId) return peerId === payload.peerId;
  if (payload.peerPrefix)
    return peerId.slice(8, 16).toLowerCase() === payload.peerPrefix.toLowerCase();
  return false;
}

// Every libp2p peerId minted from an Ed25519 key (the only kind this app
// generates) starts with this constant multihash/multibase prefix, so the
// short code can drop it and still carry enough of the peerId to pin the
// target to the right source. If a future key type changes the prefix this
// still yields 8 stable chars (just not right after position 8) - documented
// rather than asserted so an oddly-shaped peerId degrades instead of throwing.
const PEER_ID_ED25519_PREFIX = "12D3KooW";

/**
 * The 8 peerId chars the short code carries - see PEER_ID_ED25519_PREFIX.
 * Always chars [8, 16): for the expected Ed25519 form that's right after the
 * constant prefix; for anything else it is still 8 deterministic chars of
 * the peerId, just not aligned to a semantic boundary.
 */
export function peerIdShortPrefix(peerId: string): string {
  if (!peerId.startsWith(PEER_ID_ED25519_PREFIX)) {
    console.warn(
      "[Sync] peerId does not start with the expected Ed25519 prefix - short code will still use chars [8,16)"
    );
  }
  return peerId.slice(8, 16);
}

const SYNC_ROOM_PREFIX = "__sync_";
const SYNC_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 50;
/** Encoded-bytes budget per frame; the transport aborts frames over 4MB. */
const MAX_BATCH_BYTES = 2_500_000;
/**
 * Frames the export may have out before the target acks them, and the bytes
 * they may add up to (SendWindow). One frame always may go, whatever its
 * size, so the receiver never holds more unprocessed than one full frame -
 * which is what a single frame could always ask of it - or a few small ones.
 */
const SEND_WINDOW_FRAMES = 4;
const SEND_WINDOW_BYTES = MAX_BATCH_BYTES;

const SECOND_REQUESTER =
  "Another device is already syncing with this code. If that isn't your device, deny it on your other device and generate a new code.";

/**
 * The UTF-8 byte length of a string, without allocating a copy of it.
 *
 * String.length counts UTF-16 code units, which is the same number for
 * ASCII and up to three times too small for anything else. Sizing batches
 * with it meant a room of CJK or emoji history could measure comfortably
 * under the budget and serialize past the transport's 4MB frame cap - and
 * an oversized frame does not fail politely: the receiver aborts the whole
 * inbound stream, taking the rest of the transfer with it.
 *
 * Counted rather than encoded because this runs per item across an entire
 * database, and TextEncoder would allocate a second copy of every
 * attachment on the way past.
 */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      // Only a high surrogate FOLLOWED BY a low one is a pair. A lone high
      // surrogate is not, and swallowing the next character on the
      // assumption that it is miscounts whatever came after it - which
      // JSON.stringify of a corrupt record can produce.
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else {
      // Unpaired surrogates included: an encoder replaces them with U+FFFD,
      // which is three bytes, the same as this branch already counts.
      bytes += 3;
    }
  }
  return bytes;
}
/**
 * How long the source waits between signs of life from the target before
 * erroring: its acks while the data goes across, its ImportProgress frames
 * while it imports. Restarted by every one, so the bound is on silence, not
 * on the whole sync - and suspended while the target says its user is
 * typing a password (AwaitingPassword), which is a person, not a stall.
 */
const ACK_TIMEOUT_MS = 120_000;
let _ackTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

function clearAckTimer(): void {
  if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
  _ackTimeoutTimer = null;
}

function armAckTimer(): void {
  if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
  _ackTimeoutTimer = setTimeout(() => {
    _ackTimeoutTimer = null;
    const message = _exportSent
      ? "The other device never confirmed the import - try again"
      : "The other device stopped taking in the data - try again";
    _sendWindow?.fail(new Error(message));
    syncState.syncError = message;
    syncState.isSyncing = false;
    // Without this the transport, the sync-room membership and the
    // separate code-expiry timer all stay alive, and that expiry later
    // overwrites this message with "Sync code expired" - a second, wrong
    // explanation for the same event.
    cleanup().catch(() => {});
  }, ACK_TIMEOUT_MS);
}

/** Target-side: guards against a second ExportRequest on a re-connect. */
let _exportRequested = false;
/** Target-side: the source has to actually show up in the sync room. */
let _peerWaitTimer: ReturnType<typeof setTimeout> | null = null;
// Rendezvous registration, the relay's PEERS reply, the dial and the WebRTC
// upgrade all happen inside this window. Generous, because the alternative
// (what shipped) was an spinner that never resolved.
const PEER_WAIT_TIMEOUT = 45_000;
/**
 * Target-side: the transfer itself has to keep moving.
 *
 * The peer-wait timer covers getting connected and then stands down - it
 * returns early once isSyncing is set. So nothing at all watched the
 * transfer, and a source that connected and then sent nothing left the
 * target on "0%" forever, with no error and nothing to act on. Reset by
 * every frame that arrives, so it only fires on real silence.
 *
 * Generous because the first frame waits on exportDatabase reading the
 * whole database on the other device, which on a phone with a long history
 * is not quick. Sixty seconds of nothing is broken, not slow.
 */
const SYNC_STALL_TIMEOUT = 60_000;
let _stallTimer: ReturnType<typeof setTimeout> | null = null;

function clearStallTimer(): void {
  if (_stallTimer) clearTimeout(_stallTimer);
  _stallTimer = null;
}

/** Restart the watchdog. Called on every frame the target receives. */
function armStallTimer(): void {
  clearStallTimer();
  _stallTimer = setTimeout(() => {
    _stallTimer = null;
    if (!syncState.isSyncing || syncState.isComplete) return;
    syncState.isSyncing = false;
    syncState.syncError =
      "The other device stopped sending. Keep both sync screens open and try a new code.";
    cleanup().catch(() => {});
  }, SYNC_STALL_TIMEOUT);
}

function encode(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

function decode(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

/** 128 random bits, hex: the same draw as a request nonce. */
const generateToken = newSyncNonce;

/**
 * Generate a short readable code from the room code, token and source peerId.
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX = room8-token8-peer8. The peer segment
 * is what lets the target pin to the real source instead of the first peer
 * to join the ephemeral room - see SyncPayload.peerPrefix.
 */
export function generateShortCode(
  roomCode: string,
  token: string,
  peerId: string
): string {
  const roomPart = roomCode.slice(SYNC_ROOM_PREFIX.length).slice(0, 8);
  const tokenPart = token.slice(0, 8);
  const peerPart = peerIdShortPrefix(peerId);
  return `${roomPart}-${tokenPart}-${peerPart}`;
}

/**
 * Parse short code back to a payload fragment.
 * Only the current 3-part (room-token-peer) format is accepted: a 2-part
 * code predates peerId pinning and cannot prove which device is the real
 * source, so it is rejected rather than silently trusting the first joiner.
 */
export function parseShortCode(
  shortCode: string
): { roomCode: string; token: string; peerPrefix: string } | null {
  // Case-insensitive: the room and token halves are hex, and the peer half
  // is compared folded (matchesSourcePeer). A phone keyboard capitalises
  // what it likes, and a typed code has to survive that.
  const parts = shortCode.trim().toLowerCase().split("-");
  if (parts.length !== 3) return null;

  const [roomPart, tokenPart, peerPart] = parts;
  if (roomPart.length !== 8 || tokenPart.length !== 8 || peerPart.length !== 8)
    return null;

  // Reconstruct the full room code (we lose the middle part but that's ok for sync rooms)
  return {
    roomCode: `${SYNC_ROOM_PREFIX}${roomPart}`,
    token: tokenPart,
    peerPrefix: peerPart,
  };
}

/**
 * Generate a sync QR code and plaintext token for the source device.
 * Call this when you want to sync FROM this device TO another.
 */
export async function generateSyncCode(): Promise<void> {
  // An import committing on this device ends, and says how it ended, before
  // anything replaces it: past its commit point it cannot be stopped, and
  // resetting the state under it only hid the result.
  if (_importCommitDone) await _importCommitDone;
  // A previous successful attempt must not make the dialog complete this one
  // before a byte moves. In particular, stale 100% on the source while a new
  // target is still at identity/10% looks like a transfer that finished.
  resetSyncState();
  // Invalidate the previous session synchronously. Its disconnect may finish
  // later, but must never publish a QR or clear this attempt's state.
  const previousCleanup = cleanup();
  const token = generateToken();
  _syncToken = token;
  const current = () => _syncToken === token;
  syncState.isGenerating = true;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.syncError = null;

  try {
    await previousCleanup;
    await _importCommitDone;
    if (!current()) return;
    _syncRoomSecret = newRoomSecret();
    _syncRoomCode = deriveRoomKeys(_syncRoomSecret).discoveryId;
    // A fresh code starts QR-only: the short code's truncated token is not
    // honoured until the user asks to see it.
    _shortCodeRevealed = false;

    // Enforce expiry on the SOURCE: the target synthesizes its own `expires`
    // from whatever it scanned or typed, so the only reliable expiry is
    // tearing the server down ourselves.
    if (_syncExpiryTimer) clearTimeout(_syncExpiryTimer);
    _syncExpiryTimer = setTimeout(() => {
      if (current() && !syncState.isSyncing && !syncState.isComplete) {
        // An error already on screen (a connection lost while the other
        // device imported) is the better explanation: keep it.
        syncState.syncError ??= "Sync code expired";
        // A request still waiting for Allow is told, not left hanging.
        const waiting = _pendingRequest?.peerId;
        cleanup(waiting ? {
          peerId: waiting,
          data: errorFrame("The sync code expired before your other device allowed it. Generate a new code."),
        } : undefined).catch(() => {});
      }
    }, SYNC_TIMEOUT);

    _isSourceDevice = true;

    // Start listening for connections FIRST: the QR/short code has to carry
    // this device's real peerId (so the target can pin to it instead of
    // trusting whichever peer joins the room first), and that peerId only
    // exists once the transport is connected. The UI stays on its spinner
    // (isGenerating) for this whole span.
    await startSyncServer();
    if (!current()) return;

    const selfId = _transport?.selfId() ?? "";
    if (!selfId) {
      // The code is USELESS without a peerId to pin to - the other device
      // would scan it and have nothing to authenticate the source against.
      throw new Error("Could not determine this device's peer ID");
    }

    // QR and copy/paste both carry the full capability and pin the source's
    // Noise-authenticated identity. No token truncation for the manual path.
    const qrText = `${_syncRoomSecret}:${token}:${selfId}`;

    const qrDataUrl = await QRCode.toDataURL(qrText, {
      width: 256,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });
    if (!current()) return;

    // The copy/paste fallback preserves the same authentication as the QR.
    const plaintextToken = qrText;

    syncState.qrDataUrl = qrDataUrl;
    syncState.plaintextToken = plaintextToken;
  } catch (err) {
    if (!current()) return;
    syncState.syncError = err instanceof Error ? err.message : String(err);
    syncState.isGenerating = false;
    await cleanup();
  } finally {
    if (current()) syncState.isGenerating = false;
  }
}

/**
 * Parse a plaintext token and return the full payload.
 * Supports both formats:
 *   Short: XXXXXXXX-XXXXXXXX-XXXXXXXX (roomPart-tokenPart-peerPart)
 *   Full:  __sync_xxxxxxxxxxxxxxxx:token:peerId (for the manual-entry
 *          fallback of the QR code's JSON payload)
 * The old 2-part short code and the 2-part "room:token" full code predate
 * peerId pinning (see connectAsTarget) and are rejected with a message
 * telling the user to update both devices, rather than silently connecting
 * without source authentication.
 */
export function parsePlaintextToken(plaintext: string): SyncPayload | null {
  if (plaintext.trim().startsWith("r2_")) {
    const parts = plaintext.trim().split(":");
    if (parts.length !== 3 || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(parts[2])) return null;
    const roomSecret = parseRoomSecret(parts[0]);
    return { roomSecret, roomCode: deriveRoomKeys(roomSecret).discoveryId,
      token: parts[1], peerId: parts[2], expires: Date.now() + SYNC_TIMEOUT };
  }
  // Try short format first (contains hyphen but no __sync_ prefix)
  if (plaintext.includes("-") && !plaintext.includes(SYNC_ROOM_PREFIX)) {
    const legacyParts = plaintext.split("-");
    if (legacyParts.length === 2) {
      throw new Error(
        "This sync code is from an older version of the app - update both devices and generate a new code"
      );
    }
    const parsed = parseShortCode(plaintext);
    if (parsed) {
      return {
        roomCode: parsed.roomCode,
        token: parsed.token,
        peerPrefix: parsed.peerPrefix,
        expires: Date.now() + SYNC_TIMEOUT,
      };
    }
  }

  // Try full format (colon-delimited)
  if (plaintext.includes(SYNC_ROOM_PREFIX) && plaintext.includes(":")) {
    const [roomCode, token, peerId] = plaintext.split(":");
    if (!roomCode.startsWith(SYNC_ROOM_PREFIX) || !token) return null;
    if (!peerId) {
      throw new Error(
        "This sync code is from an older version of the app - update both devices and generate a new code"
      );
    }
    return {
      roomCode,
      token,
      peerId,
      expires: Date.now() + SYNC_TIMEOUT,
    };
  }

  return null;
}

/**
 * Start the sync server on the source device.
 * The target connects and sends an ExportRequest; the source's user is shown
 * the comparison code and allows or denies it; only an allowed request is
 * answered with data.
 */
async function startSyncServer(): Promise<void> {
  if (!_syncRoomCode || !_syncRoomSecret) return;

  // The room code is the ephemeral sync room's membership secret; anything
  // that can read the console can join it, so it never gets printed.
  console.log("[Sync][Source] Starting sync server");

  _transport = new SecureSyncTransport(_syncRoomSecret);
  const sourceTransport = _transport;

  // Set up handlers
  _transport.on("connect", (peerId: string) => {
    console.log("[Sync][Source] Peer connected:", peerId.slice(0, 8));
  });

  _transport.on("disconnect", (peerId: string) => {
    if (_transport !== sourceTransport) return;
    if (peerId === _pendingRequest?.peerId) {
      // Gone before an answer: nothing was sent, and the code still stands
      // for the device it was meant for.
      backToWaiting();
      return;
    }
    if (peerId !== _authorizedExportPeer || syncState.isComplete) return;
    console.log("[Sync][Source] Peer disconnected");
    if (!_exportSent) {
      // Mid-transfer: whatever was in flight went with the connection.
      _sendWindow?.fail(new Error("Connection lost"));
      syncState.isSyncing = false;
      syncState.syncError = "Lost the connection to the other device while sending - try again.";
      cleanup().catch(() => {});
      return;
    }
    // Everything is across and the import over there carries on without
    // this device. Said, but not torn down: if its confirmation still
    // arrives, the success replaces this message.
    clearAckTimer();
    syncState.isSyncing = false;
    syncState.syncError =
      "Lost the connection while the other device was importing. Check it to see whether the sync finished.";
  });

  // Source handles requests from target
  _transport.on("message", async (peerId: string, data: Uint8Array, room: string | null) => {
    if (_transport !== sourceTransport || room !== _syncRoomCode) return;
    console.log("[Sync][Source] Received message from:", peerId.slice(0, 8));
    let msg: SyncMessage;
    try {
      msg = decode(data) as SyncMessage;
    } catch {
      return;
    }
    try {
      if (msg.type === SyncMessageType.ExportRequest) {
        await handleExportRequest(sourceTransport, peerId, msg);
        return;
      }
      if (peerId === _pendingRequest?.peerId) {
        // Before Allow the requester has one thing to say: that it gave up.
        if (msg.type === SyncMessageType.SyncError) backToWaiting();
        return;
      }
      if (peerId !== _authorizedExportPeer) return;
      console.log("[Sync][Source] Message type:", msg.type);
      // A frame of the import after the password prompt is the target
      // working again. Only those: the transport's own keepalive pings come
      // through here too, and one of them used to end the pause - so the
      // next idle drop at the prompt read as a failed sync.
      if (
        _ackSuspended &&
        (msg.type === SyncMessageType.ImportProgress ||
          msg.type === SyncMessageType.ExportComplete ||
          msg.type === SyncMessageType.SyncError)
      ) {
        _ackSuspended = false;
        if (_exportSent) armAckTimer();
      }

      if (msg.type === SyncMessageType.ExportAck) {
        // The window is what paces the export; each ack is also a sign of
        // life for the silence clock.
        const { seq } = (msg.payload ?? {}) as { seq?: unknown };
        if (_sendWindow?.ack(seq) && !_exportSent) armAckTimer();
      } else if (msg.type === SyncMessageType.AwaitingPassword) {
        // A person typing a password takes as long as it takes. The clock
        // restarts with whatever the target sends next.
        _ackSuspended = true;
        clearAckTimer();
        syncState.phase = "remote-password";
      } else if (msg.type === SyncMessageType.ImportProgress) {
        // The target is still writing. Each report restarts the ack clock,
        // so a long import on a slow phone no longer times out a sync that
        // is finishing, and the bar here follows the one over there.
        const { percent } = (msg.payload ?? {}) as { percent?: unknown };
        syncState.phase = "importing-remote";
        if (typeof percent === "number" && percent > syncState.syncProgress) {
          syncState.syncProgress = Math.min(99, Math.floor(percent));
        }
        if (_exportSent) armAckTimer();
      } else if (msg.type === SyncMessageType.ExportComplete) {
        // A target cannot have imported what was never all sent.
        if (!_exportSent) return;
        clearAckTimer();
        syncState.isSyncing = false;
        syncState.isComplete = true;
        syncState.syncProgress = 100;
        // A "connection lost" said while the import ran is answered now.
        syncState.syncError = null;
        await cleanup();
      } else if (msg.type === SyncMessageType.SyncError) {
        clearAckTimer();
        _sendWindow?.fail(new Error("The other device stopped the sync"));
        syncState.isSyncing = false;
        syncState.syncError = (msg.payload as { error?: string } | undefined)?.error ??
          "The other device stopped the sync";
        await cleanup();
      }
    } catch (err) {
      console.error("[Sync][Source] Error handling message:", err);
    }
  });

  syncState.isConnecting = true;
  console.log("[Sync][Source] Connecting to room...");
  await sourceTransport.connect();
  if (_transport !== sourceTransport || !_syncRoomCode) return;
  sourceTransport.joinRoom(_syncRoomCode);
  console.log("[Sync][Source] Connected to room");
}

/** Source-side: the waiting request went away; wait for the next one. */
function backToWaiting(): void {
  _pendingRequest = null;
  syncState.awaitingApproval = false;
  syncState.pairingCode = null;
  if (!syncState.isSyncing && !syncState.isComplete) syncState.isConnecting = true;
}

/**
 * Source-side: someone in the sync room asks for the export. Holding the
 * token makes it a request, and nothing more: the user is shown the code
 * and decides (approveSync / denySync). Every refusal is said to the
 * requester, which otherwise sat on "0%" until its stall watchdog fired.
 */
async function handleExportRequest(
  transport: PeerTransport,
  peerId: string,
  msg: SyncMessage
): Promise<void> {
  const refuse = (error: string) =>
    transport.send(peerId, errorFrame(error)).catch(() => false);
  // Checked first, before the token: a version 1 target would read data it
  // cannot check, and without approval either.
  if (msg.v !== SYNC_PROTOCOL_VERSION) {
    console.warn("[Sync][Source] Rejected ExportRequest: protocol version", msg.v);
    await refuse(SYNC_VERSION_MISMATCH);
    return;
  }
  const { mode, token, roomDeletions } = (msg.payload ?? {}) as {
    mode?: "add" | "replace";
    token?: string;
    roomDeletions?: unknown[];
  };

  // The room handshake proves the fresh 256-bit capability; require the
  // complete pairing token as well, regardless of the UI entry method.
  if (!tokenAccepted(token, _syncToken, false)) {
    console.warn("[Sync][Source] Rejected ExportRequest: bad token");
    await refuse("Sync token mismatch - refresh/update the app on both devices and generate a new code");
    return;
  }

  const holder = _authorizedExportPeer ?? _pendingRequest?.peerId ?? null;
  if (holder === peerId) {
    // The same request again (its sender retries a send it could not
    // confirm). Still waiting: say so again, in case the first never landed.
    if (_pendingRequest) {
      await transport.send(peerId, frame(SyncMessageType.ApprovalPending, { nonce: _pendingRequest.nonce }))
        .catch(() => false);
    }
    return;
  }
  if (holder !== null) {
    console.warn("[Sync][Source] Refused a second requester");
    await refuse(SECOND_REQUESTER);
    return;
  }
  if (syncState.isComplete || !_syncToken) return;

  const nonce = newSyncNonce();
  _pendingRequest = {
    peerId,
    mode: mode === "add" ? "add" : "replace",
    roomDeletions: Array.isArray(roomDeletions) ? roomDeletions : [],
    nonce,
  };
  syncState.isConnecting = false;
  syncState.pairingCode = syncComparisonCode(transport.selfId(), peerId, _syncToken, nonce);
  syncState.awaitingApproval = true;
  console.log(`[Sync][Source] ExportRequest (${_pendingRequest.mode}) waiting for approval`);
  await transport.send(peerId, frame(SyncMessageType.ApprovalPending, { nonce })).catch(() => false);
}

/**
 * Source-side: the user allowed the waiting request. Only now does anything
 * the request carried touch this device - its leave markers - and only now
 * does data go out.
 */
export async function approveSync(): Promise<void> {
  const request = _pendingRequest;
  const transport = _transport;
  if (!request || !transport || !_isSourceDevice) return;
  _pendingRequest = null;
  _authorizedExportPeer = request.peerId;
  syncState.awaitingApproval = false;
  syncState.pairingCode = null;
  syncState.isConnecting = false;
  syncState.isSyncing = true;
  if (request.mode === "add" && request.roomDeletions.length > 0) {
    try {
      await applyRoomDeletionMarkers(request.roomDeletions);
    } catch (err) {
      // Unanswered, this left isSyncing set with nothing running: a source
      // spinning at 0% forever, and a target waiting on its stall watchdog.
      console.error("[Sync][Source] Applying the other device's room leaves failed:", err);
      if (_transport !== transport) return;
      const message = "Could not apply the other device's room changes. Nothing was sent - try again.";
      syncState.isSyncing = false;
      syncState.syncError = message;
      await cleanup({ peerId: request.peerId, data: errorFrame(message) });
      return;
    }
    if (_transport !== transport) return;
  }
  console.log(`[Sync][Source] Approved, sending data in ${request.mode} mode`);
  await sendExportData(request.peerId, request.mode);
}

/**
 * Source-side: the user denied the waiting request. The code is spent with
 * it: whoever asked held it, and a denial says that was not the user.
 */
export async function denySync(): Promise<void> {
  const request = _pendingRequest;
  if (!request || !_transport || !_isSourceDevice) return;
  _pendingRequest = null;
  syncState.awaitingApproval = false;
  syncState.pairingCode = null;
  syncState.isConnecting = false;
  syncState.syncError =
    "You declined the sync request. This code no longer works - generate a new one to try again.";
  await cleanup({ peerId: request.peerId, data: errorFrame("Your other device declined this sync.") });
}

/**
 * Send exported database data to the target device in batches, paced on its
 * acks, and close with a manifest of what was sent.
 */
async function sendExportData(
  peerId: string,
  mode: "add" | "replace" = "replace"
): Promise<void> {
  if (!_transport) return;
  const transport = _transport;
  const token = _syncToken ?? undefined;
  const room = _syncRoomCode;
  const current = () => _transport === transport && _syncRoomCode === room &&
    (_syncToken ?? undefined) === token;
  const pacing = new SendWindow(SEND_WINDOW_FRAMES, SEND_WINDOW_BYTES);
  _sendWindow = pacing;
  let seq = 0;

  // One data frame, once the window has room for it. Echoes the
  // proof-of-scan token, so the target can reject data from a peer that
  // never proved it holds the shared secret, and a seq for the ack to name.
  //
  // send() resolving false means the stream is gone; silently pouring the
  // rest of the export into it is how the source reached 90% with a target
  // that had stopped hearing anything at 20%. It resolves in bounded time:
  // the transport gives a frame a drain budget scaled to its size, so a far
  // end that stopped reading fails the send instead of parking this loop.
  const sendData = async (payload: Record<string, unknown>, what: string): Promise<boolean> => {
    const bytes = frame(SyncMessageType.ExportData, { ...payload, token, seq });
    await pacing.reserve(bytes.length);
    if (!current()) return false;
    pacing.sent(seq, bytes.length);
    seq++;
    if (!_ackTimeoutTimer) armAckTimer();
    const ok = await transport.send(peerId, bytes);
    if (!current()) return false;
    if (!ok) throw new Error(`Connection lost while sending ${what} - try again`);
    return true;
  };

  console.log(`[Sync][Source] Exporting data in ${mode} mode`);

  try {
    // In "add" mode, we skip identity export since target keeps its own
    const exportData = await exportDatabase(mode === "add");
    if (!current()) return;

    // Which account this is. A merge target refuses any other, and the
    // binding is what makes this a proof rather than a claim: it signs this
    // Noise-authenticated connection's peer id with the account key, which
    // only devices of the account hold.
    const did = (await getKeypairRecord())?.did;
    if (!did) throw new Error("This device has no account to sync from");
    const { bindingSig } = signPeerBinding(transport.selfId());
    if (!current()) return;

    // Identity first. Checked like every other send: this is the one frame
    // whose loss leaves the target sitting at exactly 0%.
    if (!(await sendData({ section: "identity", data: exportData.identity, did, binding: bindingSig }, "identity"))) {
      return;
    }

    syncState.syncProgress = 10;

    const sections: { name: string; data: unknown[] }[] = [
      ...EXPORT_SECTIONS.map((name) => ({
        name,
        data: (exportData[name] ?? []) as unknown[],
      })),
      ...(exportData.localState ? [{ name: "localState", data: [exportData.localState] }] : []),
    ];
    const manifest: SyncManifest = {};

    let processed = 0;
    for (const section of sections) {
      // Batches close on bytes as well as count: 50 attachments per frame
      // put whole image blobs into one message and blew the receiver's 4MB
      // frame cap, which killed the stream - the sync that sat at 90% on one
      // device and 20% on the other. An item too big even alone travels
      // without its bytes; the record still syncs and the file layer
      // re-fetches the bytes from this device later. (The local state's
      // heavy part is the DM retry queue, which then stays behind.)
      const heavy = section.name === "localState" ? "dmQueue" : "data";
      const batches: unknown[][] = [];
      let cur: unknown[] = [];
      let curBytes = 0;
      for (const item of section.data) {
        let entry = item;
        let sz = utf8Length(JSON.stringify(entry) ?? "");
        if (sz > MAX_BATCH_BYTES) {
          const { [heavy]: _dropped, ...rest } = entry as Record<string, unknown>;
          console.warn(
            `[Sync][Source] ${section.name} item exceeds the frame budget - sent without ${heavy}`
          );
          entry = rest;
          sz = utf8Length(JSON.stringify(entry) ?? "");
        }
        if (cur.length && (cur.length >= BATCH_SIZE || curBytes + sz > MAX_BATCH_BYTES)) {
          batches.push(cur);
          cur = [];
          curBytes = 0;
        }
        cur.push(entry);
        curBytes += sz;
      }
      if (cur.length) batches.push(cur);
      manifest[section.name] = { items: section.data.length, batches: batches.length };
      console.log(
        `[Sync][Source] Sending ${section.name}: ${section.data.length} items in ${batches.length} batches`
      );

      for (let i = 0; i < batches.length; i++) {
        if (!current()) return;
        const sent = await sendData({
          section: section.name,
          batchIndex: i,
          totalBatches: batches.length,
          data: batches[i],
        }, section.name);
        if (!sent) return;
      }
      processed++;
      syncState.syncProgress =
        10 + Math.floor((processed / sections.length) * 80);
      console.log(
        `[Sync][Source] Sent ${section.name}: ${Math.round(syncState.syncProgress)}%`
      );
    }

    // Everything taken in over there before the manifest goes: the target
    // checks it against what it holds, so it must hold all of it.
    await pacing.drained();
    if (!current()) return;

    console.log("[Sync][Source] Sending ExportComplete");
    // From here what remains is the other device writing it, which its
    // ImportProgress frames narrate. Not 100% yet: that waits for its
    // acknowledgment, but not forever - a target that died mid-import used
    // to leave this side parked at 90% with no error. Set before the send,
    // because a quick target can answer before the send resolves.
    _exportSent = true;
    syncState.syncProgress = 90;
    syncState.phase = "importing-remote";
    armAckTimer();
    const okComplete = await transport.send(
      peerId,
      frame(SyncMessageType.ExportComplete, { manifest, token })
    );
    if (!current()) return;
    if (!okComplete) {
      throw new Error("Connection lost before the export finished - try again");
    }
    console.log("[Sync][Source] Waiting for target to finish importing...");
  } catch (err) {
    if (!current()) return;
    console.error("[Sync] Error sending export data:", err);
    // Into syncState, not only the console. Every throw in this function
    // landed here and stopped: no error was set, isSyncing stayed true, and
    // the dialog only leaves the progress view when syncError is truthy. So
    // the source froze at whatever percentage it had reached.
    const message = err instanceof Error ? err.message : String(err);
    syncState.syncError = message;
    syncState.isSyncing = false;
    await cleanup({ peerId, data: errorFrame(message) });
  }
}

/**
 * What a committed import that failed part way leaves behind, said plainly:
 * past the commit point nothing is rolled back, and "Import failed" alone
 * left the user guessing whether the device still held anything.
 */
function interruptedImportMessage(mode: "add" | "replace", reason: string): string {
  return mode === "replace"
    ? `The import stopped part way (${reason}). This device's previous data was already erased, and only part of the other device's arrived. Run the sync again with Replace to finish.`
    : `The merge stopped part way (${reason}). Nothing that was already on this device was removed, but only part of the other device's data was added. Run the sync again to add the rest.`;
}

/**
 * Connect to a sync room as the target device (receiving data).
 * Call this after scanning a QR code or entering plaintext.
 */
export async function connectAsTarget(
  payload: SyncPayload,
  importOptions: ImportOptions = {}
): Promise<void> {
  if (!payload.roomSecret || !payload.peerId || !/^[a-f0-9]{32}$/i.test(payload.token ?? "")) {
    throw new Error("Update both devices and generate a new complete secure sync code.");
  }
  if (!Number.isFinite(payload.expires)) throw new Error("Invalid sync invitation expiry.");
  const pairingSecret = parseRoomSecret(payload.roomSecret);
  if (deriveRoomKeys(pairingSecret).discoveryId !== payload.roomCode) throw new Error("Sync capability mismatch");
  if (payload.expires < Date.now()) {
    throw new Error("Sync code has expired");
  }
  // No way to authenticate the source connection without this - refuse
  // rather than pin to whichever peer joins the room first.
  if (!payload.peerId && !payload.peerPrefix) {
    throw new Error(
      "This sync code is from an older version of the app - update both devices and generate a new code"
    );
  }
  // Same as generateSyncCode: a committed import finishes and reports first.
  if (_importCommitDone) await _importCommitDone;

  const mode = payload.mode ?? "replace";
  // Same fresh-attempt guarantee as generateSyncCode: completion and progress
  // belong to one pairing session, never to the dialog component's lifetime.
  resetSyncState();
  const previousCleanup = cleanup();
  const attemptToken = generateToken();
  _syncToken = attemptToken;
  // Room code redacted for the same reason as on the source side.
  console.log(`[Sync][Target] Starting sync client, mode: ${mode}`);

  syncState.isConnecting = true;
  syncState.syncError = null;

  try {
    await previousCleanup;
    await _importCommitDone;
    if (_syncToken !== attemptToken) return;
    _syncRoomCode = payload.roomCode;
    _syncRoomSecret = pairingSecret;
    _isSourceDevice = false;

    _transport = new SecureSyncTransport(pairingSecret);
    const targetTransport = _transport;
    const current = () => _transport === targetTransport;

    let receivedIdentity: DatabaseExport["identity"] | null = null;
    /** The account the source proved it is (merge mode), from its identity frame. */
    let sourceAccount: string | null = null;
    let receivedLocalState: LocalStateExport | undefined;
    const receivedData: Partial<DatabaseExport> = {};
    /**
     * What actually arrived of each section, checked against the source's
     * manifest before anything is written: silently losing part of
     * somebody's history is worse than failing.
     */
    const received = new Map<string, ReceivedSection>();
    const knownSections: readonly string[] = [...EXPORT_SECTIONS, "localState"];
    /**
     * The source's ExportComplete arrived and checked out. Everything after
     * it is this device's own import, which needs nothing more from the
     * source - so neither its errors nor its connection dropping stop it.
     */
    let transferDone = false;
    /** Data has started to arrive, which only an allowed request gets. */
    let allowed = false;
    /** Frames are handled one at a time, in the order they came. */
    let inbox: Promise<void> = Promise.resolve();

    /** Give up before anything was written, and tell the source why. */
    const fail = async (message: string, tellSource?: string): Promise<void> => {
      if (!current()) return;
      clearStallTimer();
      syncState.isConnecting = false;
      syncState.isSyncing = false;
      syncState.syncError = message;
      const source = _targetSourcePeerId;
      await cleanup(tellSource && source ? { peerId: source, data: errorFrame(tellSource) } : undefined);
    };

    /**
     * Send the ExportRequest until the transport confirms a write.
     *
     * send() resolves false when the outbound stream never confirms - a
     * fresh dial that lands on a dead relay circuit is the realistic way,
     * and the target has heard nothing from the source yet, so it always
     * dials fresh. Firing the request once and dropping the result left
     * this device at 0% until the stall watchdog blamed the other side for
     * a request that never left this one.
     */
    const requestExport = async (peerId: string): Promise<void> => {
      const roomDeletions = mode === "add" ? await getAllRoomDeletionMarkers() : [];
      const request = frame(SyncMessageType.ExportRequest, {
        mode, token: payload.token, roomDeletions,
      });
      // ponytail: 3 tries, 2s apart; each send already spends the
      // transport's ~5.6s confirm budget before resolving false.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (_transport !== targetTransport || !syncState.isSyncing || syncState.isComplete) return;
        if (await _transport.send(peerId, request)) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      syncState.isSyncing = false;
      syncState.syncError =
        "Could not send the sync request to the other device - generate a new code and try again.";
      cleanup().catch(() => {});
    };

    // Target sends ExportRequest after connecting
    _transport.on("connect", (peerId: string) => {
      // Pin ONLY to the peer whose peerId matches the QR/short code - the
      // libp2p connection is Noise-authenticated to this peerId, so this is
      // what stops the relay operator (or anyone else) from joining the
      // ephemeral room first and impersonating the source. Any other peer
      // is ignored entirely: never sent the ExportRequest, never trusted.
      if (!matchesSourcePeer(payload, peerId)) {
        console.warn(
          "[Sync][Target] Ignoring peer that doesn't match the source:",
          peerId.slice(0, 8)
        );
        return;
      }
      if (_targetSourcePeerId && _targetSourcePeerId !== peerId) {
        console.warn(
          "[Sync][Target] Ignoring extra peer in sync room:",
          peerId.slice(0, 8)
        );
        return;
      }
      // ONE request per sync. peer:identify fires again whenever the link is
      // re-established - notably when the relayed circuit upgrades to direct
      // WebRTC, which happens mid-transfer - and the transport re-emits
      // "connect" for it. Re-sending here made the source restart the whole
      // export on top of the one in flight.
      if (_exportRequested) {
        console.log("[Sync][Target] Re-connect to source, export already requested");
        return;
      }
      _exportRequested = true;
      _targetSourcePeerId = peerId;
      console.log("[Sync][Target] Connected to source:", peerId.slice(0, 8));
      if (_peerWaitTimer) {
        clearTimeout(_peerWaitTimer);
        _peerWaitTimer = null;
      }
      syncState.isConnecting = false;
      syncState.isSyncing = true;
      armStallTimer();

      // Request data from source with mode + proof-of-scan token
      void requestExport(peerId);
    });

    // The source only: every peer this node loses fires here, the relay
    // included, and an unfiltered handler called a relay hiccup "Connection
    // lost" - which then stuck over a sync that went on to finish. And not
    // once the transfer is done: the import that follows needs nothing from
    // the source.
    _transport.on("disconnect", (peerId: string) => {
      if (!current() || peerId !== _targetSourcePeerId || transferDone || syncState.isComplete) return;
      console.log("[Sync][Target] Disconnected from source");
      void fail("Lost the connection to the other device. Nothing on this device was changed - generate a new code and try again.");
    });

    const onData = async (peerId: string, raw: unknown): Promise<void> => {
      armStallTimer();
      // The answer came, and it was Allow.
      allowed = true;
      syncState.awaitingApproval = false;
      syncState.pairingCode = null;
      const p = (raw ?? {}) as {
        section?: unknown;
        data?: unknown;
        batchIndex?: unknown;
        totalBatches?: unknown;
        token?: string;
        seq?: unknown;
        did?: unknown;
        binding?: unknown;
      };

      // The source must echo the proof-of-scan token. A peer that never
      // saw the QR/short code can't produce it, so its data is dropped.
      // Full token when this device scanned the QR, the 8-char prefix
      // only when the short code is what it was given (see tokenAccepted).
      if (!tokenAccepted(p.token, payload.token, !payload.peerId)) {
        console.warn("[Sync][Target] Dropping ExportData: token mismatch");
        return;
      }

      if (p.section === "identity") {
        if (mode === "add") {
          // A merge folds the other device's own profile and room overrides
          // in as this account's, so it is only for the same account - and
          // the source has to prove it is, not just say so: the binding is
          // the account key's signature over the authenticated peer id this
          // frame came on.
          const localDid = (await getKeypairRecord())?.did;
          const proven = typeof p.did === "string" && p.did === localDid &&
            typeof p.binding === "string" && (await verifyPeerBinding(p.did, peerId, p.binding));
          if (!current()) return;
          if (!proven) {
            await fail(DIFFERENT_ACCOUNT_MERGE,
              "The other device is signed in to a different account, so it did not merge.");
            return;
          }
          sourceAccount = p.did as string;
          // A merge keeps THIS device's identity. The source skips the
          // section in add mode; one that sends it anyway is ignored here
          // and again by the importer.
          if (p.data) {
            console.warn("[Sync][Target] Ignoring identity section: merge keeps this device's identity");
          }
        } else {
          receivedIdentity = (p.data ?? null) as DatabaseExport["identity"] | null;
        }
        syncState.syncProgress = 10;
      } else if (typeof p.section === "string" && knownSections.includes(p.section)) {
        const { section, data: sectionData, batchIndex, totalBatches } = p as {
          section: string; data: unknown; batchIndex: unknown; totalBatches: unknown;
        };
        if (
          !Array.isArray(sectionData) ||
          typeof batchIndex !== "number" || typeof totalBatches !== "number" ||
          !Number.isSafeInteger(batchIndex) || !Number.isSafeInteger(totalBatches) ||
          batchIndex < 0 || batchIndex >= totalBatches
        ) {
          await fail("The other device sent a damaged batch. Nothing was changed - try again.",
            "This device received a damaged batch - try again.");
          return;
        }
        let got = received.get(section);
        if (!got) {
          got = { items: 0, batches: new Set(), announced: totalBatches };
          received.set(section, got);
        }
        // A section whose frames disagree on its size is not whole either.
        if (got.announced !== totalBatches) got.announced = Number.NaN;
        // A batch seen twice is counted, and kept, once.
        if (!got.batches.has(batchIndex)) {
          got.batches.add(batchIndex);
          got.items += sectionData.length;
          if (section === "localState") {
            receivedLocalState = sectionData[0] as LocalStateExport | undefined;
          } else {
            const key = section as keyof DatabaseExport;
            const arr = ((receivedData as Record<string, unknown[]>)[key] ??= []);
            arr.push(...sectionData);
          }
        }

        // Update progress
        const sectionIndex = knownSections.indexOf(section);
        const sectionProgress = (batchIndex + 1) / totalBatches;
        syncState.syncProgress = Math.max(
          syncState.syncProgress,
          10 + Math.floor(((sectionIndex + sectionProgress) / knownSections.length) * 80)
        );
      } else {
        // Same protocol version, a section it does not know: something is
        // wrong with one of the two builds, and guessing would be worse.
        await fail(SYNC_VERSION_MISMATCH, SYNC_VERSION_MISMATCH);
        return;
      }

      // Taken in: the source may send more. Not awaited, so the next frame
      // is not held up behind the confirmation of this one.
      void targetTransport.send(peerId, frame(SyncMessageType.ExportAck, { seq: p.seq })).catch(() => false);
    };

    /** The import, once the transfer checked out. Always ends reported. */
    const runImport = async (peerId: string): Promise<void> => {
      const tell = (type: SyncMessageType, framePayload?: unknown) =>
        targetTransport.send(peerId, frame(type, framePayload)).catch(() => false);
      // The transfer is done; the last ten percent is this device writing
      // what arrived. It used to sit at the transfer's final number with
      // "Syncing data" on it for as long as the import took, which on a
      // phone with a real history is minutes.
      syncState.phase = "importing";
      syncState.syncProgress = Math.max(syncState.syncProgress, 90);
      let lastReport = 0;
      const report = (): void => {
        lastReport = Date.now();
        void tell(SyncMessageType.ImportProgress, { percent: syncState.syncProgress });
      };
      const onProgress = (done: number, total: number): void => {
        if (_transport !== targetTransport) return;
        const percent =
          total > 0 ? 90 + Math.floor((done / total) * 9) : 99;
        if (percent > syncState.syncProgress) {
          syncState.syncProgress = percent;
        }
        // The source restarts its ack clock on each of these, so a slow
        // import is narrated rather than timed out. Throttled: the
        // frames ride the same stream the import just emptied.
        if (Date.now() - lastReport < 2000) return;
        report();
      };
      let committed = false;
      let releaseCommit: (() => void) | undefined;
      try {
        const { droppedRecords } = await importDatabase(
          {
            identity: receivedIdentity || undefined,
            messages: (receivedData.messages || []) as Message[],
            attachments: (receivedData.attachments ||
              []) as AttachmentExport[],
            pending: (receivedData.pending || []) as PendingMessage[],
            watermarks: (receivedData.watermarks ||
              []) as WatermarkRecord[],
            yjsDocs: (receivedData.yjsDocs || []) as {
              id: string;
              update: number[];
            }[],
            rooms: (receivedData.rooms || []) as (Room | DMRoom)[],
            profiles: (receivedData.profiles || []) as (
              | PeerProfile
              | OwnProfile
            )[],
            roomProfiles: (receivedData.roomProfiles || []) as DatabaseExport["roomProfiles"],
            roomDeletions: (receivedData.roomDeletions || []) as DatabaseExport["roomDeletions"],
            savedGifs: (receivedData.savedGifs || []) as SavedGif[],
            // The source listed these (the manifest checked it), so an
            // empty one here is an empty list there, not one never sent.
            phonebook: (receivedData.phonebook || []) as DatabaseExport["phonebook"],
            blocks: (receivedData.blocks || []) as DatabaseExport["blocks"],
            localState: receivedLocalState,
          },
          mode,
          // Carries the password prompt: with an identity in the export
          // the at-rest key is armed before the first row is written,
          // so nothing lands in plaintext on a device that has never
          // unlocked (see importDatabase).
          { ...importOptions, onProgress,
            sourceDid: mode === "add" ? sourceAccount ?? undefined : undefined,
            requestPassword: importOptions.requestPassword ? async (retry) => {
              if (_transport !== targetTransport) return null;
              // The source times this device's silence, and a person
              // typing a password is not a stall: say so, and it waits for
              // the next frame instead of giving up on a sync that is
              // about to finish.
              void tell(SyncMessageType.AwaitingPassword);
              const password = await importOptions.requestPassword!(retry);
              if (_transport !== targetTransport) return null;
              // Working again, said at once rather than on the next
              // throttled tick, so the source's clock restarts now.
              report();
              return password;
            } : undefined,
            beforeCommit: () => {
              if (_transport !== targetTransport) throw new Error("Sync import cancelled before commit");
              importOptions.beforeCommit?.();
              if (_transport !== targetTransport) throw new Error("Sync import cancelled before commit");
              if (_importCommitDone) throw new Error("Another import is committing");
              _importCommitDone = new Promise<void>((resolve) => { releaseCommit = resolve; });
              committed = true;
              syncState.finishing = true;
            } }
        );
        // Cancelled before anything was written: the cancel said it all.
        if (!committed && _transport !== targetTransport) return;
        if (droppedRecords > 0) {
          // The sync itself succeeded - this is a partial-data note,
          // not a failure, so it doesn't route through syncError/the
          // error view.
          console.warn(
            `[Sync][Target] Dropped ${droppedRecords} malformed record(s) from the source's export`
          );
        }

        console.log(
          "[Sync][Target] Import complete, sending acknowledgment"
        );
        // AWAIT it, then tear down: dropping the promise before
        // cleanup() disconnected the transport meant the source often
        // never saw the completion. The transport bounds the wait, so a
        // source that already gave up cannot hold this side at 99.
        if (_transport === targetTransport) await tell(SyncMessageType.ExportComplete);

        // Reported whatever happened to the connection meanwhile: past the
        // commit point this is the only word on what this device now holds.
        syncState.isSyncing = false;
        syncState.isComplete = true;
        syncState.syncProgress = 100;
        syncState.syncError = null;
      } catch (err) {
        if (!committed && _transport !== targetTransport) return;
        console.error("[Sync][Target] Import failed:", err);
        const reason = err instanceof Error ? err.message : "Import failed";
        syncState.isSyncing = false;
        syncState.syncError = committed ? interruptedImportMessage(mode, reason) : reason;
        if (_transport === targetTransport) await tell(SyncMessageType.SyncError, { error: reason });
      } finally {
        syncState.finishing = false;
        clearStallTimer();
        if (_transport === targetTransport) await cleanup();
        // Last: whatever waits on the lease sees this attempt's result.
        if (releaseCommit) {
          _importCommitDone = null;
          releaseCommit();
        }
      }
    };

    const handle = async (peerId: string, data: Uint8Array): Promise<void> => {
      if (!current()) return;
      const msg = decode(data) as SyncMessage | null;
      // Not every frame on this link is the protocol's: the transport's own
      // keepalive (`__ping`) rides the same secure room, carries no version,
      // and would otherwise read as a version 1 source below - failing a sync
      // whose user was still reading the comparison code.
      if (!msg || typeof msg !== "object" || !SYNC_MESSAGE_TYPES.has(msg.type)) return;
      console.log("[Sync][Target] Message type:", msg.type);
      if (msg.type === SyncMessageType.SyncError) {
        if (transferDone) return;
        await fail((msg.payload as { error?: string } | undefined)?.error ??
          "The other device stopped the sync");
        return;
      }
      if (transferDone) return;
      // A version 1 source streams everything the moment it is asked, with
      // no manifest to check it against and no account in a merge: refuse
      // its first frame and tell it why, rather than import half of a format.
      if (msg.v !== SYNC_PROTOCOL_VERSION) {
        await fail(SYNC_VERSION_MISMATCH, SYNC_VERSION_MISMATCH);
        return;
      }
      if (msg.type === SyncMessageType.ApprovalPending) {
        const { nonce } = (msg.payload ?? {}) as { nonce?: unknown };
        // Once data flows the question has been answered; a late repeat of
        // it must not put the code back over a transfer.
        if (allowed || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return;
        // The other device is asking its user, which takes as long as
        // reading six digits does. The stall watchdog measures silence in
        // a transfer, and this is not one yet: the next frame - the data,
        // or the refusal - re-arms it.
        clearStallTimer();
        syncState.pairingCode = syncComparisonCode(peerId, targetTransport.selfId(), payload.token, nonce);
        syncState.awaitingApproval = true;
      } else if (msg.type === SyncMessageType.ExportData) {
        await onData(peerId, msg.payload);
      } else if (msg.type === SyncMessageType.ExportComplete) {
        // Everything has arrived; the import that follows reads and writes
        // the whole database and sends no frames, so a watchdog left armed
        // through it would abort a sync that is actually finishing.
        clearStallTimer();
        const { manifest, token: echoedToken } = (msg.payload ?? {}) as { manifest?: unknown; token?: string };
        if (!tokenAccepted(echoedToken, payload.token, !payload.peerId)) {
          console.warn("[Sync][Target] Dropping ExportComplete: token mismatch");
          return;
        }
        // Refuse a partial import. A section that announced N batches and
        // delivered fewer, or one that never arrived at all, means history
        // is missing, and the user cannot see that from a bar at 100%.
        const problems = manifestProblems(manifest, received, EXPORT_SECTIONS);
        if (problems.length > 0) {
          console.error("[Sync][Target] Incomplete transfer:", problems);
          await fail(
            `The transfer arrived incomplete (${problems.join(", ")}). Nothing was changed - generate a new code and try again.`,
            "The transfer arrived incomplete - try again."
          );
          return;
        }
        if (mode === "add" ? !sourceAccount : !receivedIdentity) {
          await fail(mode === "add"
            ? "The other device did not say which account it is. Nothing was changed - update both devices and try again."
            : "No identity data received");
          return;
        }
        transferDone = true;
        console.log("[Sync][Target] Received ExportComplete, importing data...");
        // Not awaited: frames that still arrive are read (and ignored)
        // instead of queueing behind a long import.
        void runImport(peerId);
      }
    };

    _transport.on("message", (peerId: string, data: Uint8Array, room: string | null) => {
      if (_transport !== targetTransport || room !== _syncRoomCode) return;
      // Only accept sync traffic from the authenticated source peer - both
      // the identity check (peerId matches the QR/short code) and the pin
      // (peerId matches the one "connect" already accepted). The identity
      // check alone would still be racy against a message arriving before
      // "connect" pins _targetSourcePeerId.
      if (!matchesSourcePeer(payload, peerId)) {
        console.warn(
          "[Sync][Target] Dropping message from non-source peer:",
          peerId.slice(0, 8)
        );
        return;
      }
      if (_targetSourcePeerId && peerId !== _targetSourcePeerId) {
        console.warn(
          "[Sync][Target] Dropping message from non-source peer:",
          peerId.slice(0, 8)
        );
        return;
      }
      console.log("[Sync][Target] Received message from:", peerId.slice(0, 8));
      inbox = inbox.then(() => handle(peerId, data)).catch((err) => {
        if (!current()) return;
        console.error("[Sync] Error handling message:", err);
        return fail(err instanceof Error ? err.message : String(err));
      });
    });

    await targetTransport.connect();
    if (_transport !== targetTransport) return;
    targetTransport.joinRoom(payload.roomCode);

    // Joining the room is not the same as finding the other device: the
    // source may have expired its code, closed the dialog, or never gotten
    // its own server up. Without this the target spun forever on
    // "Connecting..." with nothing to act on.
    if (_peerWaitTimer) clearTimeout(_peerWaitTimer);
    _peerWaitTimer = setTimeout(() => {
      _peerWaitTimer = null;
      if (_targetSourcePeerId || syncState.isSyncing || syncState.isComplete)
        return;
      syncState.isConnecting = false;
      syncState.syncError =
        "Could not reach the other device. Make sure its sync screen is still open, then generate a new code and try again.";
      cleanup().catch(() => {});
    }, PEER_WAIT_TIMEOUT);
  } catch (err) {
    syncState.isConnecting = false;
    syncState.syncError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Export all database content.
 * If skipIdentity is true, returns empty identity (for "add" mode where target keeps its identity)
 */
async function exportDatabase(skipIdentity = false): Promise<DatabaseExport> {
  const db = await getDB();
  const dmQueueBlob = readDmQueueBlob();

  const [mnemonicRaw, keypairRaw] = await Promise.all([
    db.get("identity", "mnemonic"),
    db.get("identity", "keypair"),
  ]);

  const mnemonic = mnemonicRaw as {
    salt: Uint8Array;
    iv: Uint8Array;
    encrypted: ArrayBuffer;
    iterations?: number;
  };
  const keypair = keypairRaw as { did: string; publicKey: Uint8Array };

  let identity: DatabaseExport["identity"] | null = null;

  if (!skipIdentity) {
    identity = {
      mnemonic: {
        salt: Array.from(new Uint8Array(mnemonic.salt)),
        iv: Array.from(new Uint8Array(mnemonic.iv)),
        encrypted: Array.from(new Uint8Array(mnemonic.encrypted)),
        // Without this the target derives the key with the legacy iteration
        // count and rejects the correct password as wrong.
        iterations: mnemonic.iterations,
      },
      keypair: {
        did: keypair.did,
        publicKey: Array.from(new Uint8Array(keypair.publicKey)),
      },
    };
  }

  const [
    messages,
    attachments,
    pending,
    watermarks,
    yjsDocs,
    rooms,
    profiles,
    savedGifs,
    roomProfiles,
    roomDeletions,
    phonebook,
    blocks,
  ] = await Promise.all([
    // The export format carries PLAINTEXT records (it has its own transport
    // encryption and validators that inspect fields), so sealed rows are
    // opened here; the importing side re-seals through the storage API.
    db.getAll("messages").then((r) => openRows<Message>(r, STORE_SPECS.messages)),
    db
      .getAll("attachments")
      .then((r) => openRows<Attachment>(r, STORE_SPECS.attachments)),
    db
      .getAll("pending")
      .then((r) => openRows<PendingMessage>(r, STORE_SPECS.pending)),
    db.getAll("watermarks").then((r) =>
      openRows<DatabaseExport["watermarks"][number]>(r, STORE_SPECS.watermarks),
    ),
    db
      .getAll("yjsDocs")
      .then((r) => openRows(r, STORE_SPECS.yjsDocs))
      .then((docs) =>
        (docs as { id: string; update: Uint8Array | ArrayBuffer }[]).map(
          (d) => ({ id: d.id, update: new Uint8Array(d.update as ArrayBuffer) })
        )
      ),
    db.getAll("rooms").then((r) => openRows(r, STORE_SPECS.rooms)),
    db.getAll("profiles").then((r) => openRows(r, STORE_SPECS.profiles)),
    db.getAll("savedGifs").then((r) => openRows(r, STORE_SPECS.savedGifs)),
    getAllOwnRoomProfiles(),
    getAllRoomDeletionMarkers(),
    getPhonebookEntries(),
    // Lifted blocks included: their windows keep refused DMs refused.
    getBlockEntries(),
  ]);

  const result: DatabaseExport = {
    messages,
    attachments: (attachments as Attachment[]).map((a) => ({
      ...a,
      data: a.data ? bytesToBase64(new Uint8Array(a.data)) : undefined,
    })),
    pending,
    watermarks,
    yjsDocs: (yjsDocs as { id: string; update: Uint8Array }[]).map((doc) => ({
      id: doc.id,
      update: Array.from(doc.update),
    })),
    rooms: (rooms as (Room | DMRoom)[]).map(pfpToJson),
    profiles: (profiles as (PeerProfile | OwnProfile)[]).map(pfpToJson),
    roomProfiles: roomProfiles.filter(r => {
      const joined = (rooms as (Room | DMRoom)[]).find(room => room.roomCode === r.roomCode);
      const marker = roomDeletions.find(m => m.roomCode === r.roomCode);
      return (!keypair || r.did === keypair.did) && joined?.type === "text" &&
        r.generation > (marker ? roomDeletionCutoff(marker) : -1);
    }).map(roomProfileToExport),
    roomDeletions,
    // Saved uploaded gifs carry bytes, and JSON.stringify(ArrayBuffer) is {} -
    // without this they silently arrived empty on the other device.
    savedGifs: (savedGifs as SavedGif[]).map((g) => ({
      ...g,
      data: g.data
        ? (bytesToBase64(new Uint8Array(g.data)) as unknown as ArrayBuffer)
        : undefined,
    })),
    phonebook,
    blocks,
    // What the account keeps outside IndexedDB. Not the microphone or the
    // camera: those were picked for this device's hardware.
    localState: {
      ...peerAudioPrefs(),
      dmCallsJoined: dmCallsJoined(),
      ...(dmQueueBlob ? { dmQueue: dmQueueBlob } : {}),
    },
  };

  if (identity) {
    result.identity = identity;
  }

  return result;
}

/**
 * Import database content from export.
 * @param mode - "replace" wipes database first, "add" merges data
 */
/**
 * Build a full backup and hand it to the browser as a download.
 *
 * The export is the whole account in the clear - every message, room code,
 * DID and attachment - so the file is AES-GCM encrypted under a passphrase
 * the user chooses here. Only the mnemonic used to be encrypted, which made
 * the old files a full history leak to anyone who picked one up.
 *
 * @param passphrase - required. Callers with no UI to ask with (the command
 *        palette) fall back to a browser prompt rather than writing plaintext.
 */
export async function downloadBackup(passphrase?: string): Promise<void> {
  const secret =
    passphrase ??
    (typeof window !== "undefined"
      ? window.prompt("Passphrase to encrypt this backup file:")
      : null);
  if (!secret) {
    throw new Error(
      "A backup needs a passphrase to encrypt it - nothing was exported"
    );
  }
  const data = await exportDatabase(false);
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: backupVersionFor(data),
    exportedAt: Date.now(),
    ...data,
  };
  const blob = new Blob([JSON.stringify(await encryptBackup(backup, secret))], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  // A dedicated extension so the OS can hand backups straight to the app
  // (manifest file_handlers); the content is a JSON envelope around the
  // ciphertext, and the restore picker keeps accepting old .json exports.
  a.download = `awful-backup-${stamp}.awfulbackup`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Reset sync state.
 */
export function resetSyncState(): void {
  syncState.isGenerating = false;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.isConnecting = false;
  syncState.isSyncing = false;
  syncState.syncProgress = 0;
  syncState.phase = "transfer";
  syncState.syncError = null;
  syncState.isComplete = false;
  syncState.awaitingApproval = false;
  syncState.pairingCode = null;
  syncState.finishing = false;
}

/**
 * Clean up resources.
 *
 * `parting` is one last frame for the other device - why this session is
 * ending - sent on the dying transport before it disconnects, so the other
 * side is told instead of waiting out a watchdog. Everything that makes the
 * session current is dropped first, synchronously, so a session started
 * meanwhile is never touched by this one's ending.
 */
async function cleanup(parting?: { peerId: string; data: Uint8Array }): Promise<void> {
  const dying = _transport;
  _transport = null;
  _pendingRequest = null;
  _sendWindow?.fail(new Error("Sync ended"));
  _sendWindow = null;
  _exportSent = false;
  _ackSuspended = false;
  syncState.awaitingApproval = false;
  syncState.pairingCode = null;
  const stoppingScanner = stopQrScan();
  if (_syncExpiryTimer) clearTimeout(_syncExpiryTimer);
  _syncExpiryTimer = null;
  _syncRoomCode = null;
  _syncRoomSecret = null;
  _syncToken = null;
  _authorizedExportPeer = null;
  _shortCodeRevealed = false;
  _isSourceDevice = false;
  _targetSourcePeerId = null;
  _exportRequested = false;
  if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
  _ackTimeoutTimer = null;
  if (_peerWaitTimer) clearTimeout(_peerWaitTimer);
  _peerWaitTimer = null;
  clearStallTimer();
  if (dying && parting) {
    // Bounded by the transport's own confirm budget.
    await dying.send(parting.peerId, parting.data).catch(() => false);
  }
  if (dying) {
    // AWAIT it. disconnect() stops the libp2p node asynchronously, and
    // dropping the promise let the next attempt start a second node while
    // the first was still tearing its relay socket down - two nodes racing
    // the same dial is exactly what made a retry fail more often than the
    // first try.
    try {
      await dying.disconnect();
    } catch {
      // A node that fails to stop cleanly is already unusable; the reference
      // is dropped either way.
    }
  }
  await stoppingScanner;
}

/**
 * Cancel/abort current sync operation, telling the other device.
 *
 * Not once an import on this device has committed: its writes go on whatever
 * happens here, and tearing the transport down under them only hid how they
 * ended - in a replace, with the wipe already done, while the person was
 * free to pick "Create new identity" and race it. That import reports and
 * cleans up after itself; the dialog offers no Cancel meanwhile.
 */
export async function cancelSync(): Promise<void> {
  if (_importCommitDone) return;
  const other = _isSourceDevice
    ? _authorizedExportPeer ?? _pendingRequest?.peerId ?? null
    : _targetSourcePeerId;
  resetSyncState();
  await cleanup(other ? { peerId: other, data: errorFrame("The sync was cancelled on the other device.") } : undefined);
}
