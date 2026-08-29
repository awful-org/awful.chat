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
  parseBackup,
  mergeImportedRoom,
  pfpFromJson,
  pfpToJson,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
} from "./backup";

export { summarizeBackup } from "./backup";
// The apply/import half lives in a transport-free module so it can be tested;
// re-exported here because the UI has always imported it from this path.
export {
  applyBackup,
  readBackupFile,
  importDatabase,
} from "./backup-restore";
import { importDatabase } from "./backup-restore";
export type { BackupFile, BackupSummary } from "./backup";

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
  syncError: null,
  isComplete: false,
});

let _transport: PeerTransport | null = null;
let _html5QrCode: Html5Qrcode | null = null;
let _syncRoomCode: string | null = null;
let _syncToken: string | null = null;
let _syncExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let _isSourceDevice = false;
// Target-side: the one source peer we're syncing with, set only once
// matchesSourcePeer() confirms the connecting peerId is the one the
// QR/short code names. Once set, data from any other peer that joined the
// (ephemeral) sync room is ignored - otherwise the FIRST peer to join
// (trivially arranged by the relay operator) could impersonate the source.
let _targetSourcePeerId: string | null = null;

/** Reduce a full or short-code token to its comparable 8-char prefix. */
function tokenPrefix(t: string | undefined | null): string {
  return (t ?? "").slice(0, 8);
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
/** How long the source waits for the target's import ack before erroring. */
const ACK_TIMEOUT_MS = 120_000;
let _ackTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** Target-side: guards against a second ExportRequest on a re-connect. */
let _exportRequested = false;
/** Target-side: the source has to actually show up in the sync room. */
let _peerWaitTimer: ReturnType<typeof setTimeout> | null = null;
// Rendezvous registration, the relay's PEERS reply, the dial and the WebRTC
// upgrade all happen inside this window. Generous, because the alternative
// (what shipped) was an spinner that never resolved.
const PEER_WAIT_TIMEOUT = 45_000;

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

  console.log("[Sync][Source] Starting sync server for room:", _syncRoomCode);

  _transport = new LibP2PTransport();

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
        // Short codes truncate the token to its first 8 chars, so accept
        // either the full token or that prefix.
        const tokenOk =
          !!_syncToken &&
          !!token &&
          (token === _syncToken || token === _syncToken.slice(0, 8));
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

    // Send identity first
    _transport.send(
      peerId,
      encode({
        type: SyncMessageType.ExportData,
        payload: { section: "identity", data: exportData.identity, token },
      })
    );

    syncState.syncProgress = 10;

    // Send messages in batches with rate limiting
    const sections = [
      { name: "messages" as const, data: exportData.messages },
      { name: "attachments" as const, data: exportData.attachments },
      { name: "rooms" as const, data: exportData.rooms },
      { name: "profiles" as const, data: exportData.profiles },
      { name: "watermarks" as const, data: exportData.watermarks },
      { name: "yjsDocs" as const, data: exportData.yjsDocs },
      { name: "savedGifs" as const, data: exportData.savedGifs },
      { name: "pending" as const, data: exportData.pending },
    ];

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
        let sz = JSON.stringify(entry)?.length ?? 0;
        if (sz > MAX_BATCH_BYTES) {
          const { data: _dropped, ...rest } = entry as { data?: unknown };
          console.warn(
            `[Sync][Source] ${section.name} item exceeds the frame budget - sent without bytes`
          );
          entry = rest;
          sz = JSON.stringify(entry)?.length ?? 0;
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
        // a target that had stopped hearing anything at 20%.
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

    // Don't set to 100% here - wait for target's acknowledgment, but not
    // forever: a target that died mid-import used to leave this side parked
    // at 90% with no error.
    if (_ackTimeoutTimer) clearTimeout(_ackTimeoutTimer);
    _ackTimeoutTimer = setTimeout(() => {
      syncState.syncError =
        "The other device never confirmed the import - try again";
      syncState.isSyncing = false;
    }, ACK_TIMEOUT_MS);
    console.log("[Sync][Source] Waiting for target to finish importing...");
  } catch (err) {
    console.error("[Sync] Error sending export data:", err);
    _transport.send(
      peerId,
      encode({
        type: SyncMessageType.SyncError,
        payload: { error: String(err) },
      })
    );
  }
}

/**
 * Connect to a sync room as the target device (receiving data).
 * Call this after scanning a QR code or entering plaintext.
 */
export async function connectAsTarget(payload: SyncPayload): Promise<void> {
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
  console.log(
    `[Sync][Target] Starting sync client for room: ${payload.roomCode}, mode: ${mode}`
  );

  syncState.isConnecting = true;
  syncState.syncError = null;

  try {
    _syncRoomCode = payload.roomCode;
    _isSourceDevice = false;

    _transport = new LibP2PTransport();

    let receivedIdentity: DatabaseExport["identity"] | null = null;
    const receivedData: Partial<DatabaseExport> = {};

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

      // Request data from source with mode + proof-of-scan token
      _transport?.send(
        peerId,
        encode({
          type: SyncMessageType.ExportRequest,
          payload: { mode, token: payload.token },
        })
      );
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
          if (tokenPrefix(echoedToken) !== tokenPrefix(payload.token)) {
            console.warn("[Sync][Target] Dropping ExportData: token mismatch");
            return;
          }

          if (section === "identity") {
            receivedIdentity = sectionData as DatabaseExport["identity"];
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

            // Update progress
            const sections = [
              "messages",
              "attachments",
              "rooms",
              "profiles",
              "watermarks",
              "yjsDocs",
              "savedGifs",
              "pending",
            ];
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
          console.log(
            "[Sync][Target] Received ExportComplete, importing data..."
          );
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
                mode
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
              await _transport
                ?.send(peerId, encode({ type: SyncMessageType.ExportComplete }))
                .catch(() => false);

              syncState.isSyncing = false;
              syncState.isComplete = true;
              syncState.syncProgress = 100;
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
 * Includes the identity record, which is the AES-GCM encrypted mnemonic - the
 * file is only as safe as the password that encrypts it, so the UI warns.
 */
export async function downloadBackup(): Promise<void> {
  const data = await exportDatabase(false);
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    ...data,
  };
  const blob = new Blob([JSON.stringify(backup)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  // A dedicated extension so the OS can hand backups straight to the app
  // (manifest file_handlers); the content is still plain JSON and the
  // restore picker keeps accepting old .json exports.
  a.download = `awful-backup-${stamp}.awfulbackup`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function startScanning(
  elementId: string,
  onScan: (payload: SyncPayload) => void,
  onError: (error: string) => void
): Promise<void> {
  syncState.isScanning = true;
  syncState.scanError = null;

  try {
    _html5QrCode = new Html5Qrcode(elementId);

    await _html5QrCode.start(
      { facingMode: "environment" },
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
  } catch (err) {
    syncState.scanError = err instanceof Error ? err.message : String(err);
    onError(syncState.scanError);
  }
}

/**
 * Stop camera scanning.
 */
export async function stopScanning(): Promise<void> {
  if (_html5QrCode) {
    try {
      await _html5QrCode.stop();
    } catch {
      // Ignore stop errors
    }
    _html5QrCode = null;
  }
  syncState.isScanning = false;
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
