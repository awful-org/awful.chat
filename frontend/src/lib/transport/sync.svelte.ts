/**
 * sync.svelte.ts
 *
 * Device-to-device sync using QR codes and P2P connection.
 * Both devices connect to a temporary sync room via the standard transport layer.
 */

import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";
import type { PeerTransport } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
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
  BACKUP_VERSION,
  bytesFromExport,
  encryptBackup,
  parseBackup,
  mergeImportedRoom,
  pfpFromJson,
  pfpToJson,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
  EXPORT_SECTIONS,
} from "./backup";

export { summarizeBackup, decryptBackup } from "./backup";
// The apply/import half lives in a transport-free module so it can be tested;
// re-exported here because the UI has always imported it from this path.
export {
  applyBackup,
  readBackupFile,
  importDatabase,
} from "./backup-restore";
import { importDatabase, type ImportOptions } from "./backup-restore";
export type { ImportOptions } from "./backup-restore";
export type {
  BackupFile,
  BackupSummary,
  EncryptedBackupFile,
  ParsedBackupFile,
} from "./backup";

export interface SyncPayload {
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
  ExportData = "sync_export_data",
  ExportAck = "sync_export_ack",
  ExportComplete = "sync_export_complete",
  SyncError = "sync_error",
  /** Target to source while importing: `{ percent }`. Restarts the ack clock. */
  ImportProgress = "sync_import_progress",
}

interface SyncMessage {
  type: SyncMessageType;
  payload?: unknown;
}

export interface SyncState {
  isGenerating: boolean;
  qrDataUrl: string | null;
  plaintextToken: string | null;
  isScanning: boolean;
  scanError: string | null;
  isConnecting: boolean;
  isSyncing: boolean;
  syncProgress: number;
  /**
   * What the bar is measuring. "transfer" is frames on the wire; the last
   * ten percent is the import, on this device or the other one, which used
   * to sit at a frozen number with the transfer's label on it.
   */
  phase: "transfer" | "importing" | "importing-remote";
  syncError: string | null;
  isComplete: boolean;
}

export const syncState = $state<SyncState>({
  isGenerating: false,
  qrDataUrl: null,
  plaintextToken: null,
  isScanning: false,
  scanError: null,
  isConnecting: false,
  isSyncing: false,
  syncProgress: 0,
  phase: "transfer",
  syncError: null,
  isComplete: false,
});

let _transport: PeerTransport | null = null;
let _html5QrCode: Html5Qrcode | null = null;
let _syncRoomCode: string | null = null;
let _syncToken: string | null = null;
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
  if (payload.peerPrefix) return peerId.slice(8, 16) === payload.peerPrefix;
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
 * How long the source waits between signs of life from the target's import
 * before erroring. Restarted by every ImportProgress frame, so the bound is
 * on silence, not on the whole import.
 */
const ACK_TIMEOUT_MS = 120_000;
let _ackTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

function armAckTimer(): void {
  if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
  _ackTimeoutTimer = setTimeout(() => {
    syncState.syncError =
      "The other device never confirmed the import - try again";
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

function generateSyncRoomCode(): string {
  // Generate 8 random hex chars = 4.3 billion combinations, plenty for ephemeral sync
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));
  const random = Array.from(randomBytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${SYNC_ROOM_PREFIX}${random}`;
}

function generateToken(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const parts = shortCode.split("-");
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
  syncState.isGenerating = true;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.syncError = null;

  try {
    _syncRoomCode = generateSyncRoomCode();
    const token = generateToken();
    _syncToken = token;
    // A fresh code starts QR-only: the short code's truncated token is not
    // honoured until the user asks to see it.
    _shortCodeRevealed = false;
    const expires = Date.now() + SYNC_TIMEOUT;

    // Enforce expiry on the SOURCE: the QR/short code's own `expires` field
    // is attacker-controlled (and re-synthesized for manual codes), so the
    // only reliable expiry is tearing the server down ourselves.
    if (_syncExpiryTimer) clearTimeout(_syncExpiryTimer);
    _syncExpiryTimer = setTimeout(() => {
      if (!syncState.isSyncing && !syncState.isComplete) {
        syncState.syncError = "Sync code expired";
        cleanup().catch(() => {});
      }
    }, SYNC_TIMEOUT);

    _isSourceDevice = true;

    // Start listening for connections FIRST: the QR/short code has to carry
    // this device's real peerId (so the target can pin to it instead of
    // trusting whichever peer joins the room first), and that peerId only
    // exists once the transport is connected. The UI stays on its spinner
    // (isGenerating) for this whole span.
    try {
      await startSyncServer();
    } catch (err) {
      await cleanup();
      throw err;
    }

    const selfId = _transport?.selfId() ?? "";
    if (!selfId) {
      // The code is USELESS without a peerId to pin to - the other device
      // would scan it and have nothing to authenticate the source against.
      await cleanup();
      throw new Error("Could not determine this device's peer ID");
    }

    const payload: SyncPayload = {
      roomCode: _syncRoomCode,
      token,
      expires,
      peerId: selfId,
    };

    const payloadJson = JSON.stringify(payload);

    // Generate QR code
    const qrDataUrl = await QRCode.toDataURL(payloadJson, {
      width: 256,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

    // Create short plaintext token
    const plaintextToken = generateShortCode(_syncRoomCode, token, selfId);

    syncState.qrDataUrl = qrDataUrl;
    syncState.plaintextToken = plaintextToken;
  } catch (err) {
    syncState.syncError = err instanceof Error ? err.message : String(err);
  } finally {
    syncState.isGenerating = false;
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
 * Source waits for target to connect, then target sends ExportRequest,
 * and source responds with data.
 */
async function startSyncServer(): Promise<void> {
  if (!_syncRoomCode) return;

  // The room code is the ephemeral sync room's membership secret; anything
  // that can read the console can join it, so it never gets printed.
  console.log("[Sync][Source] Starting sync server");

  _transport = new LibP2PTransport({ diagBus: "sync" });

  // Set up handlers
  _transport.on("connect", (peerId: string) => {
    console.log("[Sync][Source] Peer connected:", peerId.slice(0, 8));
    syncState.isConnecting = false;
    syncState.isSyncing = true;
  });

  _transport.on("disconnect", () => {
    console.log("[Sync][Source] Peer disconnected");
    if (!syncState.isComplete) {
      syncState.syncError = "Connection lost";
    }
  });

  // Source handles requests from target
  _transport.on("message", async (peerId: string, data: Uint8Array) => {
    console.log("[Sync][Source] Received message from:", peerId.slice(0, 8));
    try {
      const msg = decode(data) as SyncMessage;
      console.log("[Sync][Source] Message type:", msg.type);

      if (msg.type === SyncMessageType.ExportRequest) {
        const { mode, token } = (msg.payload ?? {}) as {
          mode?: "add" | "replace";
          token?: string;
        };

        // The room code alone is only 32 bits of entropy - the token from
        // the QR/short code is the actual proof the requester scanned it.
        // The truncated short-code prefix only counts once this device has
        // actually shown the short code (see revealShortCode).
        const tokenOk = tokenAccepted(token, _syncToken, _shortCodeRevealed);
        if (!tokenOk) {
          console.warn("[Sync][Source] Rejected ExportRequest: bad token");
          _transport?.send(
            peerId,
            encode({
              type: SyncMessageType.SyncError,
              payload: {
                error:
                  "Sync token mismatch - refresh/update the app on both devices and generate a new code",
              },
            })
          );
          return;
        }

        const requestMode = mode ?? "replace";
        console.log(
          `[Sync][Source] Received ExportRequest, mode: ${requestMode}, sending data...`
        );
        await sendExportData(peerId, requestMode);
      } else if (msg.type === SyncMessageType.ExportAck) {
        // Target acknowledged receipt (can be used for flow control)
        console.log("[Sync][Source] Received acknowledgment");
      } else if (msg.type === SyncMessageType.ImportProgress) {
        // The target is still writing. Each report restarts the ack clock,
        // so a long import on a slow phone no longer times out a sync that
        // is finishing, and the bar here follows the one over there.
        const { percent } = (msg.payload ?? {}) as { percent?: unknown };
        syncState.phase = "importing-remote";
        if (typeof percent === "number" && percent > syncState.syncProgress) {
          syncState.syncProgress = Math.min(99, Math.floor(percent));
        }
        if (_ackTimeoutTimer) armAckTimer();
      } else if (msg.type === SyncMessageType.ExportComplete) {
        if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
        _ackTimeoutTimer = null;
        syncState.isSyncing = false;
        syncState.isComplete = true;
        syncState.syncProgress = 100;
        await cleanup();
      } else if (msg.type === SyncMessageType.SyncError) {
        if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
        _ackTimeoutTimer = null;
        syncState.syncError = (msg.payload as { error: string }).error;
        await cleanup();
      }
    } catch (err) {
      console.error("[Sync][Source] Error handling message:", err);
    }
  });

  syncState.isConnecting = true;
  console.log("[Sync][Source] Connecting to room...");
  await _transport.connect();
  _transport.joinRoom(_syncRoomCode);
  console.log("[Sync][Source] Connected to room");
}

/**
 * Send exported database data to the target device in batches.
 */
async function sendExportData(
  peerId: string,
  mode: "add" | "replace" = "replace"
): Promise<void> {
  if (!_transport) return;

  console.log(`[Sync][Source] Exporting data in ${mode} mode`);

  try {
    // In "add" mode, we skip identity export since target keeps its own
    const exportData = await exportDatabase(mode === "add");

    // Echo the proof-of-scan token in every data frame so the target can
    // reject data from a peer that never proved it holds the shared secret.
    const token = _syncToken ?? undefined;

    // Send identity first. Checked like every other send: this is the one
    // frame whose loss leaves the target sitting at exactly 0%, and it was
    // also the only one whose result was thrown away.
    const identityOk = await _transport.send(
      peerId,
      encode({
        type: SyncMessageType.ExportData,
        payload: { section: "identity", data: exportData.identity, token },
      })
    );
    if (!identityOk) {
      throw new Error("Connection lost before sending identity - try again");
    }

    syncState.syncProgress = 10;

    // Send messages in batches with rate limiting
    const sections = EXPORT_SECTIONS.map((name) => ({
      name,
      data: exportData[name] as unknown[],
    }));

    let processed = 0;
    for (const section of sections) {
      // Batches close on bytes as well as count: 50 attachments per frame
      // put whole image blobs into one message and blew the receiver's 4MB
      // frame cap, which killed the stream - the sync that sat at 90% on one
      // device and 20% on the other. An item too big even alone travels
      // without its bytes; the record still syncs and the file layer
      // re-fetches the bytes from this device later.
      const batches: unknown[][] = [];
      let cur: unknown[] = [];
      let curBytes = 0;
      for (const item of section.data as unknown[]) {
        let entry = item;
        let sz = utf8Length(JSON.stringify(entry) ?? "");
        if (sz > MAX_BATCH_BYTES) {
          const { data: _dropped, ...rest } = entry as { data?: unknown };
          console.warn(
            `[Sync][Source] ${section.name} item exceeds the frame budget - sent without bytes`
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
      console.log(
        `[Sync][Source] Sending ${section.name}: ${section.data.length} items in ${batches.length} batches`
      );

      for (let i = 0; i < batches.length; i++) {
        // send() resolving false means the stream is gone; silently pouring
        // the rest of the export into it is how the source reached 90% with
        // a target that had stopped hearing anything at 20%. It resolves in
        // bounded time: the transport gives a frame a drain budget scaled to
        // its size, so a far end that stopped reading (a phone that went to
        // sleep mid transfer) fails the send instead of parking this loop.
        const ok = await _transport.send(
          peerId,
          encode({
            type: SyncMessageType.ExportData,
            payload: {
              section: section.name,
              batchIndex: i,
              totalBatches: batches.length,
              data: batches[i],
              token,
            },
          })
        );
        if (!ok) {
          throw new Error(
            `Connection lost while sending ${section.name} - try again`
          );
        }

        // Small delay between batches to prevent overwhelming the target
        if (i < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      processed++;
      syncState.syncProgress =
        10 + Math.floor((processed / sections.length) * 80);
      console.log(
        `[Sync][Source] Sent ${section.name}: ${Math.round(syncState.syncProgress)}%`
      );
    }

    console.log("[Sync][Source] Sending ExportComplete");
    // Send completion
    const okComplete = await _transport.send(
      peerId,
      encode({ type: SyncMessageType.ExportComplete })
    );
    if (!okComplete) {
      throw new Error("Connection lost before the export finished - try again");
    }

    // Everything is across; what remains is the other device writing it,
    // which its ImportProgress frames narrate from here on. Not 100% yet:
    // that waits for its acknowledgment, but not forever - a target that
    // died mid-import used to leave this side parked at 90% with no error.
    syncState.syncProgress = 90;
    syncState.phase = "importing-remote";
    armAckTimer();
    console.log("[Sync][Source] Waiting for target to finish importing...");
  } catch (err) {
    console.error("[Sync] Error sending export data:", err);
    // Into syncState, not only the console. Every throw in this function
    // landed here and stopped: no error was set, isSyncing stayed true, and
    // the dialog only leaves the progress view when syncError is truthy. So
    // the source froze at whatever percentage it had reached, with no timer
    // covering it - the ack timeout is armed only after a fully successful
    // send loop, and the stall watchdog is the target's. Every send check in
    // this function was reporting into a black hole.
    syncState.syncError = err instanceof Error ? err.message : String(err);
    syncState.isSyncing = false;
    void _transport
      ?.send(
        peerId,
        encode({
          type: SyncMessageType.SyncError,
          payload: { error: String(err) },
        })
      )
      .catch(() => false);
    await cleanup();
  }
}

/**
 * Connect to a sync room as the target device (receiving data).
 * Call this after scanning a QR code or entering plaintext.
 */
export async function connectAsTarget(
  payload: SyncPayload,
  importOptions: ImportOptions = {}
): Promise<void> {
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

  const mode = payload.mode ?? "replace";
  // Room code redacted for the same reason as on the source side.
  console.log(`[Sync][Target] Starting sync client, mode: ${mode}`);

  syncState.isConnecting = true;
  syncState.syncError = null;

  try {
    _syncRoomCode = payload.roomCode;
    _isSourceDevice = false;

    _transport = new LibP2PTransport({ diagBus: "sync" });

    let receivedIdentity: DatabaseExport["identity"] | null = null;
    const receivedData: Partial<DatabaseExport> = {};
    /**
     * Which batches of each section actually arrived.
     *
     * batchIndex and totalBatches were only ever feeding the progress bar,
     * so a batch that went missing - the sender's stream reset mid-transfer
     * is the realistic way - left the target concatenating whatever it had
     * and importing it as a success. Silently losing part of somebody's
     * history is worse than failing, so the counts are checked before the
     * import rather than trusted.
     */
    const seenBatches = new Map<string, Set<number>>();
    const expectedBatches = new Map<string, number>();

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
      const frame = encode({
        type: SyncMessageType.ExportRequest,
        payload: { mode, token: payload.token },
      });
      // ponytail: 3 tries, 2s apart; each send already spends the
      // transport's ~5.6s confirm budget before resolving false.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!_transport || !syncState.isSyncing || syncState.isComplete) return;
        if (await _transport.send(peerId, frame)) return;
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

    _transport.on("disconnect", () => {
      console.log("[Sync][Target] Disconnected from source");
      if (!syncState.isComplete) {
        syncState.syncError = "Connection lost";
      }
    });

    _transport.on("message", async (peerId: string, data: Uint8Array) => {
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
      try {
        const msg = decode(data) as SyncMessage;
        console.log("[Sync][Target] Message type:", msg.type);

        if (msg.type === SyncMessageType.ExportData) {
          armStallTimer();
          const {
            section,
            data: sectionData,
            batchIndex,
            totalBatches,
            token: echoedToken,
          } = msg.payload as {
            section: string;
            data: unknown;
            batchIndex?: number;
            totalBatches?: number;
            token?: string;
          };

          // The source must echo the proof-of-scan token. A peer that never
          // saw the QR/short code can't produce it, so its data is dropped.
          // Full token when this device scanned the QR, the 8-char prefix
          // only when the short code is what it was given (see tokenAccepted).
          if (!tokenAccepted(echoedToken, payload.token, !payload.peerId)) {
            console.warn("[Sync][Target] Dropping ExportData: token mismatch");
            return;
          }

          if (section === "identity") {
            // A merge keeps THIS device's identity. The source is supposed to
            // skip the section in add mode, but a source that sends it anyway
            // would otherwise take the account over, so drop it here too.
            if (mode === "add") {
              console.warn(
                "[Sync][Target] Ignoring identity section: merge keeps this device's identity"
              );
            } else {
              receivedIdentity = sectionData as DatabaseExport["identity"];
            }
            syncState.syncProgress = 10;
          } else {
            const key = section as keyof DatabaseExport;
            if (!receivedData[key]) {
              (receivedData as Record<string, unknown[]>)[key] = [];
            }
            const arr = (receivedData as Record<string, unknown[]>)[key];
            if (Array.isArray(sectionData)) {
              arr.push(...sectionData);
            }
            if (batchIndex !== undefined && totalBatches !== undefined) {
              expectedBatches.set(section, totalBatches);
              let seen = seenBatches.get(section);
              if (!seen) {
                seen = new Set();
                seenBatches.set(section, seen);
              }
              seen.add(batchIndex);
            }

            // Update progress
            const sections: readonly string[] = EXPORT_SECTIONS;
            const sectionIndex = sections.indexOf(section);
            if (
              sectionIndex >= 0 &&
              batchIndex !== undefined &&
              totalBatches !== undefined
            ) {
              const sectionProgress = (batchIndex + 1) / totalBatches;
              syncState.syncProgress =
                10 +
                Math.floor(
                  ((sectionIndex + sectionProgress) / sections.length) * 80
                );
            }
          }

          // Send acknowledgment
          _transport?.send(peerId, encode({ type: SyncMessageType.ExportAck }));
        } else if (msg.type === SyncMessageType.ExportComplete) {
          // Everything has arrived; the import that follows reads and writes
          // the whole database and sends no frames, so a watchdog left armed
          // through it would abort a sync that is actually finishing.
          clearStallTimer();
          // Refuse a partial import. A section that announced N batches and
          // delivered fewer means history is missing, and the user cannot
          // see that from a progress bar that reached 100%.
          const missing: string[] = [];
          for (const [section, total] of expectedBatches) {
            const seen = seenBatches.get(section)?.size ?? 0;
            if (seen < total) missing.push(`${section} (${seen}/${total})`);
          }
          if (missing.length > 0) {
            console.error("[Sync][Target] Incomplete transfer:", missing);
            syncState.isSyncing = false;
            syncState.syncError = `The transfer arrived incomplete (${missing.join(", ")}). Nothing was changed - generate a new code and try again.`;
            await cleanup();
            return;
          }
          console.log(
            "[Sync][Target] Received ExportComplete, importing data..."
          );
          // The transfer is done; the last ten percent is this device
          // writing what arrived. It used to sit at the transfer's final
          // number (80 when the pending section was empty, which it almost
          // always is) with "Syncing data" on it for as long as the import
          // took, which on a phone with a real history is minutes.
          syncState.phase = "importing";
          syncState.syncProgress = Math.max(syncState.syncProgress, 90);
          let lastReport = 0;
          const onProgress = (done: number, total: number): void => {
            const percent =
              total > 0 ? 90 + Math.floor((done / total) * 9) : 99;
            if (percent > syncState.syncProgress) {
              syncState.syncProgress = percent;
            }
            // The source restarts its ack clock on each of these, so a slow
            // import is narrated rather than timed out. Throttled: the
            // frames ride the same stream the import just emptied.
            const now = Date.now();
            if (now - lastReport < 2000) return;
            lastReport = now;
            void _transport
              ?.send(
                peerId,
                encode({
                  type: SyncMessageType.ImportProgress,
                  payload: { percent: syncState.syncProgress },
                })
              )
              .catch(() => false);
          };
          // Import all received data
          if (receivedIdentity || mode === "add") {
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
                  savedGifs: (receivedData.savedGifs || []) as SavedGif[],
                },
                mode,
                // Carries the password prompt: with an identity in the export
                // the at-rest key is armed before the first row is written,
                // so nothing lands in plaintext on a device that has never
                // unlocked (see importDatabase).
                { ...importOptions, onProgress }
              );
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
              // AWAIT it, then tear down. send() is async, and dropping the
              // promise before cleanup() disconnected the transport meant the
              // source often never saw the completion: it sat there until its
              // ack timeout and reported a failure for a sync that had in
              // fact finished.
              // AWAIT it, then tear down: dropping the promise before
              // cleanup() disconnected the transport meant the source often
              // never saw the completion. The transport bounds the wait, so a
              // source that already gave up cannot hold this side at 99.
              await _transport
                ?.send(peerId, encode({ type: SyncMessageType.ExportComplete }))
                .catch(() => false);

              syncState.isSyncing = false;
              syncState.isComplete = true;
              syncState.syncProgress = 100;
              clearStallTimer();
              await cleanup();
            } catch (err) {
              console.error("[Sync][Target] Import failed:", err);
              syncState.syncError =
                err instanceof Error ? err.message : "Import failed";
              await _transport
                ?.send(
                  peerId,
                  encode({
                    type: SyncMessageType.SyncError,
                    payload: { error: String(err) },
                  })
                )
                .catch(() => false);
            }
          } else {
            syncState.syncError = "No identity data received";
          }
        } else if (msg.type === SyncMessageType.SyncError) {
          syncState.syncError = (msg.payload as { error: string }).error;
          await cleanup();
        }
      } catch (err) {
        console.error("[Sync] Error handling message:", err);
        syncState.syncError = err instanceof Error ? err.message : String(err);
      }
    });

    await _transport.connect();
    _transport.joinRoom(payload.roomCode);

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
    db.getAll("watermarks"),
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
    // Saved uploaded gifs carry bytes, and JSON.stringify(ArrayBuffer) is {} -
    // without this they silently arrived empty on the other device.
    savedGifs: (savedGifs as SavedGif[]).map((g) => ({
      ...g,
      data: g.data
        ? (bytesToBase64(new Uint8Array(g.data)) as unknown as ArrayBuffer)
        : undefined,
    })),
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
    version: BACKUP_VERSION,
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

/** A camera the QR scanner can run on. */
export interface ScanCamera {
  id: string;
  label: string;
}

/**
 * Camera state for the QR scanner.
 *
 * Its own store rather than more fields on syncState: this is about the
 * hardware in front of the user, it means nothing outside the scan view, and
 * it changes several times while a camera is starting.
 */
export const scannerState = $state({
  /**
   * The camera has been asked for and the user has not answered yet.
   *
   * Distinct from scanning and distinct from an error. On a phone the prompt
   * sits there for as long as it takes somebody to read it, and for that whole
   * time the view was a black square saying nothing at all - which reads as a
   * broken scanner, not as a question waiting for an answer.
   */
  awaitingPermission: false,
  /** Every camera on the device, once permission has been granted. */
  cameras: [] as ScanCamera[],
  activeCameraId: null as string | null,
  /** The running camera has a torch, and it can be switched. */
  torchAvailable: false,
  torchOn: false,
});

const BACK_CAMERA = /\b(back|rear|environment)\b/i;

/**
 * The camera to open first.
 *
 * `{ facingMode: "environment" }` was a constraint, not a choice, and a
 * browser that cannot honour it gets to pick - which on several Androids is
 * the front camera, pointed at the face of somebody holding their other phone
 * up to the back of the device. Naming a device id makes the choice explicit,
 * and it gives the UI something to offer a switch between.
 */
function preferBackCamera(cameras: ScanCamera[]): string | null {
  if (cameras.length === 0) return null;
  const back = cameras.find((c) => BACK_CAMERA.test(c.label));
  // Nothing labelled: the last entry is the back camera on most Androids, and
  // on a single-camera device it is the only one there is.
  return (back ?? cameras[cameras.length - 1]).id;
}

/** Read the running camera's torch support; never throws. */
function readTorchSupport(): void {
  if (!_html5QrCode) return;
  try {
    // The same MediaTrackCapabilities.torch the platform reports, read
    // through the wrapper that also knows how to apply it.
    const torch = _html5QrCode
      .getRunningTrackCameraCapabilities()
      .torchFeature();
    scannerState.torchAvailable = torch.isSupported();
    scannerState.torchOn = torch.value() === true;
  } catch {
    // No running camera, or a browser that reports no capabilities.
    scannerState.torchAvailable = false;
    scannerState.torchOn = false;
  }
}

export async function startScanning(
  elementId: string,
  onScan: (payload: SyncPayload) => void,
  onError: (error: string) => void,
  /** Skip the automatic choice - see switchScanCamera. */
  cameraId?: string
): Promise<void> {
  syncState.isScanning = true;
  syncState.scanError = null;
  scannerState.torchAvailable = false;
  scannerState.torchOn = false;

  try {
    // getCameras() is what raises the permission prompt, and it does not
    // resolve until the user has answered it - so this, and only this, is the
    // window in which the view should say it is waiting for them.
    if (scannerState.cameras.length === 0) {
      scannerState.awaitingPermission = true;
      try {
        scannerState.cameras = (await Html5Qrcode.getCameras()).map((c) => ({
          id: c.id,
          label: c.label,
        }));
      } finally {
        scannerState.awaitingPermission = false;
      }
    }
    const target = cameraId ?? preferBackCamera(scannerState.cameras);
    scannerState.activeCameraId = target;

    _html5QrCode = new Html5Qrcode(elementId);

    await _html5QrCode.start(
      // A device id when the enumeration gave one; the old facingMode
      // constraint stays as the fallback for a browser that listed nothing.
      target ?? { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      },
      (decodedText) => {
        try {
          const payload = JSON.parse(decodedText) as SyncPayload;
          // peerId is required: without it the target has nothing to pin
          // the source connection to, and would trust whichever peer joins
          // the ephemeral sync room first (see connectAsTarget).
          if (
            payload.roomCode &&
            payload.token &&
            payload.expires &&
            payload.peerId
          ) {
            stopScanning();
            onScan(payload);
          } else if (payload.roomCode && payload.token && payload.expires) {
            onError(
              "This QR code is from an older version of the app - update both devices and generate a new code"
            );
          } else {
            onError("Invalid QR code format");
          }
        } catch {
          onError("Invalid QR code");
        }
      },
      () => {
        // Scan error - usually just means no QR code in frame, ignore
      }
    );
    readTorchSupport();
  } catch (err) {
    syncState.scanError = err instanceof Error ? err.message : String(err);
    onError(syncState.scanError);
  }
}

/**
 * Move the scan to another camera without leaving the scan view.
 *
 * The camera list survives stopScanning, so this never re-prompts.
 */
export async function switchScanCamera(
  cameraId: string,
  elementId: string,
  onScan: (payload: SyncPayload) => void,
  onError: (error: string) => void
): Promise<void> {
  await stopScanning();
  await startScanning(elementId, onScan, onError, cameraId);
}

/** The next camera in the list, or null when there is only the one. */
export function nextScanCameraId(): string | null {
  const { cameras, activeCameraId } = scannerState;
  if (cameras.length < 2) return null;
  const at = cameras.findIndex((c) => c.id === activeCameraId);
  return cameras[(at + 1) % cameras.length].id;
}

/** Switch the running camera's torch. Silently does nothing without one. */
export async function toggleScanTorch(): Promise<void> {
  if (!_html5QrCode || !scannerState.torchAvailable) return;
  const next = !scannerState.torchOn;
  try {
    await _html5QrCode
      .getRunningTrackCameraCapabilities()
      .torchFeature()
      .apply(next);
    scannerState.torchOn = next;
  } catch {
    // Some devices advertise a torch and then refuse to switch it while the
    // camera is running. Drop the control rather than leave a button that
    // does nothing.
    scannerState.torchAvailable = false;
  }
}

/**
 * Stop camera scanning.
 */
export async function stopScanning(): Promise<void> {
  if (_html5QrCode) {
    // Off before the stop: some Androids leave the torch burning after the
    // camera is released, and nothing in the app can reach it again.
    if (scannerState.torchOn) {
      try {
        await _html5QrCode
          .getRunningTrackCameraCapabilities()
          .torchFeature()
          .apply(false);
      } catch {
        // Nothing more to try; the stop below releases the device anyway.
      }
    }
    try {
      await _html5QrCode.stop();
    } catch {
      // Ignore stop errors
    }
    _html5QrCode = null;
  }
  syncState.isScanning = false;
  scannerState.awaitingPermission = false;
  scannerState.torchAvailable = false;
  scannerState.torchOn = false;
  // cameras and activeCameraId deliberately survive: switchScanCamera stops
  // and restarts, and re-enumerating would re-prompt on some browsers.
}

/**
 * Reset sync state.
 */
export function resetSyncState(): void {
  syncState.isGenerating = false;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.isScanning = false;
  syncState.scanError = null;
  syncState.isConnecting = false;
  syncState.isSyncing = false;
  syncState.syncProgress = 0;
  syncState.phase = "transfer";
  syncState.syncError = null;
  syncState.isComplete = false;
}

/**
 * Clean up resources.
 */
async function cleanup(): Promise<void> {
  if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
  _ackTimeoutTimer = null;
  if (_peerWaitTimer) clearTimeout(_peerWaitTimer);
  _peerWaitTimer = null;
  clearStallTimer();
  if (_transport) {
    // AWAIT it. disconnect() stops the libp2p node asynchronously, and
    // dropping the promise let the next attempt start a second node while
    // the first was still tearing its relay socket down - two nodes racing
    // the same dial is exactly what made a retry fail more often than the
    // first try.
    const dying = _transport;
    _transport = null;
    try {
      await dying.disconnect();
    } catch {
      // A node that fails to stop cleanly is already unusable; the reference
      // is dropped either way.
    }
  }
  await stopScanning();
  if (_syncExpiryTimer) {
    clearTimeout(_syncExpiryTimer);
    _syncExpiryTimer = null;
  }
  _syncRoomCode = null;
  _syncToken = null;
  _shortCodeRevealed = false;
  _isSourceDevice = false;
  _targetSourcePeerId = null;
  _exportRequested = false;
}

/**
 * Cancel/abort current sync operation.
 */
export async function cancelSync(): Promise<void> {
  await cleanup();
  resetSyncState();
}
