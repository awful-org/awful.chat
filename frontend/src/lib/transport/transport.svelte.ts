import { MediasoupVideo } from "./mediasoup";
import {
  cachePluginSenderName,
  immediatePluginSenderName,
} from "./plugin-sender-name";
import { measureMedia } from "$lib/image-size";
import { identityStore } from "../identity/identity.svelte";
import { getQuotableText } from "../quote-helper";
import {
  _noteRefused,
  _withRefused,
  REFUSED_MAX_SENDERS,
} from "./refused-lamports";
import { allowSyncReaction } from "./sync-throttle";
import { setErrorWithAutoClear } from "./call-error";
import { blindValue } from "../storage-crypto";
import {
  getOwnProfile,
  putMessage,
  bulkPutMessages,
  messageClearFieldsByIds,
  getMessages,
  getAllMessages,
  getMessagesAboveWatermarks,
  getMessagesOfTypes,
  getSenderMaxLamports,
  getWatermarksForRoom,
  setWatermark,
  markRoomSeen,
  markOwnMessagesReadUpTo,
  PAGE_SIZE,
  nextDmLamport,
  getPeerProfile,
  putPeerProfile,
  getAllPeerProfiles,
  putAttachment,
  getAttachmentsByInfoHash,
  getAttachmentsByMessage,
  updateMessageStatus,
  getMessage,
  getAllRooms,
  getRoomParticipants,
  addRoomParticipant,
  removeRoomParticipant,
  updateParticipantLastSeen,
  cleanupInactiveParticipants,
} from "../storage";
import { normalizeWireName } from "../wire-name";
import {
  MessageType,
  boundReactionEmoji,
  boundReplyTo,
  wireToMessage,
  messageToWire,
  type Message,
  type ChatMessageType,
  type AnyWireMessage,
  type WireChatMessage,
  type WirePluginEphemeral,
  type WireProfile,
  type WireRoomName,
  type WireRoomUsersSync,
  type WireCallState,
  type FileEntry,
  type FileMeta,
  type Attachment,
} from "../types/message";
import {
  refreshUnreadCount,
  removeRoom,
  refreshDmRooms,
  renameRoom,
  noteRoomActivity,
  roomsStore,
} from "../rooms.svelte";
import { WebTorrentFileTransport } from "./file/webtorrent";
import type { FileDescriptor, FileTransferSnapshot } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
import { refreshTurnCredentials } from "./ice-server-list";
import { LibP2PVoice } from "./libp2p/voice";
import { verifyIncoming } from "./verify-incoming";
import { DtlnProcessor } from "../audio/dtln-processor";
import { WORKLET_URL } from "../audio/worklet-url";
import { requireSession } from "../identity/identity";
import { deviceKeySeed } from "./device-key";
import { looksLikeDid, looksLikePeerId } from "../identity/identity-utils";
import {
  canonicalContentV3,
  canonicalFor,
  signMessage,
  signPeerBinding,
  verifyPeerBinding,
  verifySignature,
} from "../messaging";
import {
  bytesToBase64,
  sniffImageMime,
  encode,
  decode,
  normalizeAvatarUrl,
  normalizeNicknameColor,
} from "../utils";
import { validateProfileMeta } from "../profile-meta";
import {
  validatePluginId,
  validateCardPayload,
  validateUpdatePayload,
  validateEphemeralPayload,
} from "../plugins/validate";
import {
  cardStates,
  clearCardStates,
  evictCardState,
  foldUpdate,
  touchCardStates,
} from "../plugins/state.svelte";
import { clearLocalCards } from "../plugins/local-cards.svelte";
import { clearPluginConfirms } from "../plugins/confirm.svelte";
import { clearSearchCorpus } from "../search/corpus.svelte";
import { announceMessage } from "../announce";
import { mentionsMe } from "../mentions";
import { appendToDmPanel, dmPanelIsShowing } from "../dm-panel.svelte";
import { profileStore } from "../profile.svelte";
import { getPlugin } from "../plugins/registry";
import { _sendCallPresence, _sendCallState, leaveCall } from "./call.svelte";
import { _sendWatchPresence } from "./transmission.svelte";
import {
  type DmPayload,
  encodeDmAckEnvelope,
  encodeDmReadEnvelope,
  parseDmEnvelope,
} from "./dm-codec";
import {
  depositDmReceipt,
  dmConversationCodeAsync,
  dmPeerDid,
  dmPeerDidForRoom,
  ensureDmRoomForPeer,
  flushQueuedDmForConnectedPeers,
  flushQueuedDmForPeer,
  joinPhonebookDmRooms,
  noteMailboxDeposit,
  queueDmMessage,
  resolveDmDisplayName,
  sendDirectMessage,
} from "./dm.svelte";
import {
  _announceStoredFilesTo,
  _hydrateAndSeedAttachments,
  INLINE_FILE_MAX_BYTES,
  stripAndAdoptInlineFiles,
  fileFingerprint,
  initFiles,
  isFileSignalWireMessage,
  maybePeerIdFromSenderId,
  shouldAutoDownload,
  withFileTransfer,
} from "./files.svelte";
import { appendSorted, compareMessages as MSG_ORDER } from "./message-order";
import { ProfileEcho, frameHash } from "./profile-echo";
import { initVoice } from "./voice.svelte";
import { installTelemetryTaps, stopTelemetryTaps } from "../telemetry/taps";
import { ev } from "../telemetry/event";
import { noteIdentity, rec, recorderSnapshot, refs } from "../telemetry/recorder";
import { apiUrl, isConfigured, relayMultiaddr, sfuUrls } from "../runtime-config";
import { faultStats, faultsActive } from "./faults";
import { initTransmission } from "./transmission.svelte";


/**
 * Check if a plugin message can pass without exceeding its flood cap.
 * Returns true if under limit, false if rate-limited (drop excess).
 *
 * `kind` keeps ephemerals and persisted updates in separate windows: they
 * share this mechanism and its sweep, not their budgets - an ephemeral is a
 * cursor tick, a persisted update is a human pressing a button.
 */
function _checkFloodCap(
  kind: "e" | "u",
  pluginId: string,
  senderId: string,
  limit: number,
  window: number
): boolean {
  const key = `${kind}|${pluginId}|${senderId}`;
  const now = Date.now();
  const entry = _ephemeralFloodTrack.get(key);

  // Expired windows were never removed, only overwritten if the same key came
  // back. A peer varying the key (the receive side keys on a wire-supplied
  // pluginId) therefore grew this map without bound for the life of the tab -
  // and every varied key took the "first message" branch, so the cap itself
  // constrained nothing. Callers now validate the pluginId; sweep anyway, so
  // an idle map does not keep a window per peer per plugin forever.
  // Throttled to once per window. Unthrottled, this walked the whole map on
  // EVERY ephemeral once it passed the threshold - and when the entries are
  // all still live it deletes nothing, so a busy room paid an O(size) scan
  // per frame to free zero bytes. Ephemerals are the highest-rate message
  // type there is (cursors, ticks), which is exactly the wrong place for
  // that.
  if (
    _ephemeralFloodTrack.size > EPHEMERAL_FLOOD_MAX_KEYS &&
    now >= _ephemeralSweepAt
  ) {
    _ephemeralSweepAt = now + EPHEMERAL_FLOOD_WINDOW;
    for (const [k, v] of _ephemeralFloodTrack) {
      if (now >= v.resetAt) _ephemeralFloodTrack.delete(k);
    }
  }

  if (!entry || now >= entry.resetAt) {
    // Window expired or first message, start new window
    _ephemeralFloodTrack.set(key, {
      count: 1,
      resetAt: now + window,
    });
    return true;
  }

  if (entry.count < limit) {
    entry.count += 1;
    return true;
  }

  // Exceeded limit, drop this message
  return false;
}

function _checkEphemeralFloodCap(pluginId: string, senderId: string): boolean {
  return _checkFloodCap(
    "e",
    pluginId,
    senderId,
    EPHEMERAL_FLOOD_LIMIT,
    EPHEMERAL_FLOOD_WINDOW
  );
}

/**
 * The same cap for PERSISTED plugin updates, which had none: only ephemerals
 * were ever rate-limited, so a peer could push PluginUpdate rows at line rate
 * and each one is a signature verify, an IDB write, a watermark write and a
 * reducer fold. Looser than the ephemeral window because these are human
 * actions - a vote, a spin, a card move - not per-frame ticks.
 */
function _checkUpdateFloodCap(pluginId: string, senderId: string): boolean {
  return _checkFloodCap(
    "u",
    pluginId,
    senderId,
    UPDATE_FLOOD_LIMIT,
    UPDATE_FLOOD_WINDOW
  );
}

/**
 * The plugin payload caps (validate.ts) were enforced ONLY where we send, so
 * every one of them was advisory: a peer's card, update or ephemeral arrived
 * with an arbitrary pluginId and a payload of any size and was folded and
 * persisted unread. A signature proves authorship, not sanity - the author is
 * exactly who wants to send us a 10 MB "update" nobody will ever display.
 * Same validators, same limits, on the way in.
 *
 * Returns the parsed payload, or null when the message must be dropped.
 */
function _parsePluginPayload(
  type: ChatMessageType | MessageType.PluginEphemeral,
  content: unknown
): { pluginId: string; cardId?: string; data?: unknown } | null {
  if (typeof content !== "string") return null;
  let payload: { pluginId?: unknown; cardId?: unknown; data?: unknown };
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!validatePluginId(payload.pluginId).ok) return null;
  // A card IS its message, so its id lives on the message; updates and
  // ephemerals name the card they act on and must do so with a string.
  if (type !== MessageType.PluginCard) {
    if (typeof payload.cardId !== "string" || !payload.cardId) return null;
  }
  const check =
    type === MessageType.PluginCard
      ? validateCardPayload
      : type === MessageType.PluginUpdate
        ? validateUpdatePayload
        : validateEphemeralPayload;
  // These validators do `json = JSON.stringify(data)` inside a try and then
  // read `json.length` outside it - but JSON.stringify RETURNS undefined for
  // undefined (it does not throw), so that read raises a TypeError which
  // escapes the validator entirely. This function runs inside _handleSyncBatch's
  // per-row loop, where one throw aborts the ENTIRE batch, and any peer
  // triggers it with a payload as small as '{"pluginId":"poll"}'. Keep the
  // parse total: an absent payload is zero bytes and cannot breach a size cap,
  // and any other way a validator can throw means the row is malformed anyway.
  if (payload.data !== undefined) {
    let ok = false;
    try {
      ok = check(payload.data).ok;
    } catch {
      ok = false;
    }
    if (!ok) return null;
  }
  return {
    pluginId: payload.pluginId as string,
    cardId: payload.cardId as string | undefined,
    data: payload.data,
  };
}

import { playPeerJoinSound, playPeerLeaveSound } from "../sounds";
import { peerCallChime } from "./call-chime";

export { appendSorted } from "./message-order";
export type { Message };

// ── State shapes ──────────────────────────────────────────────────────────────

interface SendMessageOptions {
  replyTo?: Message["replyTo"];
  type?: ChatMessageType;
  meta?: FileMeta;
  attachments?: string[];
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

export interface ParticipantState {
  peerId: string;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  /** getStats saw 2 consecutive stalled samples on this consumer; see VideoEvents.trackStalled. */
  videoStalled: boolean;
  screenStalled: boolean;
}

interface TransportState {
  relayConnected: boolean;
  connected: boolean;
  connecting: boolean;
  /**
   * A call join is in flight. Distinct from `connecting`, which is the RELAY
   * connection: the join buttons were disabled on that flag, which joinCall
   * never sets, so they stayed live and unlabelled for the whole join.
   */
  joiningCall: boolean;
  /**
   * A camera or screen-share request is in flight. Both go through
   * getUserMedia/getDisplayMedia, which can sit for seconds behind a
   * permission prompt, and their buttons had no pending state at all - so a
   * second press during that window interleaved a start and a stop.
   */
  cameraPending: boolean;
  screenSharePending: boolean;
  roomCode: string | null;
  /**
   * The conversation the USER is looking at, set by the view layer. Not the
   * same as roomCode, which is what the transport has open: on the landing
   * screen roomCode keeps its value while nothing is on screen - suppressing
   * message sounds by roomCode muted messages the user could not see.
   */
  uiRoomCode: string | null;
  roomName: string;
  peers: string[];
  roomUsers: string[];
  messages: Message[];
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
  participants: Map<string, ParticipantState>;
  localCameraStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  localMicStream: MediaStream | null;
  cameraOff: boolean;
  screenSharing: boolean;
  peerNames: Map<string, string>;
  /** Bumped on every peer->DID mapping change; see peerIdToDid(). */
  peerDidVersion: number;
  peerAvatars: Map<string, string>;
  /** User-picked nickname colors, keyed like peerNames (by DID). */
  peerColors: Map<string, string>;
  /**
   * Did the room's first read fill a page?
   *
   * False means the whole room is already loaded and there is nothing to
   * page back to. Counting the loaded messages cannot answer this: the cap
   * is applied before decryption and undecryptable rows are then dropped,
   * so a full page can arrive short.
   */
  historyCapped: boolean;
  /**
   * Peers currently reached through a relay circuit rather than directly.
   *
   * A reactive mirror of the transport's own set. The badge reads this, not
   * the transport, because only a $state read re-renders when a connection
   * upgrades.
   */
  relayedPeers: Set<string>;
  /**
   * Peers whose outbound stream has proof the far side is reading it - a
   * reactive mirror of the transport's confirmedStreams. `peers` alone
   * cannot tell a working link from a connected-but-deaf one; this is the
   * only place that distinction reaches the UI.
   */
  provenPeers: Set<string>;
  /** Profile metadata: banners, tags, bios, name effects; keyed by DID. */
  peerProfileMeta: Map<
    string,
    {
      bannerUrl?: string;
      tagText?: string;
      tagTextColor?: string;
      tagChipColor?: string;
      bio?: string;
      nameEffect?: string;
      nameShimmer?: boolean;
      nameGlow?: boolean;
      gradient2?: string;
      gradient3?: string;
    }
  >;
  error: string | null;
  callPeerIds: Set<string>;
  callPeerRooms: Map<string, string>; // peerId -> roomCode they're calling in
  transmissionViewers: Map<string, Set<string>>; // sharer peerId -> viewer peerIds
  pendingTransmissions: Map<string, string>;
  watchingTransmissionPeerId: string | null;
  watchingTransmissionProducerId: string | null;
  transmissionOutputVolume: number;
  fileTransfers: Map<string, FileTransferSnapshot>;
  callPeerStates: Map<string, { muted: boolean; deafened: boolean }>;
  chatMode: "room" | "dm";
  activeDmPeerId: string | null;
  dmVersion: number;
  callRoomCode: string | null;
  /**
   * getUserMedia failed, so this call is listen-only. Fed by voice.ts's
   * mic-unavailable/mic-available statuses; withdrawn as soon as a later mic
   * start succeeds, so it is safe to render as a persistent badge.
   */
  micUnavailable: boolean;
  /**
   * Ids of queued DMs too large for the offline mailbox: they will only ever
   * be delivered peer to peer, so the recipient has to be online at the same
   * time. `Message["status"]` is a closed union owned by types/message.ts, so
   * the fact lives here rather than as a "queued-p2p" status.
   */
  dmQueuedP2POnly: Set<string>;
}

export const transportState = $state<TransportState>({
  relayConnected: false,
  connected: false,
  connecting: false,
  joiningCall: false,
  cameraPending: false,
  screenSharePending: false,
  roomCode: null,
  uiRoomCode: null,
  roomName: "",
  peers: [],
  roomUsers: [],
  messages: [],
  inCall: false,
  muted: false,
  deafened: false,
  participants: new Map(),
  localCameraStream: null,
  localScreenStream: null,
  localMicStream: null,
  cameraOff: true,
  screenSharing: false,
  peerNames: new Map(),
  peerDidVersion: 0,
  peerAvatars: new Map(),
  peerColors: new Map(),
  historyCapped: false,
  relayedPeers: new Set(),
  provenPeers: new Set(),
  peerProfileMeta: new Map(),
  error: null,
  callPeerIds: new Set(),
  callPeerRooms: new Map(),
  transmissionViewers: new Map(),
  pendingTransmissions: new Map(),
  watchingTransmissionPeerId: null,
  watchingTransmissionProducerId: null,
  transmissionOutputVolume: 1,
  fileTransfers: new Map(),
  callPeerStates: new Map(),
  chatMode: "room",
  activeDmPeerId: null,
  dmVersion: 0,
  callRoomCode: null,
  micUnavailable: false,
  dmQueuedP2POnly: new Set(),
});

/**
 * Lamport clock PER ROOM.
 *
 * It used to be a single counter shared by every non-DM room and absorbed from
 * all of them, so somebody active in a busy room carried a large counter into a
 * quiet one: their next message there outranked messages that were genuinely
 * older, and two people posting at the same moment could be ordered by which
 * of them had been busier elsewhere rather than by what happened first.
 * Ordering is a per-room question, so the clock is per room.
 *
 * Seeded from stored history in _loadHistory, so a room continues above its own
 * past rather than restarting under it.
 */
const _lamports = new Map<string, number>();
let _connectPromise: Promise<void> | null = null;

// Ephemeral message flood cap: ~4 per second per plugin per sender.
// Key: "{pluginId}|{senderId}", value: { count, resetAt }
const _ephemeralFloodTrack = new Map<
  string,
  { count: number; resetAt: number }
>();
/** Next time the flood map is worth walking; see _checkEphemeralFloodCap. */
let _ephemeralSweepAt = 0;
const EPHEMERAL_FLOOD_LIMIT = 4;
const EPHEMERAL_FLOOD_WINDOW = 1000; // milliseconds
// Persisted updates: 20 per 10s per plugin per sender. A human clicking as
// fast as they can stays well inside it; a flooder does not.
const UPDATE_FLOOD_LIMIT = 20;
const UPDATE_FLOOD_WINDOW = 10_000; // milliseconds
// Above this many live windows, sweep the expired ones on the next check.
const EPHEMERAL_FLOOD_MAX_KEYS = 256;

const BATCH_SIZE = 20;
export const MAX_PERSISTED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const _peerIdToDid = new Map<string, string>();
const _peerDisconnectListeners = new Set<(peer: { did: string }) => void>();
const _beforeDisconnectListeners = new Set<() => void>();

/** Subscribe to confirmed transport departures. */
export function onPeerDisconnect(
  listener: (peer: { did: string }) => void
): () => void {
  _peerDisconnectListeners.add(listener);
  return () => _peerDisconnectListeners.delete(listener);
}

/** Run synchronous last-chance work before this browser tears down transport. */
export function onBeforeDisconnect(listener: () => void): () => void {
  _beforeDisconnectListeners.add(listener);
  return () => _beforeDisconnectListeners.delete(listener);
}

/** Dev-only counters. Presence bugs are invisible without them: everything
 *  looks connected while a profile is quietly rejected. */
const _stats = {
  profilesOut: 0,
  /** Duplicate profiles a connection burst asked for and did not need. */
  profilesSkipped: 0,
  profilesIn: 0,
  profilesRejected: 0,
  digestsOut: 0,
  digestsIn: 0,
};

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle: presence and profile bugs are only reproducible with two
  // real peers, and there is no other way to see this state from a test.
  (window as unknown as Record<string, unknown>).__awful = {
    state: transportState,
    peerIdToDid: _peerIdToDid,
    stats: _stats,
    transportStats: () => _transport.debugStats,
    voice: () => _voice.debugVoice(),
    video: () => ({ connected: _video.isConnected() }),
    relayed: () => _transport.peers().filter((p) => _transport.isRelayed(p)),
    selfId: () => _transport.selfId(),
    node: () => _transport.p2pNode,
    sendReply,
    toggleReaction,
    sendFiles,
    sendMessage,
    _handleCallPresence,
    diag: () => recorderSnapshot(),
  };
}

/**
 * DM frames that arrived before the sender's DID was known, replayed once the
 * binding lands. Bounded: an unbound peer must not be able to make us buffer
 * without limit.
 */
type PendingDm = { payload: DmPayload };
const _pendingDmByPeer = new Map<string, PendingDm[]>();
const MAX_PENDING_DM_PER_PEER = 32;

function _replayPendingDm(peerId: string, senderDid: string): void {
  const pending = _pendingDmByPeer.get(peerId);
  if (!pending?.length) return;
  _pendingDmByPeer.delete(peerId);
  for (const envelope of pending) _handleDmChat(peerId, senderDid, envelope);
}

/**
 * Display name for a mentioned did, self included. peerNames only holds
 * OTHER people's names - your own lives in the profile store - so the
 * mentioned user's own client resolved their did to nothing and rendered
 * the raw did:key prefix.
 */
export function resolveMentionDisplayName(did: string): string {
  if (did === (identityStore.did ?? "") || did === _transport.selfId()) {
    return profileStore.nickname || "You";
  }
  return (
    transportState.peerNames.get(_peerIdToDid.get(did) ?? did) ??
    transportState.peerNames.get(did) ??
    did.slice(0, 12)
  );
}

/** Mutate the peer->DID map through here so reactive readers are notified. */
function _setPeerDid(peerId: string, did: string): void {
  if (_peerIdToDid.get(peerId) === did) return;
  _peerIdToDid.set(peerId, did);
  _profileRepair.delete(peerId);
  transportState.peerDidVersion += 1;
  // The announcement is scoped by room membership, so it needs the DID; on a
  // first connection that only lands here, once the profile has arrived.
  _announceStoredFilesTo(peerId).catch(() => {});
}
const _seededByFingerprint = new Map<string, FileDescriptor>();

export const _dtln = new DtlnProcessor();
// The 8 MB worklet is loaded lazily on first voice use (waitUntilReady kicks
// init); at startup we only warm the service-worker cache for it, off the
// critical path, so the first call doesn't also pay the download.
const warmWorkletCache = () => void fetch(WORKLET_URL).catch(() => {});
if (typeof requestIdleCallback === "function") requestIdleCallback(warmWorkletCache);
else setTimeout(warmWorkletCache, 3000);
export const _transport = new LibP2PTransport();
export const _voice = new LibP2PVoice(_transport, _dtln);
export const _video = new MediasoupVideo();
export const _fileTransport = new WebTorrentFileTransport(() =>
  _transport.selfId()
);

// Initialize submodules that depend on transport instances
// Order matters: they receive instances from here
initVoice(_voice, _dtln);
initTransmission(_video);
initFiles(_fileTransport);

// Who the SFU is allowed to name as a producer: the same roster the voice
// layer gets. Without it the media server decides which peerId a camera or
// screen share is filed under, and that peerId is what the tile, the name
// and the avatar are drawn from.
_video.setCallPeerAdmission(
  (peerId) =>
    !!transportState.callRoomCode &&
    transportState.callPeerRooms.get(peerId) === transportState.callRoomCode
);

/** Resolve the SFU host list once per call; each entry may be unparseable. */
function _diagSfuHosts(): string[] {
  const hosts: string[] = [];
  for (const url of sfuUrls()) {
    try {
      hosts.push(new URL(url).host);
    } catch {
      // An unparseable configured URL is dropped, not fatal to the sample.
    }
  }
  return hosts;
}

/** The HOST only, never a URL with a path or query. */
function _diagApiHost(): string {
  const url = apiUrl();
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The trailing `/p2p/<id>` segment of the relay multiaddr, id only. */
function _diagRelayPeerId(): string {
  const marker = "/p2p/";
  const addr = relayMultiaddr();
  const at = addr.lastIndexOf(marker);
  if (at === -1) return "";
  const rest = addr.slice(at + marker.length);
  const nextSlash = rest.indexOf("/");
  return nextSlash === -1 ? rest : rest.slice(0, nextSlash);
}

installTelemetryTaps({
  selfPeerId: () => _transport.selfId(),
  runtime: () => ({
    apiHost: _diagApiHost(),
    relayPeerId: _diagRelayPeerId(),
    sfuHosts: _diagSfuHosts(),
    configured: isConfigured(),
  }),
  faultsActive,
  counterBags: () => ({ t: _transport.debugStats, a: _stats, f: faultStats }),
  inCall: () => transportState.inCall,
  hidden: () => typeof document !== "undefined" && document.hidden,
  requestSfuDiag: () => _video.requestDiag(),
});

// Stored peer profile metadata is invisible until the peer re-broadcasts:
// the reactive map only ever filled from live messages, so a reload emptied
// every card and name effect for anyone not currently online. Hydrate from
// storage, but never overwrite what a live message already delivered.
// Called from connect(), NOT at module scope: the module loads with the
// unlock screen, and profile rows are sealed until the key is armed - the
// module-scope version rejected on the first row, swallowed the error, and
// never retried, emptying every offline peer's card again.
function _hydratePeerProfileMeta(): void {
  void getAllPeerProfiles()
  .then((profiles) => {
    const meta = new Map(transportState.peerProfileMeta);
    for (const p of profiles) {
      if (meta.has(p.did)) continue;
      if (!p.bannerURL && !p.tagText && !p.bio && !p.nameEffect) continue;
      meta.set(p.did, {
        bannerUrl: p.bannerURL,
        tagText: p.tagText,
        tagTextColor: p.tagTextColor,
        tagChipColor: p.tagChipColor,
        bio: p.bio,
        nameEffect: p.nameEffect,
        nameShimmer: p.nameShimmer,
        nameGlow: p.nameGlow,
        gradient2: p.gradient2,
        gradient3: p.gradient3,
      });
    }
    transportState.peerProfileMeta = meta;
  })
  .catch(() => {});
}

const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3 } as const;

/**
 * Advance a message's delivery status (never regress: a late "delivered"
 * ack must not overwrite "read"). Updates IDB and the in-memory list.
 */
export function applyMessageStatus(
  messageId: string,
  status: keyof typeof STATUS_RANK
): void {
  updateMessageStatus(messageId, status).catch(() => {});
  const idx = transportState.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const current = transportState.messages[idx].status;
  if (current && STATUS_RANK[current] >= STATUS_RANK[status]) return;
  const next = [...transportState.messages];
  next[idx] = { ...next[idx], status };
  transportState.messages = next;
}

/**
 * Keep only the receipts a peer is entitled to send.
 *
 * The ack and read branches used to apply whatever message id arrived from
 * whatever peer sent it - unlike the chat branch beside them, which refuses to
 * act until the sender's DID is bound. So any connected peer could mark our
 * messages "delivered" or "read" by naming their ids, and a "read" also drags
 * _cascadeReadAcks over everything we sent below that lamport in the room. Ids
 * are UUIDs, but they are not secret: every SyncBatch carries them, so a room
 * member has plenty to replay.
 *
 * A receipt is only meaningful from the other party, so it is accepted only
 * for a message living in the DM room derived from the sender's PROVEN DID -
 * the only room in which they could have received it. The in-memory list is
 * consulted first because sendDirectMessage echoes there before it awaits the
 * storage write, and an ack can beat that write back to us.
 */
async function _acceptableReceipts(
  peerId: string,
  messageIds: string[]
): Promise<string[]> {
  if (!_peerIdToDid.get(peerId)) return [];
  return _receiptsForDmWith(peerId, messageIds);
}

/**
 * The room half of the rule above, without the peerId binding.
 *
 * The mailbox path has no stream to bind: the sender's identity was proven
 * by their signature over the sealed envelope, and `who` is that DID.
 */
async function _receiptsForDmWith(
  who: string,
  messageIds: string[]
): Promise<string[]> {
  const roomCode = await dmConversationCodeAsync(who).catch(() => null);
  if (!roomCode) return [];
  // One transaction, no decryption: roomCode is a clear field. Reading these
  // with getMessage per id cost a transaction plus a full row decrypt each,
  // and openDmConversation acks a whole page (50) at once.
  const ids = messageIds.filter((id) => typeof id === "string" && id);
  const clear = await messageClearFieldsByIds(ids);
  // Two forms of the same room code: the in-memory copy carries it plain,
  // the clear-field read returns the blinded value the row is indexed
  // under. Each must be compared against its own form. One compare against
  // the blinded value for both rejected every receipt for a message the
  // sender currently had on screen, which is exactly when they are watching
  // the ticks.
  const blindedRoomCode = await blindValue(roomCode);
  return ids.filter((id) => {
    const local = transportState.messages.find((m) => m.id === id);
    if (local) return local.roomCode === roomCode;
    return clear.get(id)?.roomCode === blindedRoomCode;
  });
}

/**
 * `who` names the other party, so the room is the DM with them: every id
 * here already passed _receiptsForDmWith for that room. The room code has to
 * be derived again rather than read off the rows, because the rows hold it
 * blinded and markOwnMessagesReadUpTo blinds what it is given - passing the
 * stored value blinded it twice and the cascade matched nothing.
 */
async function _cascadeReadAcks(
  who: string,
  messageIds: string[]
): Promise<void> {
  const roomCode = await dmConversationCodeAsync(who).catch(() => null);
  if (!roomCode) return;
  const self = selfId();
  // senderId and lamport are clear fields, so this needs no decryption and
  // one transaction rather than one per id.
  const clear = await messageClearFieldsByIds(messageIds);
  // senderId is stored blinded, so blind the self value before comparing.
  const blindedSelf = await blindValue(self);
  let lamport = 0;
  for (const m of clear.values()) {
    if (m.senderId !== blindedSelf) continue;
    lamport = Math.max(lamport, m.lamport);
  }
  if (!lamport) return;
  const changed = await markOwnMessagesReadUpTo(roomCode, self, lamport);
  if (!changed.length) return;
  const changedSet = new Set(changed);
  transportState.messages = transportState.messages.map((m) =>
    changedSet.has(m.id) ? { ...m, status: "read" } : m
  );
}

function lamportSend(roomCode: string): number {
  const next = (_lamports.get(roomCode) ?? 0) + 1;
  _lamports.set(roomCode, next);
  return next;
}

/**
 * A room's clock may only be dragged forward by a bounded step.
 *
 * `remote` is whatever the wire said. One message claiming
 * Number.MAX_SAFE_INTEGER used to saturate the counter outright: float64
 * cannot represent max+1 distinctly, so every later local message got the
 * SAME lamport. Ordering then collapsed to the senderId tiebreak in
 * MSG_ORDER, getMessagesAboveWatermarks' strict `>` stopped offering our own
 * messages to any peer, and the unread badge never moved again - permanently,
 * because the clock is also persisted through the watermarks it writes.
 *
 * DM rooms carry wall-clock milliseconds by design (nextDmLamport), so a
 * relative step is meaningless there and they get a wall-clock ceiling
 * instead. The room bound is deliberately generous: it exists to stop
 * saturation, not to police a busy room we have been away from.
 */
const MAX_LAMPORT_JUMP = 1_000_000;
const MAX_DM_LAMPORT_SKEW = 86_400_000;

function lamportCeiling(roomCode: string, at: number): number {
  return roomCode.startsWith("dm-")
    ? Math.max(at, Date.now() + MAX_DM_LAMPORT_SKEW)
    : at + MAX_LAMPORT_JUMP;
}

function lamportReceive(roomCode: string, remote: number): void {
  const at = _lamports.get(roomCode) ?? 0;
  const sane =
    typeof remote === "number" && Number.isSafeInteger(remote) && remote >= 0
      ? Math.min(remote, lamportCeiling(roomCode, at))
      : 0;
  _lamports.set(roomCode, Math.max(at, sane) + 1);
}

if (typeof window !== "undefined") {
  const sayGoodbye = () => {
    for (const transfer of transportState.fileTransfers.values()) {
      if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
    }
    // Say goodbye. Without it the other side keeps a connection that looks
    // alive, holds the stream it belongs to, and quietly writes into nothing
    // when we come back. Best effort: an unloading page gets no async time,
    // but the peers that do hear it recover instantly instead of waiting for
    // the reconcile to notice.
    for (const listener of _beforeDisconnectListeners) {
      try {
        listener();
      } catch {
        /* unloading must continue */
      }
    }
  };
  const onUnload = () => {
    sayGoodbye();
    _transport.disconnect();
  };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("pagehide", (event) => {
    sayGoodbye();
    // A PERSISTED pagehide is not an unload: the page goes into the
    // back-forward cache with every socket and timer it had, and a back
    // gesture brings the same JS context back. Tearing the node down here
    // did it anyway, and disconnect() suppresses the relay status event on
    // purpose - so relayConnected stayed true over a dead node, connect()
    // early-returned on the stale flag, and the restored page sat there
    // reading "Connected" with nothing behind it. pageshow repairs it.
    if (!event.persisted) _transport.disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void _resumeFromFrozen("bfcache");
  });
}
if (typeof document !== "undefined") {
  // Page Lifecycle: a tab Chrome froze thaws through these rather than
  // through pageshow, and it comes back in the same state - flags intact,
  // sockets gone.
  document.addEventListener("freeze", () => {
    rec(ev("session.visibility", { d: { hidden: true, frozen: true } }));
  });
  document.addEventListener("resume", () => void _resumeFromFrozen("resume"));
}

/**
 * A page that came back from the dead: check the relay link rather than the
 * flag that says we have one, and rebuild when it is gone.
 */
async function _resumeFromFrozen(why: string): Promise<void> {
  rec(ev("session.visibility", { d: { hidden: false, restored: why } }));
  if (_transport.p2pNode && _transport.relayLinkLive()) {
    // The node survived. Everything else may still be stale.
    _resyncEverything();
    return;
  }
  transportState.relayConnected = false;
  await connect().catch(() => {});
  _resyncEverything();
}

// ── Senders ───────────────────────────────────────────────────────────────────

function _sendRoomName(peerId?: string): void {
  const roomCode = transportState.roomCode;
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name || !roomCode) return;
  // roomCode travels with it: a direct send has no topic to infer it from, so
  // the receiver used to apply the name to whatever room they had open.
  const payload = encode({ type: MessageType.RoomName, name, roomCode });
  if (peerId) {
    // Same gate as _sendDigestForRoom, and for the same reason: this frame
    // NAMES the room code, and a room code is the room's entire membership
    // secret. The "connect" event fires for ANY peer that dials us - anyone
    // who knows our permanent peerId can - so an ungated welcome handed the
    // join secret for the room on screen to whoever turned up.
    if (!_transport.peersInRoom(roomCode).includes(peerId)) return;
    _transport.send(peerId, payload);
  } else _transport.broadcast(payload, roomCode);
}

async function _sendProfile(peerId?: string, isReply = false): Promise<void> {
  const profile = await getOwnProfile();
  const name = profile?.nickname?.trim() || "Anonymous";
  const did = identityStore.did ?? null;
  let avatarUrl: string | null = profile?.pfpURL || null;
  if (!avatarUrl && profile?.pfpData) {
    const bytes = new Uint8Array(profile.pfpData);
    avatarUrl = `data:${sniffImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  }

  let bannerUrl: string | null = profile?.bannerURL || null;
  if (!bannerUrl && profile?.bannerData) {
    const bytes = new Uint8Array(profile.bannerData);
    bannerUrl = `data:${sniffImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  }

  // Prove this DID owns our peerId; the receiver cannot derive it any more.
  let binding: { did: string; bindingSig: string } | null = null;
  try {
    binding = signPeerBinding(_transport.selfId());
  } catch {
    binding = null; // identity locked: the peer just will not bind us yet
  }

  const payload = encode({
    type: MessageType.Profile,
    name,
    did,
    avatarUrl,
    color: profile?.color ?? null,
    peerId: _transport.selfId(),
    bindingSig: binding?.bindingSig,
    reply: isReply || undefined,
    bannerUrl: bannerUrl ?? undefined,
    gradient2: profile?.gradient2 ?? undefined,
    gradient3: profile?.gradient3 ?? undefined,
    tagText: profile?.tagText ?? undefined,
    tagTextColor: profile?.tagTextColor ?? undefined,
    tagChipColor: profile?.tagChipColor ?? undefined,
    bio: profile?.bio ?? undefined,
    nameEffect: profile?.nameEffect ?? undefined,
    nameShimmer: profile?.nameShimmer ?? undefined,
    nameGlow: profile?.nameGlow ?? undefined,
  });

  const hash = frameHash(payload);
  const sendTo = (pid: string): boolean => {
    if (!_profileEcho.shouldSend(pid, hash)) {
      _stats.profilesSkipped++;
      return false;
    }
    _stats.profilesOut++;
    return true;
  };

  if (peerId) {
    if (sendTo(peerId)) _transport.send(peerId, payload);
    return;
  }

  // Reach everyone who could care: every room we are in (not just the one on
  // screen) and every connected peer directly. A single broadcast to the
  // active room missed peers in other shared rooms, and was silently dropped
  // when the gossipsub mesh had not formed yet - which is why a changed
  // nickname or avatar often never showed up for anyone.
  for (const room of _transport.rooms()) {
    _transport.broadcast(payload, room);
  }
  for (const pid of _transport.peers()) {
    if (sendTo(pid)) _transport.send(pid, payload).catch(() => {});
  }
}

async function _broadcastProfile(): Promise<void> {
  await _sendProfile().catch(() => {});
}

/**
 * Digests are cheap (one number per sender) and idempotent, so the recovery
 * story is "exchange one whenever there is reason to think we drifted" rather
 * than polling. Debounced per peer so a burst of reasons costs one digest.
 */
const SYNC_DEBOUNCE_MS = 10_000;
const _lastDigestAt = new Map<string, number>();
/** "room|senderId" -> highest lamport we have seen, for the gap hint above. */
const _lastSeenLamport = new Map<string, number>();

function _syncPeer(peerId: string, force = false): void {
  const now = Date.now();
  if (!force && now - (_lastDigestAt.get(peerId) ?? 0) < SYNC_DEBOUNCE_MS) {
    return;
  }
  _lastDigestAt.set(peerId, now);
  _sendDigest(peerId).catch(() => {});
}

/** Reconcile with everyone we are connected to. */
function _syncAllPeers(force = false): void {
  for (const pid of _transport.peers()) _syncPeer(pid, force);
}

/**
 * Per-peer repair tick. Event-driven sync covers everything EXCEPT the case
 * where the last event is the one that got lost: a message that misses its
 * delivery window has no later event to recover it, and a profile reply that
 * vanishes leaves the peer unbound forever. Measured directly in the churn
 * scenario - after three reloads everything settles and the final message
 * just sits on one side.
 *
 * This is not global polling: it only speaks up for a peer in an abnormal
 * state - connected but never identified, or silent at the app level for a
 * while. A healthy, active mesh sends nothing.
 */
const REPAIR_TICK_MS = 15_000;
const APP_SILENCE_MS = 15_000;
const PROFILE_REPAIR_MAX_MS = 5 * 60_000;
const _lastAppInbound = new Map<string, number>();
const _profileRepair = new Map<string, { next: number; delay: number }>();
/** One copy of an unchanged profile per peer per burst - see profile-echo.ts. */
const _profileEcho = new ProfileEcho();

if (typeof window !== "undefined") {
  setInterval(() => {
    // Same rule as the liveness probe: a hidden tab has no UI to keep honest
    // and a phone radio to leave alone - returning to the page runs a full
    // resync anyway.
    if (typeof document !== "undefined" && document.hidden) return;
    for (const pid of _transport.peers()) {
      if (!_peerIdToDid.has(pid)) {
        // Connected but unbound: our profile (or their reply) was lost.
        // Backed off per peer: a peer that can NEVER bind (locked identity,
        // old build) would otherwise receive the full profile - avatar
        // payload included - every 15s for the whole session.
        const repair = _profileRepair.get(pid) ?? { next: 0, delay: 0 };
        if (Date.now() >= repair.next) {
          repair.delay = Math.min(
            Math.max(repair.delay * 2, REPAIR_TICK_MS),
            PROFILE_REPAIR_MAX_MS
          );
          repair.next = Date.now() + repair.delay;
          _profileRepair.set(pid, repair);
          // Catch: getOwnProfile can reject (blocked IDB upgrade,
          // private-mode quota).
          _sendProfile(pid).catch(() => {});
        }
        continue;
      }
      const quietFor = Date.now() - (_lastAppInbound.get(pid) ?? 0);
      if (quietFor > APP_SILENCE_MS) {
        // Alive (liveness pings hold the connection) but silent: verify we
        // did not miss anything. One digest, a number per sender.
        _syncPeer(pid, true);
      }
    }

    // The offline DM queue only ever drained on a "connect" event, and a
    // peer who was ALREADY connected when the message was queued fires none.
    // One pass over the whole queue, not one per peer.
    flushQueuedDmForConnectedPeers().catch(() => {});

    // Call-roster ghosts: an entry neither refreshed by presence heartbeats
    // nor backed by a live voice link within the TTL is gone - remove it so
    // the sidebar group and the call status stop counting a phantom.
    if (transportState.callPeerRooms.size > 0) {
      const live = new Set(_voice?.activePeers() ?? []);
      const now = Date.now();
      let purged = false;
      const roomNext = new Map(transportState.callPeerRooms);
      const idsNext = new Set(transportState.callPeerIds);
      const statesNext = new Map(transportState.callPeerStates);
      for (const [pid] of transportState.callPeerRooms) {
        if (live.has(pid)) {
          _callPeerSeen.set(pid, now);
          continue;
        }
        const seen = _callPeerSeen.get(pid) ?? 0;
        if (seen === 0) {
          // Pre-TTL entry (or restored state): start its clock now.
          _callPeerSeen.set(pid, now);
          continue;
        }
        if (now - seen > CALL_PRESENCE_TTL_MS) {
          // For everyone still in the call this IS a disconnect - same
          // chime as a drop, not a silent vanishing.
          _peerCallSound(roomNext.get(pid), false, idsNext.has(pid));
          roomNext.delete(pid);
          idsNext.delete(pid);
          statesNext.delete(pid);
          _callPeerSeen.delete(pid);
          purged = true;
        }
      }
      if (purged) {
        transportState.callPeerRooms = roomNext;
        transportState.callPeerIds = idsNext;
        transportState.callPeerStates = statesNext;
      }
      // Backstop: presence events drive this too, but the whole point of the
      // tick is that the last event is the one that goes missing.
      _syncVoiceRoster();
    }

    // Digests only ever covered the open room, so a room in the background
    // stayed incomplete until the user happened to click into it. Rotate
    // through the other subscribed rooms, one per tick - bounded traffic,
    // and every room heals within a few minutes.
    const backgroundRooms = _transport
      .rooms()
      .filter((r) => r !== transportState.roomCode);
    if (backgroundRooms.length > 0) {
      const room =
        backgroundRooms[_backgroundSyncIndex % backgroundRooms.length];
      _backgroundSyncIndex++;
      // ONLY peers the relay says are in that room. A digest names its
      // roomCode on the wire, and a room code is the room's entire
      // membership secret - it is the gossipsub topic, the rendezvous key
      // and the SFU join key. Fanning this to every connected peer therefore
      // handed anyone who shared ANY room with us the join secret for every
      // other room we were in, background rooms included.
      for (const pid of _transport.peersInRoom(room)) {
        if (!_peerIdToDid.has(pid)) continue;
        _sendDigestForRoom(pid, room).catch(() => {});
      }
    }
  }, REPAIR_TICK_MS);
}

let _backgroundSyncIndex = 0;

/** Away longer than this and the connections are suspect, not just history. */
const AWAY_FULL_RESYNC_MS = 60_000;
let _hiddenSince = 0;

/**
 * Everything a peer needs to know about us, plus a request for everything we
 * need from them. Cheap enough to fire on returning to the app.
 */
function _resyncEverything(): void {
  _transport.reconcileNow();
  _broadcastProfile().catch(() => {});
  if (transportState.roomCode) _broadcastJoinRoom();
  if (transportState.inCall) {
    _sendCallPresence();
    _sendCallState();
    // The SFU session can die silently while voice (p2p) keeps working;
    // rejoining it re-triggers the producer replay so live shares reappear.
    _video.ensureLive();
  }
  _syncAllPeers(true);
  _digestJoinedRooms();
}

/**
 * A digest for every room we are in, not only the one on screen.
 *
 * _syncAllPeers digests transportState.roomCode and nothing else, so coming
 * back from a sleep repaired the open conversation and left every other room
 * to the repair tick's one-room-per-15s rotation - minutes of missing
 * history in rooms the user then scrolls straight into. Membership-gated and
 * throttled by the same window _handleDigest uses, so a burst of resyncs
 * (online, netchange, resume can all fire together) sends one round.
 */
function _digestJoinedRooms(): void {
  for (const room of _transport.rooms()) {
    if (room === transportState.roomCode) continue; // _syncAllPeers has it
    for (const pid of _transport.peersInRoom(room)) {
      if (!_peerIdToDid.has(pid)) continue;
      if (!allowSyncReaction(`resync|${pid}|${room}`)) continue;
      _sendDigestForRoom(pid, room).catch(() => {});
    }
  }
}

if (typeof document !== "undefined") {
  // Coming back from the background is the big one: a phone that slept has
  // missed whatever happened meanwhile, and nothing inside the app will ever
  // tell it so.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      _hiddenSince = Date.now();
      rec(ev("session.visibility", { d: { hidden: true } }));
      return;
    }
    const away = _hiddenSince ? Date.now() - _hiddenSince : 0;
    _hiddenSince = 0;
    rec(ev("session.visibility", { d: { hidden: false, hiddenMs: away } }));
    // A glance away only needs history reconciled. A long absence means the
    // connections themselves may be stale, so re-announce and re-dial too.
    if (away > AWAY_FULL_RESYNC_MS) _resyncEverything();
    else _syncAllPeers();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    rec(ev("session.online"));
    // A relay circuit does not close when the radio dies, it just stops
    // carrying frames - so the reconcile below would happily reconcile over
    // a link that no longer exists. Probe it first.
    void _transport.checkRelayLiveness();
    _resyncEverything();
  });
  window.addEventListener("offline", () => {
    rec(ev("session.online", { d: { online: false } }));
    // Nothing is reachable, and saying so beats a status pill that claims
    // otherwise until the next failed dial notices.
    transportState.relayConnected = false;
  });
  // A phone moving between wifi and cellular fires this and nothing else:
  // no offline, no socket close, no error - every connection simply goes
  // quiet while continuing to look open.
  const connection = (navigator as Navigator & { connection?: EventTarget })
    .connection;
  connection?.addEventListener?.("change", () => {
    rec(ev("session.online", { d: { reason: "netchange" } }));
    void _transport.checkRelayLiveness();
    _resyncEverything();
  });
}

async function _sendDigest(peerId: string): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  await _sendDigestForRoom(peerId, roomCode);
}

/**
 * The "here is my call" frames a peer gets on connect, or once the relay
 * places them in the call's room.
 *
 * Gated on membership of the CALL's room, same rule as _sendDigestForRoom:
 * CallPresence carries that room's code, which is the room's entire
 * membership secret - the gossipsub topic, the rendezvous key and the SFU
 * join key. These went out on every "connect" (which fires for any peer that
 * dials us) and again from _handleProfile on any profile, so a stranger who
 * knew our peerId collected the join key for whatever room we were calling
 * in. CallState and WatchPresence ride the same gate: they only describe a
 * call whose existence is itself the thing being kept.
 */
function _sendCallFramesTo(peerId: string): void {
  if (!transportState.inCall) return;
  const callRoom = transportState.callRoomCode ?? transportState.roomCode;
  if (!callRoom) return;
  if (!_transport.peersInRoom(callRoom).includes(peerId)) return;
  _sendCallPresence(peerId);
  _sendCallState(peerId);
  _sendWatchPresence(peerId);
}


async function _sendDigestForRoom(
  peerId: string,
  roomCode: string,
  opts: { peerKnowsRoom?: boolean } = {}
): Promise<void> {
  // A digest names its roomCode on the wire, and a room code is the room's
  // ENTIRE membership secret - the gossipsub topic, the rendezvous key and
  // the SFU join key all at once. So a digest may only go to somebody the
  // relay says is already in that room; sending one to every connected peer
  // handed anyone who shared any room with us the keys to all our others.
  //
  // peerKnowsRoom is for the one case where membership is not the question:
  // replying to a peer who just sent US a digest for this room. They named it
  // first, so they already have the code.
  if (!opts.peerKnowsRoom && !_transport.peersInRoom(roomCode).includes(peerId)) {
    return;
  }
  const watermarks = _withRefused(
    roomCode,
    await getWatermarksForRoom(roomCode)
  );
  _stats.digestsOut++;
  rec(
    ev("app.digest.out", {
      peer: peerId,
      room: refs().roomRef(roomCode),
      d: { watermarks: Object.keys(watermarks).length },
    })
  );
  await _transport.send(
    peerId,
    encode({ type: MessageType.SyncDigest, roomCode, watermarks })
  );
}

// ── History ───────────────────────────────────────────────────────────────────

export async function _loadHistory(
  roomCode: string,
  stillCurrent: () => boolean = () => true
): Promise<void> {
  const page = { capped: false };
  const [msgs, profiles] = await Promise.all([
    getMessages(roomCode, undefined, page),
    getAllPeerProfiles(),
  ]);
  if (!stillCurrent()) return;
  // Storage pages on the lamport index, which is not the order this is read
  // in - see compareMessages. Every other path into transportState.messages
  // sorts; this one assigned the page raw, so opening a room showed causal
  // order and only a later sync or a scroll-up put it right.
  transportState.messages = [...msgs].sort(MSG_ORDER);
  // Whether a first read filled a page is the only honest answer to "is
  // there more?", and it is known here and nowhere else.
  transportState.historyCapped = page.capped;
  // DM rooms use wall-clock ms as their lamport - absorbing those here would
  // catapult the shared room clock to ~1.7e12 and skew every room after.
  if (msgs.length > 0) {
    const seen = Math.max(...msgs.map((m) => m.lamport));
    _lamports.set(roomCode, Math.max(_lamports.get(roomCode) ?? 0, seen));
  }
  if (profiles.length > 0) {
    const names = new Map(transportState.peerNames);
    const avatars = new Map(transportState.peerAvatars);
    const colors = new Map(transportState.peerColors);
    for (const p of profiles) {
      names.set(p.did, p.nickname);
      if (p.pfpURL) avatars.set(p.did, p.pfpURL);
      if (p.color) colors.set(p.did, p.color);
    }
    transportState.peerNames = names;
    transportState.peerAvatars = avatars;
    transportState.peerColors = colors;
  }

  for (const msg of msgs) {
    if (msg.type !== MessageType.File || !msg.meta?.files?.length) continue;
    for (const file of msg.meta.files) {
      if (transportState.fileTransfers.has(file.infoHash)) continue;
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 0,
      });
    }
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function _handleDigest(
  peerId: string,
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  // Only reconcile a room we have actually joined - never a room the sender
  // merely named, and never fall back to whatever room the UI has open.
  _stats.digestsIn++;
  if (!roomCode || !_transport.rooms().includes(roomCode)) return;
  rec(
    ev("app.digest.in", {
      peer: peerId,
      room: refs().roomRef(roomCode),
      d: { watermarks: Object.keys(theirWatermarks).length },
    })
  );
  // Senders in a digest are peer-chosen strings, and every entry costs a
  // blindValue plus map work downstream. A room never accumulates anywhere
  // near this many senders honestly; a digest that does is dropped whole.
  if (Object.keys(theirWatermarks).length > REFUSED_MAX_SENDERS) return;

  // A DM digest may ONLY come from that conversation's counterparty (or one
  // of our own paired devices). _handleSyncBatch has always enforced this on
  // the receive side; the PUSH side did not, and a DM room code is not a
  // secret - it is sha256 over the two participants' public DIDs, which are
  // broadcast in every Profile frame. So any peer able to reach us could
  // compute the code for a conversation they are not in, send an empty
  // digest, and have _pushMissingTo hand back that entire private history,
  // inline attachment bytes included.
  if (roomCode.startsWith("dm-")) {
    const fromDid = dmPeerDid(peerId);
    const isOwnDevice = !!fromDid && fromDid === identityStore.did;
    if (!isOwnDevice) {
      const expected = await dmConversationCodeAsync(peerId).catch(() => null);
      if (expected !== roomCode) {
        console.warn(
          "[sync] refused DM digest from a peer outside that conversation"
        );
        return;
      }
    }
  }

  // A member's watermark for OUR sender id is the first hard evidence a room
  // message actually left: it says they hold everything up to that lamport.
  // Room sends start at "sending" when the mesh had nobody in it, and this
  // is what retires that clock.
  _promoteSentByWatermark(roomCode, theirWatermarks);

  let mine = await getWatermarksForRoom(roomCode);

  // Throttled BEFORE the work, not just before the send.
  //
  // Deciding what a peer is missing costs getSenderMaxLamports, which reads
  // every row in the room off the lamport index (twice, when the watermark
  // store also needs rebuilding), and the push that follows decrypts and
  // re-uploads whatever it finds. The window used to sit on the send alone,
  // so a member looping empty digests still bought a full-room scan per
  // frame - throttling the reaction while leaving the amplifier running.
  // Consuming the window on a digest that turns out to need no push is the
  // deliberate cost: the scan is what has to be rationed, and the two cases
  // are indistinguishable before it runs. One push hands over everything
  // missing and the repair tick is slower than this window, so honest flows
  // are unaffected.
  if (allowSyncReaction(`push|${peerId}|${roomCode}`)) {
    // History written before watermarks existed for this room (all DMs until
    // now) leaves `mine` empty, which reads as "nothing to compare" and makes
    // reconciliation a no-op. Rebuild once from what is actually stored.
    if (Object.keys(mine).length === 0) {
      // Clear fields suffice for watermarks too - no decrypt for the rebuild.
      const rebuilt = await getSenderMaxLamports(roomCode);
      for (const [sid, lamport] of rebuilt) {
        await setWatermark(roomCode, sid, lamport);
      }
      if (rebuilt.size) mine = await getWatermarksForRoom(roomCode);
    }

    // Senders we hold messages from, not senders we happen to have a
    // watermark row for. A partial watermark map (one row lost, or written
    // before a sender was known) silently excluded that sender from every
    // push we ever made. Clear fields only: building this via getAllMessages
    // AES-decrypted the whole room on every background digest exchange, for
    // two fields that were never encrypted in the first place.
    const highest = await getSenderMaxLamports(roomCode);
    for (const [sid, lamport] of Object.entries(mine)) {
      const at = highest.get(sid);
      if (at === undefined || lamport > at) highest.set(sid, lamport);
    }
    const theyAreMissing = [...highest.keys()].filter(
      (sid) => (theirWatermarks[sid] ?? -1) < highest.get(sid)!
    );

    if (theyAreMissing.length > 0) {
      await _pushMissingTo(peerId, roomCode, theirWatermarks);
    }
  }

  // A digest only tells the SENDER what they lack, so one exchange heals one
  // direction. If their watermarks show they hold something we do not, send
  // ours back so they push it to us. Without this, whichever side happened to
  // have a reason to sync was the only side that ever caught up. It cannot
  // loop: the reply only goes out when we are genuinely behind.
  // Measured against what our next digest would ADVERTISE, refused claims
  // included: being "behind" on history we have already refused for good is
  // not a reason to ask for a push we would only refuse again - and asking
  // would bounce a digest back and forth every exchange.
  const advertised = _withRefused(roomCode, { ...mine });
  const weAreBehind = Object.keys(theirWatermarks).some(
    (sid) => (theirWatermarks[sid] ?? -1) > (advertised[sid] ?? -1)
  );
  // Reply for the SAME room: routing through _syncPeer digested whatever
  // room the UI had open, so a background room only ever healed one way.
  // Throttled: this reply bypasses the _syncPeer debounce by design, and a
  // peer forging an absurd watermark could bounce a reply out of us per
  // frame, forever.
  if (weAreBehind && allowSyncReaction(`reply|${peerId}|${roomCode}`))
    _sendDigestForRoom(peerId, roomCode, { peerKnowsRoom: true }).catch(
      () => {}
    );
}

/**
 * Advance our own still-"sending" messages in this room, for messages the
 * peer's digest proves they already hold. Scoped to the on-screen list: it
 * is the only place the clock is drawn, and applyMessageStatus writes the
 * stored row by id anyway.
 */
function _promoteSentByWatermark(
  roomCode: string,
  theirWatermarks: Record<string, number>
): void {
  const self = identityStore.did ?? _transport.selfId();
  const at = theirWatermarks[self];
  if (typeof at !== "number") return;
  for (const m of transportState.messages) {
    if (m.roomCode !== roomCode || m.senderId !== self) continue;
    if (m.status !== "sending" || m.lamport > at) continue;
    applyMessageStatus(m.id, "sent");
  }
}

async function _pushMissingTo(
  peerId: string,
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!roomCode) return;
  // Filter on clear senderId/lamport BEFORE decrypting: only the rows
  // actually going onto the wire pay for crypto, instead of the whole room.
  const missing = await getMessagesAboveWatermarks(roomCode, theirWatermarks);

  if (!missing.length) return;

  // Re-attach inline bytes for small files we still hold: this is what lets
  // a peer who was offline at send time get the image at all - attachment
  // bytes have no other path through history sync.
  const enriched: WireChatMessage[] = await Promise.all(
    missing.map(async (m) => {
      if (m.type !== MessageType.File || !m.meta?.files?.length) return m;
      const files = await Promise.all(
        m.meta.files.map(async (f) => {
          if (f.size > INLINE_FILE_MAX_BYTES) return f;
          const stored = (await getAttachmentsByInfoHash(f.infoHash)).find(
            (a) => a.data
          );
          return stored?.data
            ? { ...f, inline: bytesToBase64(new Uint8Array(stored.data)) }
            : f;
        })
      );
      return { ...m, meta: { files } };
    })
  );

  // Size-aware batching: BATCH_SIZE messages that each carry inline bytes
  // would blow the 4MB frame cap, so a batch closes early on bytes too.
  const MAX_BATCH_BYTES = 1_500_000;
  const sizeOf = (m: WireChatMessage) =>
    (m.content?.length ?? 0) +
    (m.meta?.files?.reduce((n, f) => n + (f.inline?.length ?? 0), 0) ?? 0) +
    512;
  const batches: WireChatMessage[][] = [];
  let cur: WireChatMessage[] = [];
  let curBytes = 0;
  for (const m of enriched) {
    const sz = sizeOf(m);
    if (
      cur.length &&
      (cur.length >= BATCH_SIZE || curBytes + sz > MAX_BATCH_BYTES)
    ) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(m);
    curBytes += sz;
  }
  if (cur.length) batches.push(cur);

  for (let i = 0; i < batches.length; i++) {
    _transport.send(
      peerId,
      encode({
        type: MessageType.SyncBatch,
        roomCode,
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(peerId, encode({ type: MessageType.SyncComplete, roomCode }));
}

async function _handleSyncBatch(
  roomCode: string,
  messages: WireChatMessage[],
  fromPeerId?: string,
  /**
   * The sender marked this as the direct copy of a live send, not history
   * repair. Only a live batch may announce: a repair would beep once per
   * recovered message.
   */
  live = false
): Promise<void> {
  // Bind incoming history to the room named in the (signed-message-bearing)
  // batch, and only if we actually joined it - a peer cannot inject history
  // into whatever room the receiver currently has open.
  if (!messages.length || !roomCode || !_transport.rooms().includes(roomCode))
    return;
  // Nothing bounded the row count. A single 4 MB frame (MAX_DIRECT_FRAME_BYTES)
  // holds ~10,500 rows, and the verification loop below is synchronous - ed25519
  // verify is pure JS with no yield - so one frame froze the tab for ~19s, and
  // repeated frames froze it for good. Every sender emits at most BATCH_SIZE
  // (_pushMissingTo), so 4x that is generous for anything honest.
  if (messages.length > BATCH_SIZE * 4) return;
  // DM conversations: only the counterparty - or another of OUR OWN paired
  // devices (same DID, which the counterparty-derived code can never match) -
  // may relay this history. The room code is derived from the two DIDs, so
  // it is checkable against the AUTHENTICATED sender.
  //
  // The unsigned exemption used to be a single flag for the WHOLE batch: once
  // the pusher was recognised as the counterparty, every row in the batch was
  // accepted without a signature, whatever senderId it named. So your DM
  // partner could push unsigned rows attributed to YOU - fabricated words in
  // your own name, in your own copy of the conversation, and (via the
  // watermark writes below) claiming lamport space you would then never be
  // offered again. The exemption is now per row and bound to an identity:
  //   null  - no unsigned row is acceptable
  //   "*"   - our own paired device, mirroring both halves of a conversation
  //           it legitimately holds in full
  //   <did> - the counterparty, for THEIR OWN messages only
  // Anything claiming to be from someone else must be signed and verify.
  //
  // Known cost: restoring your OWN sent DMs from the counterparty's mirror no
  // longer works, because those rows exist only unsigned on their device. A
  // reinstall recovers your half from your other paired device (still "*") or
  // from messages sent after signing; the counterparty's half is unaffected.
  let unsignedFrom: string | null = null;
  if (roomCode.startsWith("dm-")) {
    if (!fromPeerId) return;
    const fromDid = dmPeerDid(fromPeerId);
    const isOwnDevice = !!fromDid && fromDid === identityStore.did;
    if (isOwnDevice) {
      unsignedFrom = "*";
    } else {
      const expected = await dmConversationCodeAsync(fromPeerId).catch(
        () => null
      );
      if (expected !== roomCode) return;
      // expected === roomCode already proves fromDid resolved; be explicit.
      unsignedFrom = fromDid;
    }
  }
  const allowUnsignedFor = (m: WireChatMessage) =>
    unsignedFrom !== null &&
    (unsignedFrom === "*" || m.senderId === unsignedFrom);
  const verdicts = await Promise.all(
    messages.map((m) =>
      _verifyIncoming(m, { room: roomCode, allowUnsigned: allowUnsignedFor(m) })
    )
  );
  const verified = messages.filter((_, i) => verdicts[i].ok);
  if (verified.length < messages.length) {
    const reasons: Record<string, number> = {};
    for (const v of verdicts) {
      if (!v.ok) reasons[v.reason] = (reasons[v.reason] ?? 0) + 1;
    }
    console.warn(
      `[sync] dropped ${messages.length - verified.length} message(s) with invalid signatures`,
      reasons
    );
    rec(
      ev("app.sync.drop", {
        peer: fromPeerId ?? null,
        room: refs().roomRef(roomCode),
        d: { count: messages.length - verified.length, reason: "bad-signature" },
      })
    );
  }
  // Two kinds of rejection. A SIGNED (v2/v3) message that failed verify is
  // suspicious - maybe corruption, maybe a better copy exists - so its
  // lamport is a floor watermarks may not pass (claiming it would mean no
  // peer ever offers it again). But an unsigned row in a signed room, or
  // the retired v1 canonical, is rejected DETERMINISTICALLY, FOREVER: not
  // claiming those made every peer re-advertise the same gap and every
  // pusher re-decrypt and re-send the entire legacy backlog on each repair
  // tick - a permanent sync storm that pinned CPU on both ends (profiled:
  // getMessagesAboveWatermarks + _openAll at 40%+ of an idle tab). There
  // is no repair to protect; claim them.
  //
  // A rejected row's senderId and lamport are BOTH attacker-chosen - the row
  // failed verification, so nothing about it is attested. Writing its lamport
  // straight into the watermark store let any peer name a victim and a huge
  // lamport and have setWatermark (which never regresses) blackhole that
  // sender's real history in this room forever: every future digest we send
  // would claim we already hold it, so nobody would ever offer it again.
  // Hence: reject junk types outright, and cap the PERMANENT claim at the
  // highest lamport we ALREADY hold from that sender in this room, which can
  // hide nothing the protocol did not already treat as held. Capping alone
  // was not enough, though - it skips the peer that needs the claim most.
  // Someone joining a legacy room, or a reinstall pulling pre-signing DM
  // history, holds nothing from that sender, so the cap was zero and the
  // storm came straight back for exactly the common legitimate case. The
  // uncapped remainder is therefore claimed in memory for this session (see
  // _noteRefused), which stops the re-pushes without handing anyone a
  // permanent blackhole.
  const rejectedFloor = new Map<string, number>();
  const permanentMax = new Map<string, number>();
  messages.forEach((m, i) => {
    if (verdicts[i].ok) return;
    if (typeof m.senderId !== "string" || !m.senderId) return;
    if (!Number.isSafeInteger(m.lamport) || m.lamport < 0) return;
    // v2 joined v1 as a DETERMINISTIC reject at the 2026-08-28 sunset. This
    // classification is what stops the sync storm: a row we will never accept
    // has to be recorded as refused, or every peer holding it re-offers it on
    // every repair tick forever. Leaving v2 in the "signed, might be repaired
    // by a better copy" bucket below would have done exactly that to the
    // whole pre-v3 backlog.
    if (!m.sig || m.sigV !== 3) {
      const at = permanentMax.get(m.senderId);
      if (at === undefined || m.lamport > at) {
        permanentMax.set(m.senderId, m.lamport);
      }
      return;
    }
    const at = rejectedFloor.get(m.senderId);
    if (at === undefined || m.lamport < at) {
      rejectedFloor.set(m.senderId, m.lamport);
    }
  });
  for (const [sid, lamport] of permanentMax) {
    // Deterministic rejects (no signature, or a retired sigV) are recorded
    // IN MEMORY only, and _withRefused folds them into the watermarks we
    // advertise. That is the whole anti-storm mechanism: peers stop
    // re-offering rows we will never accept, so the repair tick stops
    // re-decrypting and re-pushing the legacy backlog every 15 seconds.
    //
    // Deliberately NOT persisted. senderId on an unsigned row is just a
    // string the sender chose, so writing it to the watermarks store let a
    // peer name a VICTIM and permanently blackhole that victim's real
    // history - setWatermark never regresses and it survives reloads. The
    // ceiling that was tried instead (claim only up to a lamport we already
    // hold from that sender) needed a full-room scan per batch, and batches
    // arrive concurrently in twenties, so a legacy backfill turned into
    // dozens of simultaneous whole-room reads on the main thread.
    //
    // Being in memory bounds the damage but does not make it small: until
    // REFUSED_TTL_MS expires the claim, a forged one is a history blackhole
    // for the sender it names, chosen by the attacker - not "one re-offer".
    // What keeps that tolerable is that it needs the room code (the
    // membership secret) or a DM relationship, it never propagates to another
    // peer's store, it cannot touch live messages, and it expires.
    //
    // Never past a signed-but-unverifiable row from the same sender: that one
    // may still be repaired by a better copy.
    // Never about ourselves. Our own rows come back UNSIGNED from a DM
    // counterparty (the DM envelope carries no signature and the receiver
    // rebuilds the row by hand), so they land in this bucket naming OUR did -
    // and the claim then suppresses our own half of the conversation in every
    // digest we send, including to our own paired devices. That is exactly the
    // reinstall/second-device recovery this code promises, silently broken.
    if (sid === identityStore.did) continue;
    const floor = rejectedFloor.get(sid);
    if (floor === undefined || lamport < floor) {
      _noteRefused(roomCode, sid, lamport);
    }
  }
  if (!verified.length) return;
  // Plugin rows get the same caps coming in as going out: a valid signature
  // proves who wrote the row, not that its payload is within the limits every
  // send path enforces (see _parsePluginPayload). Backfill is a persist path
  // too, so an unusable row is dropped here rather than stored and folded.
  let usable: WireChatMessage[] = [];
  for (const w of verified) {
    const isPlugin =
      w.type === MessageType.PluginCard || w.type === MessageType.PluginUpdate;
    const pluginPayload = isPlugin
      ? _parsePluginPayload(w.type, w.content)
      : null;
    // A LIVE batch is the direct copy of a single live send, so it rides the
    // same per-sender cap as the gossip copy - otherwise wrapping updates in
    // live batches routes straight around it. A repair batch is exempt: a
    // legitimate backfill hands over a room's whole update history at once,
    // and dropping rows there would lose history rather than delay it.
    if (
      live &&
      w.type === MessageType.PluginUpdate &&
      pluginPayload &&
      !_checkUpdateFloodCap(pluginPayload.pluginId, w.senderId)
    ) {
      continue;
    }
    if (isPlugin && !pluginPayload) {
      // Refused for good, so record it - otherwise every peer holding it
      // re-offers it on every repair tick forever. Recorded the same way as
      // the other deterministic rejects above: in memory, via _noteRefused,
      // so it costs no write on the sync path and cannot leapfrog a
      // rejectedFloor for the same sender (a signed-but-unverifiable row from
      // them may still be repaired by a better copy).
      if (
        typeof w.senderId === "string" &&
        w.senderId &&
        Number.isSafeInteger(w.lamport) &&
        w.lamport >= 0
      ) {
        const floor = rejectedFloor.get(w.senderId);
        if (floor === undefined || w.lamport < floor) {
          _noteRefused(roomCode, w.senderId, w.lamport);
        }
      }
      continue;
    }
    usable.push(w);
  }
  if (!usable.length) return;

  // bulkPutMessages puts BY id, so an incoming row whose id we already hold
  // REPLACES that row rather than adding one. A message id is therefore a
  // capability over an existing message, and ids travel in the clear on the
  // wire, so two things have to be refused:
  //
  //  - a different ROOM: the row we hold would be moved into the sender's
  //    room, destroying it where it belongs. A valid signature does not
  //    prevent this for sigV2, whose canonical binds no room.
  //  - a different SENDER: any room member could take the id off one of your
  //    messages, sign a row of their own under it (their own DID, so the
  //    signature verifies honestly) and overwrite yours on every peer that
  //    accepts the batch. Not impersonation - destruction.
  //
  // Re-delivery of the same message by the same sender still overwrites,
  // which is what makes sync idempotent.
  const known = await messageClearFieldsByIds(usable.map((w) => w.id));
  // messageClearFieldsByIds returns blinded roomCode and senderId, so we need
  // to blind the wire values before comparing.
  const blindedRoomCode = await blindValue(roomCode);
  // Blind all wire sender IDs for the comparison; usable may be large.
  const blindedSenderIds = new Map<string, Promise<string>>();
  for (const w of usable) {
    if (!blindedSenderIds.has(w.senderId)) {
      blindedSenderIds.set(w.senderId, blindValue(w.senderId));
    }
  }
  const resolved = new Map<string, string>();
  for (const [did, promise] of blindedSenderIds) {
    resolved.set(did, await promise);
  }
  const hijacks = usable.filter((w) => {
    const held = known.get(w.id);
    if (!held) return false;
    // Compare blinded stored values with blinded wire values.
    const blindedSenderId = resolved.get(w.senderId);
    return held.roomCode !== blindedRoomCode || held.senderId !== blindedSenderId;
  });
  if (hijacks.length) {
    console.warn(
      `[sync] refused ${hijacks.length} message(s) reusing the id of one we already hold`
    );
    rec(
      ev("app.sync.drop", {
        peer: fromPeerId ?? null,
        room: refs().roomRef(roomCode),
        d: { count: hijacks.length, reason: "id-reuse" },
      })
    );
    const refused = new Set(hijacks.map((w) => w.id));
    usable = usable.filter((w) => !refused.has(w.id));
    if (!usable.length) return;
  }

  // Beyond the hijack check: an id we ALREADY hold is never overwritten, even
  // when the room and sender match. The v3 canonical covers the id, sender,
  // lamport, content, reaction, replyTo.id, type and room - but NOT the
  // timestamp, NOT the sender name, NOT a reply snapshot's text and NOT a
  // file's dimensions. So a room member could take a row it holds (yours
  // included), rewrite those, re-push it under the ORIGINAL signature, and
  // have bulkPutMessages replace your copy on every peer that accepted the
  // batch - message-order sorts by timestamp first, so that alone relocates
  // or hides a message for everyone. Signed content cannot legitimately
  // change, so the row we hold is authoritative and re-delivery is a no-op.
  const duplicates = usable.filter((w) => known.has(w.id));
  usable = usable.filter((w) => !known.has(w.id));
  // One thing a re-push CAN legitimately add to a row we already hold: inline
  // attachment bytes, which never reach storage with the row itself. Adopt
  // those before dropping the duplicate - the descriptor they are checked
  // against (infoHash, size) is inside the signature that just verified.
  for (const w of duplicates) {
    stripAndAdoptInlineFiles(wireToMessage(w, roomCode));
  }
  if (!usable.length) return;

  const fullMessages = usable.map((w) => wireToMessage(w, roomCode));

  // Same rule as the live path: inline bytes never reach storage. Adoption
  // also gives synced file messages their attachment records, which the sync
  // path otherwise never creates.
  for (const m of fullMessages) stripAndAdoptInlineFiles(m);

  // Newness has to be read BEFORE the write below, which would otherwise
  // satisfy the lookup.
  //
  // A live batch checks every message. A repair batch checks only the ones that
  // mention me. "Repair never announces" is the right rule for bulk history --
  // syncing a busy room must not fire a hundred notifications -- but a mention
  // you were away for is the one thing you MUST still be told about, and that
  // is exactly the case that used to be silent. Scoping the check to mentions
  // keeps the round trips proportional to mentions, not to the backfill size:
  // the `&&` short-circuits before `getMessage` for everything else.
  const selfIds = _selfIds();
  const unannounced = await Promise.all(
    fullMessages.map(
      async (m) =>
        (live || mentionsMe(m.content ?? "", selfIds)) &&
        !transportState.messages.some((x) => x.id === m.id) &&
        !(await getMessage(m.id))
    )
  );

  await bulkPutMessages(fullMessages);

  // Backfilled plugin updates cannot be folded onto a cached state (the fold
  // order is global, they may sort BEFORE updates already applied) - evict
  // the affected cards so the next render rebuilds from storage.
  {
    const touched = new Set<string>();
    for (const m of fullMessages) {
      if (m.type !== MessageType.PluginUpdate) continue;
      try {
        const cardId = (JSON.parse(m.content) as { cardId?: string }).cardId;
        if (cardId) touched.add(cardId);
      } catch {
        // Malformed content was already survived by validation elsewhere.
      }
    }
    if (touched.size > 0) {
      // cardStates is keyed by cardId alone and holds cards from every room at
      // once (that is why CardStateEntry carries roomCode, and why foldUpdate
      // checks it). Evicting on a cardId parsed out of a peer's payload was a
      // cross-room primitive: any room member could name a card living in a
      // room they are not in and drop its cached state - repeatedly, forcing a
      // full rebuild from storage of a pinned widget or call tile elsewhere.
      // Only an entry built FOR this room may be evicted; where there is no
      // such entry the delete was a no-op anyway.
      for (const cardId of touched) {
        if (cardStates.get(cardId)?.roomCode === roomCode) {
          evictCardState(cardId);
        }
      }
      touchCardStates();
    }
  }

  for (const m of fullMessages) {
    // DM lamports are wall-clock ms; absorbing one would catapult the shared
    // room counter to ~1.7e12 and poison every room message sent after.
    lamportReceive(m.roomCode, m.lamport);
    // A watermark of NaN (or a lamport that arrived as a string) sticks:
    // setWatermark advances on `existing.maxLamport < maxLamport`, and every
    // comparison against NaN is false, so the row can never move again and
    // that sender's history in that room stops being requested for good.
    if (!Number.isSafeInteger(m.lamport) || m.lamport < 0) continue;
    const floor = rejectedFloor.get(m.senderId);
    if (floor === undefined || m.lamport < floor) {
      await setWatermark(m.roomCode, m.senderId, m.lamport);
    }
  }

  refreshUnreadCount(roomCode).catch(() => {});
  for (const m of fullMessages) noteRoomActivity(m.roomCode, m.timestamp);

  // No `live` gate here: `unannounced` already encodes the policy, and it is
  // false for every non-mention in a repair batch.
  fullMessages.forEach((m, i) => {
    if (unannounced[i]) _announceMessage(m);
  });

  // Storage got everything; the view only takes messages for the room that is
  // actually open (the user may have switched while the batch was in flight),
  // and only inside the loaded window - a backfilled message below it would
  // become messages[0] and break the load-older cursor.
  if (transportState.roomCode !== roomCode) return;
  const windowFloor = transportState.messages[0]?.lamport ?? 0;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const fresh = fullMessages.filter((m) => !existingIds.has(m.id));
  if (!fresh.length) return;

  // Anything below the loaded window is backfill: history that arrived late
  // and belongs BEFORE what is on screen. Splicing it in would make it
  // messages[0] and break the load-older cursor - but dropping it, which is
  // what used to happen, left it stored and invisible. The view is only ever
  // re-read from storage by _loadHistory and loadMoreMessages, so nothing
  // brought it back short of a reload. That is the "history does not sync
  // until I ctrl+shift+R" report. Re-read the page instead.
  if (fresh.some((m) => m.lamport < windowFloor)) {
    const page = await getMessages(roomCode);
    if (transportState.roomCode !== roomCode) return;
    // Identity-preserving: a row already on screen keeps its OBJECT, not
    // just its key. The re-read built brand-new objects for every id, so
    // every mounted row saw all its props change and re-rendered - a sync
    // burst repainted the entire visible chat once per batch, which is the
    // flicker. Message rows are immutable once stored (re-delivery writes
    // an identical row), so reuse by id is safe.
    const held = new Map(transportState.messages.map((m) => [m.id, m]));
    const merged = page.map((m) => held.get(m.id) ?? m);
    const seen = new Set(page.map((m) => m.id));
    // Keep anything already on screen that the newest page does not cover
    // (the user may have paged back), so a refill never loses scrollback.
    const kept = transportState.messages.filter(
      (m) => m.roomCode === roomCode && !seen.has(m.id)
    );
    transportState.messages = [...kept, ...merged].sort(MSG_ORDER);
    return;
  }

  transportState.messages = [...transportState.messages, ...fresh].sort(
    MSG_ORDER
  );
}

function _handleSyncComplete(peerId: string, roomCode?: string): void {
  // The room the batch was for, not whatever is on screen. Re-sorting another
  // room's list is pointless, and fanning out a digest for the open room meant
  // a background room that had just synced never told anybody else about it -
  // it healed only via the slow one-room-per-tick rotation.
  const room = roomCode ?? transportState.roomCode;
  if (room && transportState.roomCode === room) {
    // Only when actually out of order: the unconditional sort replaced the
    // array identity on EVERY inbound SyncComplete, re-running the view's
    // derived chain and its autoscroll for nothing.
    const msgs = transportState.messages;
    let sorted = true;
    for (let i = 1; i < msgs.length; i++) {
      if (MSG_ORDER(msgs[i - 1], msgs[i]) > 0) {
        sorted = false;
        break;
      }
    }
    if (!sorted) transportState.messages = [...msgs].sort(MSG_ORDER);
  }
  // Same rule as the repair tick: only members of THAT room may be told it
  // exists. Gossiping a completed sync to every peer leaked the room code to
  // everyone we happened to be connected to.
  // Throttled per room: this fan-out fires on EVERY inbound SyncComplete,
  // including a bare gratuitous one, and each costs one digest per room
  // member - a one-frame-in, N-frames-out amplifier without the window.
  if (!allowSyncReaction(`fanout|${room ?? "*"}`)) return;
  const gossipTo = room
    ? _transport.peersInRoom(room)
    : _transport.peers();
  for (const pid of gossipTo) {
    if (pid === peerId) continue;
    if (room) _sendDigestForRoom(pid, room).catch(() => {});
    else _sendDigest(pid).catch(() => {});
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

// The strip-and-cap rule for a wire display name now lives in wire-name.ts:
// every incoming chat row needs exactly the same treatment (wireToMessage),
// and that path must not import this module - it boots libp2p on import.

async function _handleProfile(peerId: string, msg: WireProfile): Promise<void> {
  // Bind the DID to the peerId only on a signature over THIS connection's
  // peerId. The `did` field on its own is spoofable, and any peer could
  // otherwise claim someone else's identity and hijack their DM conversation
  // or poison their cached profile.
  _stats.profilesIn++;
  const claimed = msg.did;
  const proven =
    claimed &&
    msg.peerId === peerId &&
    msg.bindingSig &&
    (await verifyPeerBinding(claimed, peerId, msg.bindingSig));
  if (!proven) {
    _stats.profilesRejected++;
    rec(ev("app.profile.reject", { peer: peerId, d: { reason: "binding" } }));
    return;
  }
  const did = claimed as string;
  rec(ev("app.profile.in", { peer: peerId }));
  // A proven peerId->DID binding is the only thing allowed to group two
  // peerIds under one identity ordinal - see the recorder's own warning.
  noteIdentity(peerId, did);
  const isNewMapping = _peerIdToDid.get(peerId) !== did;
  _setPeerDid(peerId, did);

  // Queued DMs are keyed by DID, and the "connect" event fires before we
  // know the peer's DID - so the real flush happens here, once the profile
  // (and with it the DID) has arrived.
  if (isNewMapping) {
    flushQueuedDmForPeer(peerId).catch(() => {});
    _replayPendingDm(peerId, did);
  }

  // Answer with everything about our current state, on EVERY profile we did
  // not ourselves provoke - not only when the mapping is new.
  //
  // Device keys are stable, so a peer that reloads comes back with the same
  // peerId and the mapping looks unchanged to us. Keying the reply on novelty
  // meant the reloaded side never heard back: connected, but with no idea who
  // anyone is, no names, no presence and no history.
  if (!msg.reply) {
    _sendProfile(peerId, true);
    _sendCallFramesTo(peerId);
  }
  // Reconcile history with them either way; debounced, so a burst is one.
  _syncPeer(peerId);

  const avatarUrl = normalizeAvatarUrl(msg.avatarUrl);
  // `color` absent = older build, which has no such field - keep any cached
  // color. Explicit null (or junk that fails sanitizing) = "no color".
  const hasColorField = msg.color !== undefined;
  const color = hasColorField ? normalizeNicknameColor(msg.color) : undefined;
  const name = normalizeWireName(msg.name);

  const names = new Map(transportState.peerNames);
  names.set(did, name);
  transportState.peerNames = names;

  const avatars = new Map(transportState.peerAvatars);
  if (avatarUrl) avatars.set(did, avatarUrl);
  else avatars.delete(did);
  transportState.peerAvatars = avatars;

  if (hasColorField) {
    const colors = new Map(transportState.peerColors);
    if (color) colors.set(did, color);
    else colors.delete(did);
    transportState.peerColors = colors;
  }

  // Validate and store profile metadata
  const validated = validateProfileMeta({
    bannerUrl: msg.bannerUrl,
    gradient2: msg.gradient2 ?? undefined,
    gradient3: msg.gradient3 ?? undefined,
    tagText: msg.tagText,
    tagTextColor: msg.tagTextColor,
    tagChipColor: msg.tagChipColor,
    bio: msg.bio,
    nameEffect: msg.nameEffect,
    nameShimmer: msg.nameShimmer,
    nameGlow: msg.nameGlow,
  });

  if (Object.keys(validated).length > 0) {
    const meta = new Map(transportState.peerProfileMeta);
    meta.set(did, validated);
    transportState.peerProfileMeta = meta;
  } else {
    const meta = new Map(transportState.peerProfileMeta);
    meta.delete(did);
    transportState.peerProfileMeta = meta;
  }

  // NEVER write over our own row. Profiles are keyed by did and getOwnProfile
  // finds the one flagged isMe, so a peer profile stored under our own did
  // replaces it with isMe:false and their name and avatar - and our identity
  // silently disappears on the next reload.
  //
  // The peer that legitimately carries our did is our OWN other device: the
  // restore key gives it the same identity, its device key gives it a
  // different peerId, and it can sign a perfectly valid binding for it. So
  // this is not an attack to be rejected, it is a normal thing to ignore.
  if (did === (identityStore.did ?? "")) return;

  getPeerProfile(did)
    .then((existing) =>
      putPeerProfile({
        did,
        isMe: false,
        nickname: name,
        pfpURL: avatarUrl,
        updatedAt: Date.now(),
        color: hasColorField ? (color ?? undefined) : existing?.color,
        bannerURL: validated.bannerUrl,
        gradient2: validated.gradient2,
        gradient3: validated.gradient3,
        tagText: validated.tagText,
        tagTextColor: validated.tagTextColor,
        tagChipColor: validated.tagChipColor,
        bio: validated.bio,
        nameEffect: validated.nameEffect,
        nameShimmer: validated.nameShimmer,
        nameGlow: validated.nameGlow,
        ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
      }).catch(() => {})
    )
    .catch(() => {});
}

/** Chime when somebody else joins or leaves the call we are sitting in. */
function _peerCallSound(
  room: string | undefined,
  nowInCall: boolean,
  wasInCall: boolean
): void {
  const chime = peerCallChime({
    imInCall: transportState.inCall,
    myCallRoom: transportState.callRoomCode,
    room,
    wasInCall,
    nowInCall,
  });
  if (chime === "join") playPeerJoinSound();
  else if (chime === "leave") playPeerLeaveSound();
}

/** One viewer watches at most one share; a new announcement replaces it. */
export function _handleWatchPresence(
  viewerPeerId: string,
  watching: string | null
): void {
  const next = new Map<string, Set<string>>();
  for (const [sharer, viewers] of transportState.transmissionViewers) {
    const copy = new Set(viewers);
    copy.delete(viewerPeerId);
    if (copy.size > 0) next.set(sharer, copy);
  }
  // REMOVING always runs - the disconnect handler clears a departing peer
  // through here. ADDING does not: this frame was applied for any peer that
  // could reach us, naming any string as the peer being watched, so a
  // stranger could plant themselves in someone's viewer chip and grow this
  // map with junk keys. A viewer has to be somebody call presence already
  // places in a room the relay agrees they are in, and the value it names
  // has to look like a peerId rather than arbitrary text.
  const theirRoom = transportState.callPeerRooms.get(viewerPeerId);
  const admitted =
    !!theirRoom && _transport.isRoomPeer(theirRoom, viewerPeerId);
  if (watching && admitted && looksLikePeerId(watching)) {
    const set = new Set(next.get(watching) ?? []);
    set.add(viewerPeerId);
    next.set(watching, set);
  }
  transportState.transmissionViewers = next;
}

/**
 * When a call-roster entry was last confirmed alive: presence or call-state
 * heard, or the peer's voice link actually up. Entries older than the TTL
 * are ghosts (wedged app, backgrounded PWA whose leave never arrived) and
 * get swept by the repair tick.
 */
const _callPeerSeen = new Map<string, number>();
const CALL_PRESENCE_TTL_MS = 60_000;

function _handleCallPresence(
  peerId: string,
  inCall: boolean,
  roomCode?: string
): void {
  const next = new Set(transportState.callPeerIds);
  const roomNext = new Map(transportState.callPeerRooms);
  const wasInCall = next.has(peerId);
  const theirRoom = roomNext.get(peerId);

  if (
    inCall &&
    roomCode &&
    _transport.rooms().includes(roomCode) &&
    // ...and the SENDER has to be in that room too. Only OUR membership was
    // ever checked, so any peer that could reach us could claim to be in a
    // call in a room they are not in, land in callPeerRooms, and be handed
    // straight to _voice.setCallPeers - whose whole admission rule is that
    // roster. That is an outsider's offer accepted and our microphone
    // attached to it. Relay-attested membership, deliberately NOT
    // intersected with the connection list: a presence frame legitimately
    // reaches us through the gossip mesh from a member we have not dialled,
    // which is exactly the case the dialNow below exists for.
    _transport.isRoomPeer(roomCode, peerId)
  ) {
    // Membership-gated like the handlers above: "in a call" for a room we
    // never joined is unverifiable noise - at best meaningless, at worst a
    // fake ring sound from any connected peer.
    next.add(peerId);
    roomNext.set(peerId, roomCode);
    _callPeerSeen.set(peerId, Date.now());
    _peerCallSound(roomCode, true, wasInCall);
  } else {
    _callPeerSeen.delete(peerId);
    next.delete(peerId);
    roomNext.delete(peerId);
    _peerCallSound(theirRoom, false, wasInCall);

    const parts = new Map(transportState.participants);
    parts.delete(peerId);
    transportState.participants = parts;

    const txNext = new Map(transportState.pendingTransmissions);
    txNext.delete(peerId);
    transportState.pendingTransmissions = txNext;

    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
    }

    const callStateNext = new Map(transportState.callPeerStates);
    callStateNext.delete(peerId);
    transportState.callPeerStates = callStateNext;
  }

  transportState.callPeerIds = next;
  transportState.callPeerRooms = roomNext;
  // Somebody in OUR call that we have no peer connection to is the one case
  // worth jumping the dial backoff for: no connection means no voice link, and
  // the presence frame we just handled may have come the long way round via
  // gossipsub rather than from them directly.
  if (
    inCall &&
    transportState.inCall &&
    roomCode === transportState.callRoomCode &&
    !_transport.peers().includes(peerId)
  ) {
    _transport.dialNow(peerId);
  }
  _syncVoiceRoster();
}

/**
 * Tell the voice layer who it should have a link with: everyone whose call
 * presence puts them in OUR call's room. The voice layer cannot work this out
 * itself - it only sees libp2p connections, which say nothing about who is in
 * a call - and without it, a link was only ever created on a connect event,
 * so joining a call over an already-open connection silently got no audio.
 */
export function _syncVoiceRoster(): void {
  const room = transportState.callRoomCode;
  if (!transportState.inCall || !room) {
    _voice.setCallPeers([]);
    return;
  }
  const peers: string[] = [];
  for (const [peerId, theirRoom] of transportState.callPeerRooms) {
    if (theirRoom === room) peers.push(peerId);
  }
  _voice.setCallPeers(peers);
  // Same roster, same moment: the SFU's producer announcements are gated on
  // it too, and presence routinely lands after the announcement it admits.
  _video.retryDeferredProducers();
}

function _handleCallState(peerId: string, msg: WireCallState): void {
  // Same membership rule as _handleCallPresence, which is what fills
  // callPeerRooms in the first place: a mute/deafen badge belongs to somebody
  // already known to be in a call in a room the relay places them in.
  // Applying it to any peerId that sent one let a stranger paint badges and
  // grow this map, and refreshed the TTL that sweeps roster ghosts.
  const theirRoom = transportState.callPeerRooms.get(peerId);
  if (!theirRoom || !_transport.isRoomPeer(theirRoom, peerId)) return;
  _callPeerSeen.set(peerId, Date.now());
  const next = new Map(transportState.callPeerStates);
  next.set(peerId, {
    muted: !!msg.muted,
    deafened: !!msg.deafened,
  });
  transportState.callPeerStates = next;
}

function _handleRoomName(msg: WireRoomName, room: string | null): void {
  // The AUTHENTICATED pubsub topic wins over anything in the message body.
  // A direct send (legit: _sendRoomName welcomes a fresh joiner) may only
  // name a room we have actually joined - same rule as _handleDigest, or a
  // peer we merely DM with could rename any room by naming its code.
  const target = room ?? msg.roomCode;
  if (!target) return;
  if (room === null && !_transport.rooms().includes(target)) return;
  const trimmed = msg.name.trim().slice(0, 64);
  if (!trimmed) return;
  // A peer that joined from a bare invite link has no name yet and sends the
  // room code as a placeholder. Accepting it would overwrite the real name for
  // everyone in the room.
  if (trimmed === target) return;
  renameRoom(target, trimmed).catch(() => {});
  if (target === transportState.roomCode) transportState.roomName = trimmed;
}

/**
 * A peer may only announce ITSELF. `claimedDid` arrives in the message body,
 * which anybody in the room can write, so it is checked against the DID bound
 * to the authenticated connection it came in on. Without that check a peer
 * could evict anyone from everyone else's member list (see _handleLeaveRoom),
 * which is why REMOVAL demands it and addition does not.
 */
function _isSelfAnnouncement(fromPeerId: string, claimedDid: string): boolean {
  if (!claimedDid) return false;
  const senderDid = _peerIdToDid.get(fromPeerId);
  return !!senderDid && senderDid === claimedDid;
}

function _admitRoomMember(room: string, did: string): void {
  if (room !== transportState.roomCode) {
    // Another room we are subscribed to: record it, but do not touch the
    // member list on screen.
    addRoomParticipant(room, did).catch(() => {});
    return;
  }
  const uniqueUsers = [...new Set(transportState.roomUsers)];
  if (!uniqueUsers.includes(did)) {
    uniqueUsers.push(did);
    transportState.roomUsers = uniqueUsers;
    addRoomParticipant(room, did).catch(() => {});
  }
}

function _handleJoinRoom(
  fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!claimedDid) return;
  // A shape check, deliberately NOT a self-announcement check.
  //
  // Demanding one (holding an unbound sender's join until their Profile
  // landed) closed nothing, because _handleRoomUsersSync accepts a whole
  // ARRAY of foreign DIDs from any connected peer for any room we have
  // joined, persists them, and merges them into the on-screen roster. The
  // same entry is one message away either way, and there is nothing to close
  // it with: presence here is peer-gossiped, and a third party's membership
  // carries no proof we could verify. What it did cost was visible - a join
  // usually arrives before the sender's Profile has bound their DID, and
  // _handleLeaveRoom drops that binding outright, so a peer switching rooms
  // and coming back sat invisible until the next profile exchange, which the
  // repair tick only forces every 15s. Presence latency for no security.
  //
  // The roster is still not free-for-all: LeaveRoom (which REMOVES people)
  // demands a self-announcement, entries have to look like an identity, and
  // _broadcastChatWire hands a peer a direct copy only when the connection
  // they are on is bound to a DID that is in the roster - so a fabricated
  // entry reaches nobody until that identity actually connects.
  if (!looksLikeDid(claimedDid) && !looksLikePeerId(claimedDid)) return;
  _admitRoomMember(room, claimedDid);
  // The roster only went out on connect, so a peer switching into this room
  // over connections that were already up saw nobody but themselves until
  // the next connect. Answer the join with who is here.
  _sendRoomUsers(fromPeerId, room).catch(() => {});
}

/**
 * Explicit leave: drop the user from the member list and from storage. This is
 * the only thing that removes somebody - going offline must not, or a peer that
 * closed their laptop would vanish instead of showing as offline.
 */
function _handleLeaveRoom(
  fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!_isSelfAnnouncement(fromPeerId, claimedDid)) return;
  removeRoomParticipant(room, claimedDid).catch(() => {});
  if (room === transportState.roomCode) {
    const currentUsers = new Set(transportState.roomUsers);
    if (currentUsers.has(claimedDid)) {
      currentUsers.delete(claimedDid);
      transportState.roomUsers = [...currentUsers];
    }
  }
  // Keyed by the libp2p peerId, not the DID: deleting claimedDid here was a
  // no-op and left the mapping behind.
  _peerIdToDid.delete(fromPeerId);
  transportState.peerDidVersion += 1;
}

// A room's participant list is presence metadata, not a security boundary,
// but a peer must not be able to grow it without bound or stuff it with junk.
const MAX_ROOM_USERS = 512;

function _handleRoomUsersSync(
  msg: WireRoomUsersSync,
  room: string | null
): void {
  // Same trust rule as _handleRoomName: the topic is authenticated, the
  // body is not, and a direct send may only describe a room we joined -
  // otherwise any connected peer could stuff fabricated members into an
  // arbitrary room's list (and its persisted participants).
  const roomCode = room ?? msg.roomCode;
  if (!roomCode) return;
  if (room === null && !_transport.rooms().includes(roomCode)) return;
  const participants = msg.participants;
  if (!Array.isArray(participants)) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const valid = participants.filter(
    (p) => typeof p === "string" && (looksLikeDid(p) || looksLikePeerId(p))
  );
  rec(
    ev("app.roomusers", {
      room: refs().roomRef(roomCode),
      d: { count: valid.length },
    })
  );
  if (roomCode !== transportState.roomCode) {
    // A list for a room we are subscribed to but not looking at. Persist it,
    // but leave the on-screen member list alone - merging it in was how one
    // room's members ended up listed in another.
    for (const did of valid.slice(0, MAX_ROOM_USERS)) {
      addRoomParticipant(roomCode, did).catch(() => {});
    }
    return;
  }
  const known = new Set(transportState.roomUsers);
  const merged = new Set([...known, ...valid]);
  if (selfDid) merged.add(selfDid);
  const next = [...merged].slice(0, MAX_ROOM_USERS);
  transportState.roomUsers = next;

  // Persist whoever is new to us. Only a JoinRoom announcement used to be
  // written down, and you only receive that if you were already in the room
  // when they joined - so everybody who was there before you lived in memory
  // alone and disappeared from the member list on your next reload. Existing
  // entries are left untouched so this does not keep resetting their
  // inactivity window.
  for (const did of next) {
    if (!known.has(did)) addRoomParticipant(roomCode, did).catch(() => {});
  }
}

function _broadcastJoinRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  const roomCode = transportState.roomCode;
  if (!selfDid || !roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.JoinRoom, peerId: selfDid }),
    roomCode
  );
  rec(ev("app.join", { room: refs().roomRef(roomCode) }));
}

function _broadcastLeaveRoom(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  const roomCode = transportState.roomCode;
  if (!selfDid || !roomCode) return Promise.resolve();
  rec(ev("app.leave", { room: refs().roomRef(roomCode) }));
  return _transport.broadcast(
    encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
    roomCode
  );
}

/**
 * Authenticate an incoming chat message. Signatures are MANDATORY: an
 * unsigned message let any connected peer claim any senderId. The one
 * exemption is `allowUnsigned`, which sync passes for a DM conversation
 * relayed by its authenticated counterparty - mirrored DM rows are
 * legitimately unsigned (their authenticity came from the encrypted
 * envelope when they first arrived). Pre-signing room history no longer
 * relays; local copies are untouched, and the rejectedFloor machinery in
 * _handleSyncBatch keeps watermarks honest about what was refused.
 */
const _verifyIncoming = verifyIncoming;

/** Every id that means "me". Shared so the announce and mention checks agree. */
function _selfIds(): string[] {
  return [identityStore.did ?? "", _transport.selfId()];
}

/**
 * Bind an incoming message to this client's identity and view, then let
 * announce.ts decide whether to make a sound about it. The caller has already
 * established that the message is genuinely new.
 */
function _announceMessage(
  msg: Message,
  opts: { viaMailbox?: boolean } = {}
): void {
  announceMessage(
    msg,
    {
      selfIds: _selfIds(),
      uiRoomCode: transportState.uiRoomCode,
      resolveName: resolveMentionDisplayName,
    },
    opts
  );
}

async function _handleChatMessage(
  wire: WireChatMessage,
  roomCodeOverride?: string,
  receivedFromPeerId?: string
): Promise<void> {
  // Never guess the room from what is on screen: an echoed or replayed
  // frame arriving without attribution would be filed - and PERSISTED -
  // into whichever room the user happens to be viewing.
  const roomCode = roomCodeOverride;
  if (!roomCode) return;
  if (!roomCode) return;

  // DM rooms now start with "dm-" (hash-based)
  // We don't need to ensure room here - it should already exist from sender context

  // Plugin caps apply on the way IN, not only where we send. This path
  // persists the row (putMessage, below) and hands its payload to a reducer,
  // and until now it did both after nothing more than a truthiness check: a
  // signature proves who wrote the row, never that its pluginId is one the
  // registry knows or that its payload is anywhere near the 16 KB / 4 KB
  // limits every send path enforces. See _parsePluginPayload.
  const isPluginRow =
    wire.type === MessageType.PluginCard ||
    wire.type === MessageType.PluginUpdate;
  const pluginPayload = isPluginRow
    ? _parsePluginPayload(wire.type, wire.content)
    : null;
  if (isPluginRow && !pluginPayload) {
    console.warn(
      "[plugins] dropped an incoming plugin message that failed validation from",
      wire.senderId
    );
    return;
  }
  // The flood cap covered ephemerals only, so persisted updates - which cost
  // strictly more (a store, a watermark, a fold) - were unlimited. Dropped
  // rather than stored: nothing here claims a watermark for it, so a row
  // wrongly caught by the window is still recoverable through history repair.
  if (
    wire.type === MessageType.PluginUpdate &&
    pluginPayload &&
    !_checkUpdateFloodCap(pluginPayload.pluginId, wire.senderId)
  ) {
    return;
  }

  // Per room, so a DM's wall-clock lamport can no longer be absorbed into a
  // chat room's counter - which it was, unguarded, on this path.
  lamportReceive(roomCode, wire.lamport);

  const msg = wireToMessage(wire, roomCode);

  // A sender's lamport only ever moves forward, so a jump past what we have
  // from them means we probably missed something. It is a hint, not proof -
  // the clock also advances on receives - but a digest is small and answering
  // one costs nothing, so erring towards syncing is the cheap side.
  if (receivedFromPeerId) {
    const seen = _lastSeenLamport.get(`${roomCode}|${msg.senderId}`) ?? -1;
    // Force past the debounce: a detected gap is the strongest signal we get,
    // and a routine profile exchange must not be allowed to consume the window
    // and swallow it.
    if (seen >= 0 && msg.lamport > seen + 1)
      _syncPeer(receivedFromPeerId, true);
    if (msg.lamport > seen) {
      _lastSeenLamport.set(`${roomCode}|${msg.senderId}`, msg.lamport);
    }
  }

  // Inline bytes are wire-only: out before the message is stored or shown,
  // adopted (verify/persist/seed) in the background.
  stripAndAdoptInlineFiles(msg);

  // The in-memory list holds only the open room's newest page; a replayed
  // message from a background room would always look "new" and re-notify.
  // Decided BEFORE the put below, which would otherwise satisfy the lookup.
  const isNewMessage =
    !transportState.messages.some((m) => m.id === msg.id) &&
    !(await getMessage(msg.id));

  // Only a genuinely new message is written: re-putting a replayed one
  // would overwrite the stored row with this handler's view of it.
  // Await the write before claiming it. Fire-and-forget put plus an
  // unconditional watermark meant a failed write (quota, blocked upgrade) lost
  // the message AND told every future digest we already had it, so nobody
  // would ever send it again.
  if (isNewMessage) {
    try {
      await putMessage(msg);
    } catch (err) {
      console.warn("[chat] store failed, not claiming the message:", err);
      return;
    }
  }

  // Incoming persisted plugin updates fold into card state HERE - the only
  // folds used to be ephemerals and our own sends, so other people's votes
  // and spins sat in storage until a refresh rebuilt the card.
  if (isNewMessage && msg.type === MessageType.PluginUpdate) {
    try {
      // Already parsed and validated above; re-parsing here would have meant
      // the fold ran against a shape the gate never saw.
      const payload = pluginPayload;
      if (payload?.pluginId && payload.cardId) {
        const { getPlugin } = await import("../plugins/registry");
        const plugin = await getPlugin(payload.pluginId);
        if (plugin) {
          foldUpdate(payload.cardId, plugin, {
            id: msg.id,
            senderId: msg.senderId,
            senderDid: msg.senderDid,
            senderName: msg.senderName,
            lamport: msg.lamport,
            data: payload.data,
            // msg.roomCode is topic-derived (wireToMessage), never payload.
            roomCode: msg.roomCode,
          });
        }
        touchCardStates();
      }
    } catch (err) {
      console.warn("[plugins] failed to fold incoming update:", err);
    }
  }
  // Same rule as the sync path: a NaN watermark can never be advanced past
  // (every comparison against it is false), so it would silently retire that
  // sender's history in this room.
  if (Number.isSafeInteger(msg.lamport) && msg.lamport >= 0) {
    setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  }
  refreshUnreadCount(msg.roomCode).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);

  // DM rooms now start with "dm-" (hash-based format)
  if (isNewMessage && msg.roomCode.startsWith("dm-")) {
    transportState.dmVersion += 1;
  }

  if (isNewMessage) _announceMessage(msg);

  // Match on the open room, not the mode: DM file messages arrive through
  // this path too, and the mode check kept them invisible until reopen.
  if (isNewMessage && transportState.roomCode === msg.roomCode) {
    transportState.messages = appendSorted(transportState.messages, msg);
  }

  if (msg.type !== MessageType.File || !msg.meta?.files?.length) return;

  const seederPeerId =
    receivedFromPeerId ?? maybePeerIdFromSenderId(msg.senderId) ?? null;

  if (isNewMessage) {
    getAttachmentsByMessage(msg.id)
      .then((existing) => {
        if (existing.length > 0) return;
        const now = Date.now();
        return Promise.all(
          msg.meta!.files.map((file) =>
            putAttachment({
              id: crypto.randomUUID(),
              roomCode: msg.roomCode,
              messageId: msg.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
              infoHash: file.infoHash,
              width: file.width,
              height: file.height,
              status: "pending",
              createdAt: now,
            })
          )
        );
      })
      .catch(() => {});
  }

  for (const file of msg.meta.files) {
    if (seederPeerId) {
      _fileTransport.registerSeeder(file, seederPeerId);
    }
    // Size passed too: auto-download is on by default, so this is a fetch
    // nobody asked for and it needs a ceiling (see AUTO_DOWNLOAD_MAX_BYTES).
    if (shouldAutoDownload(file.mimeType, file.size)) {
      _fileTransport.ensureDownload(file);
    } else {
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 1,
      });
    }
  }
}

// ── Transport events ──────────────────────────────────────────────────────────

_transport.on("status", (status) => {
  switch (status.type) {
    case "relay-connected":
      transportState.relayConnected = true;
      // A reconnect is a second chance at everything the mailbox holds: the
      // collector's own timer is five minutes, and the DM that was waiting
      // is the reason the relay came back at all.
      void import("./mailbox.svelte")
        .then((m) => m.collectMailbox())
        .catch(() => {});
      break;
    case "relay-disconnected":
    case "relay-dial-failed":
    case "relay-reconnecting":
    case "relay-reconnect-failed":
      transportState.relayConnected = false;
      break;
    case "relay-reservation-failed":
      // Dialled, but with no circuit nobody can reach us - and libp2p's
      // relay filter stays poisoned for the life of this node, so only a
      // fresh node recovers. connect() builds one.
      transportState.relayConnected = false;
      connect().catch(() => {});
      break;
    case "mic-unavailable":
      transportState.micUnavailable = true;
      setErrorWithAutoClear(transportState, status.message);
      break;
    case "mic-available":
      transportState.micUnavailable = false;
      break;
  }
});

// Membership just became known for a room, so history can be reconciled with
// the peers in it. Digests are gated on membership (a room code is the room's
// only secret), and a peer we were already connected to fires no connect
// event, so this is the only prompt for the common "join a room while the
// connections are already up" case.
_transport.on("roomPeers", (room, peerIds) => {
  if (!_transport.rooms().includes(room)) return;
  for (const pid of peerIds) {
    // The other half of the connect handler's gate. Everything there that
    // names a room code is refused for a peer the relay had not yet placed
    // in the room, and "connect" never fires again for a peer we are already
    // connected to - so without this a peer who arrived before the relay's
    // PEERS reply never learned the room's name, never saw its roster, and
    // never heard about a call in it. All three handlers are idempotent, so
    // repeating them when the relay re-lists a peer costs a few small frames.
    _sendRoomName(pid);
    _sendCallFramesTo(pid);
    _sendRoomUsers(pid, room).catch(() => {});
    if (!_peerIdToDid.has(pid)) continue;
    const did = _peerIdToDid.get(pid);
    if (!did) continue;
    // Record that this participant is seen now. addRoomParticipant handles both
    // new additions and updating the timestamp for existing participants.
    addRoomParticipant(room, did).catch(() => {});
    _sendDigestForRoom(pid, room).catch(() => {});
  }
});

_transport.on("relayChanged", (peerId, relayed) => {
  // A new Set, not a mutation: $state does not deep-proxy a Set, so .add on
  // the existing one updates the data and notifies nothing.
  const next = new Set(transportState.relayedPeers);
  if (relayed) next.add(peerId);
  else next.delete(peerId);
  transportState.relayedPeers = next;
});

// A peer's own connection can report "open" while nothing it carries ever
// arrives - streamProven/streamLost are the only signal that a frame
// actually got through. transportState.peers keeps meaning "libp2p holds a
// connection"; provenPeers is the separate, narrower claim.
_transport.on("streamProven", (peerId) => {
  const next = new Set(transportState.provenPeers);
  next.add(peerId);
  transportState.provenPeers = next;
});

_transport.on("streamLost", (peerId) => {
  const next = new Set(transportState.provenPeers);
  next.delete(peerId);
  transportState.provenPeers = next;
});

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  // The DID cannot be derived from the peerId any more (devices carry their
  // own libp2p keys); it arrives with the signed binding in the Profile.
  flushQueuedDmForPeer(peerId).catch(() => {});
  _fileTransport.onPeerConnect(peerId);
  // Covers a reconnect, where the DID mapping already exists and _setPeerDid
  // short-circuits.
  _announceStoredFilesTo(peerId).catch(() => {});
  _sendProfile(peerId);
  // Everything below is membership-gated inside the sender (a room code is
  // the room's only join secret and this event fires for any peer that dials
  // us). A peer that connects BEFORE the relay lists them in the room gets
  // nothing here; the "roomPeers" handler is what catches them up.
  _sendRoomName(peerId);
  _sendCallFramesTo(peerId);
  _sendDigest(peerId);
  if (transportState.roomCode) {
    _sendRoomUsers(peerId, transportState.roomCode).catch(() => {});
  }
});

/**
 * Hand a peer one room's roster: the on-screen list for the room on screen,
 * the persisted list for any other room we are subscribed to.
 */
async function _sendRoomUsers(
  peerId: string,
  roomCode: string
): Promise<void> {
  // The roster frame carries its roomCode, so it is gated exactly like a
  // digest: only somebody the relay already places in that room may be told
  // the room exists. This went out on every "connect", which fires for any
  // peer that dials us - so it handed out the join secret AND the member
  // list to strangers.
  if (!_transport.peersInRoom(roomCode).includes(peerId)) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const known =
    roomCode === transportState.roomCode
      ? transportState.roomUsers
      : await getRoomParticipants(roomCode);
  const participants = [...new Set([...known, selfDid])];
  _transport.send(
    peerId,
    encode({ type: MessageType.RoomUsersSync, participants, roomCode })
  );
}

_transport.on("disconnect", (peerId) => {
  // The transport drops its own entry on disconnect without announcing it,
  // so prune the mirror here or a peer who left while relayed comes back
  // wearing the badge before the first connection:open re-decides.
  if (transportState.relayedPeers.has(peerId)) {
    const next = new Set(transportState.relayedPeers);
    next.delete(peerId);
    transportState.relayedPeers = next;
  }
  const did = peerIdToDid(peerId);
  _lastAppInbound.delete(peerId);
  _profileRepair.delete(peerId);
  _profileEcho.forget(peerId);
  // Same lifetime as the two above, and it was not being pruned. Deliberately
  // NOT _pendingDmByPeer: those are DMs already delivered to us and held only
  // until the sender's DID binds, so dropping them on a disconnect would throw
  // away messages that a reconnect would otherwise replay.
  _lastDigestAt.delete(peerId);
  transportState.peers = _transport.peers();
  for (const listener of _peerDisconnectListeners) listener({ did });
  _fileTransport.onPeerDisconnect(peerId);

  // Note: We intentionally do NOT delete the peerId->DID mapping here.
  // The mapping is kept so we can still identify which DID a peerId
  // belonged to for offline user tracking. The mapping is only removed
  // when we receive an explicit LeaveRoom message.

  const parts = new Map(transportState.participants);
  parts.delete(peerId);
  transportState.participants = parts;

  // Gone peers neither watch nor share.
  _handleWatchPresence(peerId, null);
  if (transportState.transmissionViewers.has(peerId)) {
    const viewers = new Map(transportState.transmissionViewers);
    viewers.delete(peerId);
    transportState.transmissionViewers = viewers;
  }

  // A peer that drops out never sends a leave, so the chime belongs here too.
  const calls = new Set(transportState.callPeerIds);
  _peerCallSound(
    transportState.callPeerRooms.get(peerId),
    false,
    calls.has(peerId)
  );
  calls.delete(peerId);
  transportState.callPeerIds = calls;

  // The roster too: every other call map is cleaned here, and a stale entry
  // kept the status stuck at "Connecting x/y" after someone dropped out.
  const callRoomsNext = new Map(transportState.callPeerRooms);
  callRoomsNext.delete(peerId);
  transportState.callPeerRooms = callRoomsNext;
  _syncVoiceRoster();

  const callStates = new Map(transportState.callPeerStates);
  callStates.delete(peerId);
  transportState.callPeerStates = callStates;

  const txNext = new Map(transportState.pendingTransmissions);
  txNext.delete(peerId);
  transportState.pendingTransmissions = txNext;

  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
  }
});

/**
 * An incoming DM, once we know who sent it.
 *
 * Split out of the message handler so a frame that arrived before the sender's
 * DID was bound can be replayed through exactly the same path.
 */
/**
 * Deliver a DM that arrived via the relay MAILBOX instead of a live stream.
 * The sender is offline, so there is no peerId - the did stands in for it,
 * which every downstream helper already tolerates (room codes hash DIDs,
 * display names resolve DIDs). Authenticity was verified by the mailbox
 * crypto (sender signature over the envelope, bound to us); the stream
 * path's transport-level binding plays no part here.
 */
export function deliverMailboxDm(
  senderDid: string,
  payload: DmPayload
): Promise<void> {
  // AWAITABLE on purpose: the mailbox collector must not ack (= delete the
  // relay's only copy) until the local write actually settled - a locked
  // identity mid-drain throws here instead of vanishing the message.
  return _handleDmChatAsync(senderDid, senderDid, { payload }, true);
}

/**
 * A DM SyncBatch that came out of the mailbox: files, plugin cards and
 * plugin updates, which ride the room topic rather than the DM envelope.
 *
 * The room is derived from BOTH DIDs and compared against what the batch
 * claims, so a blob sealed by one peer cannot file history into another
 * conversation. Everything past that is _handleSyncBatch's usual contract:
 * sigV3 verification per row, refusal of rooms we have not joined, dedup
 * against storage.
 */
export async function deliverMailboxBatch(
  senderDid: string,
  data: Uint8Array
): Promise<void> {
  const decoded = decode(data) as {
    type?: string;
    roomCode?: string;
    messages?: WireChatMessage[];
    live?: boolean;
  };
  if (decoded?.type !== MessageType.SyncBatch) return;
  if (!Array.isArray(decoded.messages)) return;
  const roomCode = await dmConversationCodeAsync(senderDid).catch(() => null);
  if (!roomCode || roomCode !== decoded.roomCode) return;
  // The batch handler refuses a room we have not joined, and a conversation
  // whose first contact arrives through the mailbox has never been joined.
  await ensureDmRoomForPeer(senderDid);
  _transport.joinRoom(roomCode);
  await _handleSyncBatch(
    roomCode,
    decoded.messages,
    senderDid,
    decoded.live === true
  );
}

/**
 * A delivery or read receipt collected from the mailbox.
 *
 * The mailbox crypto already proved WHO sent it; the room check below is the
 * same rule the live path applies - a receipt is only meaningful for a
 * message living in the DM room derived from that sender's DID.
 */
export async function deliverMailboxReceipt(
  senderDid: string,
  envelope:
    | { type: "ack"; messageId: string }
    | { type: "read"; messageIds: string[] }
): Promise<void> {
  const ids =
    envelope.type === "ack" ? [envelope.messageId] : envelope.messageIds;
  const acceptable = await _receiptsForDmWith(senderDid, ids);
  if (!acceptable.length) return;
  for (const id of acceptable) {
    applyMessageStatus(id, envelope.type === "ack" ? "delivered" : "read");
  }
  if (envelope.type === "read") await _cascadeReadAcks(senderDid, acceptable);
}

/** Deposit a receipt for a peer who is not on a stream - the mailbox path,
 *  where there is no peerId to reply on at all. */
function _depositDmReceipt(senderDid: string, envelope: Uint8Array): void {
  depositDmReceipt(senderDid, envelope).catch(() => {});
}

function _handleDmChat(
  peerId: string,
  senderDid: string,
  envelope: { payload: DmPayload }
): void {
  void _handleDmChatAsync(peerId, senderDid, envelope).catch(console.error);
}

function _handleDmChatAsync(
  peerId: string,
  senderDid: string,
  envelope: { payload: DmPayload },
  /**
   * This arrived from the relay mailbox, so `peerId` is the sender's DID
   * standing in for a stream that does not exist. Passed explicitly rather than
   * inferred from `peerId === senderDid`: that coincidence is not a contract,
   * and getting it wrong emits a user-visible error.
   */
  viaMailbox = false
): Promise<void> {
  return (async () => {
    const roomCode = await ensureDmRoomForPeer(peerId);
    if (!roomCode) return;
    _transport.joinRoom(roomCode);

    const reaction = envelope.payload.reaction;
    // DM lamports are wall-clock milliseconds, and this one is whatever the
    // envelope said. It is written to a watermark below, and setWatermark
    // never regresses - so a single message claiming a lamport far in the
    // future would tell every later digest that we already hold the rest of
    // this conversation, and the sender's real messages would never be
    // offered again. Anything outside a day's skew is not a clock, it is a
    // claim: fall back to the timestamp, and to now if that is junk too.
    const wireTs = envelope.payload.ts;
    const ts =
      Number.isSafeInteger(wireTs) &&
      wireTs > 0 &&
      wireTs <= Date.now() + MAX_DM_LAMPORT_SKEW
        ? wireTs
        : Date.now();
    const wireLamport = envelope.payload.lamport;
    const lamport =
      wireLamport !== undefined &&
      Number.isSafeInteger(wireLamport) &&
      wireLamport >= 0 &&
      wireLamport <= Date.now() + MAX_DM_LAMPORT_SKEW
        ? wireLamport
        : ts;
    const msg: Message = {
      id: envelope.payload.id,
      roomCode,
      senderId: senderDid,
      senderName: resolveDmDisplayName(peerId),
      timestamp: ts,
      // The sender's assigned lamport keeps both sides' copies (and their
      // sync watermarks) identical; older clients omit it.
      lamport,
      type: reaction
        ? MessageType.Reaction
        : envelope.payload.replyTo
          ? MessageType.Reply
          : MessageType.Text,
      // A reaction's text is only the compatibility shim for old clients.
      content: reaction ? "" : envelope.payload.text,
      // Same cap as every other receive path. This one builds the Message by
    // hand instead of going through wireToMessage, so it has to apply the
    // bound itself or a DM peer can persist a multi-megabyte "quote" per
    // message in the recipient's store.
    replyTo: boundReplyTo(envelope.payload.replyTo),
      reactionTo: reaction?.to,
      // Same reasoning as the bound beside it: this path builds the Message
      // by hand rather than through wireToMessage, so it applies the emoji
      // cap itself or a DM peer can store a megabyte "emoji" per reaction.
      reactionEmoji: boundReactionEmoji(reaction?.emoji),
      reactionOp: reaction?.op,
      attachments: [],
      status: "delivered",
    };

    // Against storage, not the on-screen list: that list holds whichever
    // conversation is open, so a redelivered message was only recognised
    // as a duplicate when you happened to be looking at that DM.
    if (!(await getMessage(msg.id))) {
      await putMessage(msg);
      // Without a watermark row a DM digest carries an empty map on both
      // sides and _handleDigest concludes nothing is missing - DM history
      // had no sync-repair at all.
      await setWatermark(msg.roomCode, msg.senderId, msg.lamport);
      await refreshDmRooms();
      transportState.dmVersion += 1;
      const activeDid = peerIdToDid(transportState.activeDmPeerId ?? "");
      const isViewingThisDm =
        transportState.chatMode === "dm" &&
        (activeDid === senderDid || activeDid === peerId);
      // Reactions are filtered inside the funnel, same rule as rooms.
      // A mailbox batch collapses into one notification instead of one per DM.
      _announceMessage(msg, { viaMailbox });
      // The floating panel is a second place this conversation can be on
      // screen, and it can be showing it while the pane behind shows another
      // room entirely. Keyed on the room code, so this is a no-op otherwise.
      appendToDmPanel(msg);
      // The pane's array belongs to the conversation the pane is on. Appending
      // to it because the PANEL is showing this DM is how a message ends up
      // filed under the wrong conversation.
      if (isViewingThisDm) {
        transportState.messages = appendSorted(transportState.messages, msg);
      }
      // Visible in either surface means read, not merely delivered.
      if (isViewingThisDm || dmPanelIsShowing(roomCode)) {
        await markRoomSeen(roomCode, msg.lamport);
        const roomIndex = roomsStore.dmRooms.findIndex(
          (r) => r.roomCode === roomCode
        );
        if (roomIndex !== -1) {
          roomsStore.dmRooms[roomIndex] = {
            ...roomsStore.dmRooms[roomIndex],
            lastSeenLamport: Math.max(
              roomsStore.dmRooms[roomIndex].lastSeenLamport ?? 0,
              msg.lamport
            ),
          };
        }
        await refreshDmRooms();
        transportState.dmVersion += 1;
        // No stream to reply on when the DM came out of the mailbox. Calling
        // send() with a DID makes peerIdFromString throw inside libp2p, and
        // that surfaces as a `stream-open-failed` toast the user reads as a
        // real error - up to two per collected DM. So the receipt goes back
        // through the mailbox instead of being dropped: waiting for the two
        // of you to be online together is exactly what the mailbox exists to
        // avoid, and the ticks stayed at "sent" forever meanwhile.
        if (viaMailbox) {
          _depositDmReceipt(
            senderDid,
            encodeDmReadEnvelope([envelope.payload.id])
          );
        } else {
          _transport
            .send(peerId, encodeDmReadEnvelope([envelope.payload.id]))
            .catch(() => {});
        }
      }
    }

    if (viaMailbox) {
      _depositDmReceipt(senderDid, encodeDmAckEnvelope(envelope.payload.id));
    } else {
      _transport
        .send(peerId, encodeDmAckEnvelope(envelope.payload.id))
        .catch(() => {});
    }
  })();
}

/**
 * Do we have any reason to talk about this infoHash? A live transfer, or an
 * attachment row from a message we hold. Used to refuse file signals for
 * hashes we never asked about.
 */
async function _haveFileFor(infoHash: string): Promise<boolean> {
  if (transportState.fileTransfers.has(infoHash)) return true;
  const rows = await getAttachmentsByInfoHash(infoHash).catch(() => []);
  return rows.length > 0;
}

/**
 * Whether a connected peer is a member of any room we have joined, DIDs
 * checked against the room's stored participant list. DM rooms are joined
 * through the same _transport.joinRoom() path as shared rooms (see
 * joinPhonebookDmRooms), so an open DM's counterparty passes this too -
 * there is no separate DM case to special-case.
 */
async function _peerSharesRoomWithUs(peerId: string): Promise<boolean> {
  const did = _peerIdToDid.get(peerId);
  if (!did) return false;
  for (const roomCode of _transport.rooms()) {
    const participants = await getRoomParticipants(roomCode);
    if (participants.includes(did)) return true;
  }
  return false;
}

_transport.on("message", (peerId, data, room) => {
  // Before ANY branch: the DM and file-signal paths return early, and a peer
  // we only ever DM with would otherwise read as permanently app-silent -
  // making the repair tick send it a digest every 15s for the lifetime of the
  // connection, the exact busywork the tick promises not to do.
  _lastAppInbound.set(peerId, Date.now());
  if (room === null) {
    const envelope = parseDmEnvelope(data);
    if (envelope) {
      if (envelope.type === "ack") {
        void _acceptableReceipts(peerId, [envelope.messageId])
          .then((ids) => {
            for (const id of ids) applyMessageStatus(id, "delivered");
          })
          .catch(() => {});
        return;
      }

      if (envelope.type === "read") {
        void _acceptableReceipts(peerId, envelope.messageIds)
          .then((ids) => {
            if (!ids.length) return;
            for (const id of ids) applyMessageStatus(id, "read");
            // The reader only acks the page they had loaded; a read at lamport
            // L implies everything we sent before L in that room was read too.
            _cascadeReadAcks(peerId, ids).catch(() => {});
          })
          .catch(() => {});
        return;
      }

      // Handle incoming DM chat message.
      // Until the sender's profile has bound their peerId to a DID we cannot
      // tell which conversation this belongs to: the room code is a hash of
      // the two DIDs. Hold it and replay once the binding lands, rather than
      // filing it in a peerId-derived thread the sender never reads.
      const senderDid = _peerIdToDid.get(peerId);
      if (!senderDid) {
        const pending = _pendingDmByPeer.get(peerId) ?? [];
        if (pending.length < MAX_PENDING_DM_PER_PEER) {
          pending.push(envelope);
          _pendingDmByPeer.set(peerId, pending);
        }
        return;
      }
      _handleDmChat(peerId, senderDid, envelope);
      return;
    }
  }

  try {
    const decoded = decode(data);
    if (isFileSignalWireMessage(decoded)) {
      if (decoded.payload.kind === "file-seeder") {
        // Unsolicited: a file-seeder is a direct send, not tied to a room or
        // a signed message, so ANY connected peer could otherwise plant an
        // infoHash/mime claim for us to fetch. Only a peer that actually
        // shares a room with us (a DM room counts - see _peerSharesRoomWithUs)
        // gets remembered as a seeder, and it is bounded per peer in
        // webtorrent.ts. Fetching is stricter still: auto-download only a
        // file we already hold a message for. The seeder is still recorded
        // for unknown hashes because peers announce their inventory on
        // connect, before we have opened the room the file belongs to.
        const file = decoded.payload.file;
        _peerSharesRoomWithUs(peerId)
          .then((shared) => {
            if (!shared) return;
            _fileTransport.registerSeeder(file, peerId);
            if (
              shouldAutoDownload(file.mimeType, file.size) &&
              transportState.fileTransfers.has(file.infoHash)
            ) {
              _fileTransport.ensureDownload(file);
            }
          })
          .catch(() => {});
      } else {
        // The sibling branch above is membership-gated; this one had no gate
        // at all, so any peer that could dial us could open a WebRTC link
        // against us for any infoHash it liked - a full RTCPeerConnection
        // each, out of a global table of 32, from a peer with no business in
        // any of our rooms. Same membership rule, plus: a file signal is only
        // meaningful for a transfer or an attachment we actually hold, so an
        // infoHash we have never heard of buys nothing.
        const signal = decoded.payload;
        void (async () => {
          if (!(await _peerSharesRoomWithUs(peerId))) return;
          if (!(await _haveFileFor(signal.infoHash))) return;
          _fileTransport.handleSignal(peerId, signal);
        })().catch(() => {});
      }
      return;
    }

    // Update last seen for this peer
    const did = _peerIdToDid.get(peerId);
    if (did && room) {
      updateParticipantLastSeen(room, did).catch(() => {});
    }

    const msg = decoded as AnyWireMessage;

    switch (msg.type) {
      case MessageType.Profile:
        _handleProfile(peerId, msg);
        break;
      case MessageType.CallPresence:
        _handleCallPresence(peerId, msg.inCall, msg.roomCode);
        break;
      case MessageType.CallState:
        _handleCallState(peerId, msg);
        break;
      case MessageType.VoiceRedial:
        _voice.handleRedialRequest(peerId);
        break;
      case MessageType.VoiceSignal:
        _voice.handleWireSignal(peerId, msg.signal);
        break;
      case MessageType.WatchPresence:
        _handleWatchPresence(peerId, msg.watching);
        break;
      case MessageType.RoomName:
        _handleRoomName(msg, room);
        break;
      case MessageType.PluginEphemeral: {
        // Wire-only ephemeral messages: verify, fold to card state, but never persist.
        // No watermark, lamport, or storage side effects.
        const ephemeralMsg = msg as WirePluginEphemeral;
        _verifyIncoming(ephemeralMsg as unknown as WireChatMessage, { room })
          .then((v) => {
            if (!v.ok) {
              console.warn(
                "[app] dropped ephemeral plugin message with invalid signature from",
                ephemeralMsg.senderId
              );
              rec(
                ev("app.msg.reject", {
                  peer: peerId,
                  d: { reason: v.reason, wire: "plugin_ephemeral" },
                })
              );
              return;
            }
            // Fold ephemeral into card state. Static imports, not require():
            // require does not exist in the browser bundle and blew up the
            // first time an ephemeral arrived. The flood cap guards RECEIVE
            // too - the sender-side cap is no protection against a peer that
            // means us harm or a buggy build ticking every frame.
            try {
              // Ephemerals are room-scoped by design: one arriving outside
              // a room topic has no authenticated room to bind to, and an
              // unbound fold is exactly the cross-room forgery hole.
              if (room === null) return;
              // Validate BEFORE the flood cap: its key is
              // `${pluginId}|${peerId}` and pluginId came straight off the
              // wire, so a peer varying it got a fresh window per message -
              // the 4-per-second cap constrained nothing except how fast the
              // tracking map grew. Validation bounds the key space to
              // ^[a-z0-9-]{2,32}$, and with it the payload to the 4 KB cap
              // that until now only the SEND side honoured.
              const payload = _parsePluginPayload(
                MessageType.PluginEphemeral,
                ephemeralMsg.content
              );
              const cardId = payload?.cardId;
              if (!payload || !cardId) return;
              if (!_checkEphemeralFloodCap(payload.pluginId, peerId)) return;
              void getPlugin(payload.pluginId).then((plugin) => {
                if (!plugin) return;
                foldUpdate(cardId, plugin, {
                  id: ephemeralMsg.id,
                  senderId: ephemeralMsg.senderId,
                  senderDid: ephemeralMsg.senderDid,
                  senderName: ephemeralMsg.senderName,
                  lamport: ephemeralMsg.lamport,
                  data: payload.data,
                  ephemeral: true,
                  roomCode: room,
                });
              });
            } catch (err) {
              console.warn("[app] failed to fold ephemeral update:", err);
            }
          })
          .catch(() => {});
        break;
      }
      case MessageType.JoinRoom:
        _handleJoinRoom(peerId, msg.peerId, room);
        break;
      case MessageType.LeaveRoom:
        _handleLeaveRoom(peerId, msg.peerId, room);
        break;
      case MessageType.RoomUsersSync:
        _handleRoomUsersSync(msg, room);
        break;
      case MessageType.SyncDigest:
        _handleDigest(peerId, msg.roomCode, msg.watermarks).catch(() => {});
        break;
      case MessageType.SyncBatch:
        _handleSyncBatch(
          msg.roomCode,
          msg.messages,
          peerId,
          msg.live === true
        ).catch(() => {});
        break;
      case MessageType.SyncComplete:
        _handleSyncComplete(peerId, msg.roomCode);
        break;
      case MessageType.Text:
      case MessageType.Reply:
      case MessageType.Reaction:
      case MessageType.File:
      case MessageType.PluginCard:
      case MessageType.PluginUpdate:
        // A bare chat message is only legitimate over a room's pubsub topic
        // (room !== null). The same message type arriving over a direct
        // stream (room === null) would otherwise be stamped with whatever
        // room the receiver has open - letting any connected peer inject
        // forged history into a room they never joined. Drop it.
        if (room === null) {
          console.warn(
            "[app] dropped direct-stream chat message from",
            msg.senderId
          );
          break;
        }
        _verifyIncoming(msg, { room })
          .then((v) => {
            if (v.ok) {
              _handleChatMessage(msg, room, peerId).catch(() => {});
              return;
            }
            console.warn(
              "[app] dropped message with invalid signature from",
              msg.senderId
            );
            rec(
              ev("app.msg.reject", {
                peer: peerId,
                d: { reason: v.reason, wire: msg.type },
              })
            );
          })
          .catch(() => {});
        break;
    }
  } catch (e) {
    console.warn("[app] message decode failed", e, data);
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

const CONNECT_RETRY_BASE_MS = 3_000;
const CONNECT_RETRY_MAX_MS = 30_000;
let _connectRetryDelay = CONNECT_RETRY_BASE_MS;
let _connectRetryTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleConnectRetry(): void {
  if (_connectRetryTimer) return;
  _connectRetryTimer = setTimeout(() => {
    _connectRetryTimer = null;
    // Stop retrying if the identity got locked in the meantime
    try {
      requireSession();
    } catch {
      return;
    }
    connect().catch(() => {});
  }, _connectRetryDelay);
  _connectRetryDelay = Math.min(_connectRetryDelay * 2, CONNECT_RETRY_MAX_MS);
}

export async function connect() {
  // The flag is not proof. A page restored from the back-forward cache, or a
  // tab the browser froze, keeps relayConnected === true over a node that is
  // gone - and this early return then made "Reconnect" (and every joinRoom)
  // a no-op for the rest of the session. Ask the transport, not the mirror.
  if (transportState.relayConnected && _transport.p2pNode) return;
  // Post-unlock, so sealed profile rows are readable now.
  _hydratePeerProfileMeta();
  // Fetch fresh short-lived TURN credentials for this session (best-effort;
  // falls back to bundled ICE servers if the relay doesn't issue them).
  refreshTurnCredentials().catch(() => {});
  if (_connectPromise) {
    await _connectPromise;
    return;
  }

  _connectPromise = (async () => {
    try {
      // This device's own libp2p key, NOT the identity key: two devices on the
      // same account would otherwise share a peerId and never connect.
      await _transport.connect(deviceKeySeed());
      transportState.relayConnected = true;
      transportState.error = null;
      _connectRetryDelay = CONNECT_RETRY_BASE_MS;
      joinPhonebookDmRooms().catch(() => {});
      _joinSavedRooms().catch(() => {});
    } catch (err) {
      transportState.error = err instanceof Error ? err.message : String(err);
      transportState.relayConnected = false;
      _scheduleConnectRetry();
    } finally {
      _connectPromise = null;
    }
  })();

  await _connectPromise;
}

/**
 * Subscribe every room we have saved, not just the one that gets opened.
 *
 * Only DM rooms were re-subscribed on connect, so a chat room stayed unjoined
 * until the user clicked into it - and until then _handleDigest and
 * _handleSyncBatch both early-return for it (they refuse a room we have not
 * joined) and pubsub does not deliver it at all. Whether your history caught
 * up therefore depended on the OTHER side happening to have that room open.
 * The background reconcile in the repair tick already rotates over
 * _transport.rooms(), so this is what it was always meant to iterate.
 */
async function _joinSavedRooms(): Promise<void> {
  const rooms = await getAllRooms();
  // Subscribe FIRST. The participant sweep below is a sequential IDB pass
  // over every saved room, and running it ahead of the joins meant the whole
  // pass happened unsubscribed: gossip for those rooms was not delivered,
  // the relay had not been told we were in them, and no peer in them could
  // be dialled. Nothing about the sweep needs to precede a subscription.
  for (const room of rooms) {
    // DMs are handled by joinPhonebookDmRooms, which derives the room code
    // from the DID rather than trusting a stored one.
    if (room.roomCode.startsWith("dm-")) continue;
    _transport.joinRoom(room.roomCode);
  }
  // Not awaited in the join order any more: housekeeping, once per session.
  void _sweepInactiveParticipants(rooms);
}

/**
 * Members not seen in 30 days are removed, so the participant list does not
 * grow unbounded. Runs in the background after the joins.
 */
async function _sweepInactiveParticipants(
  rooms: { roomCode: string }[]
): Promise<void> {
  for (const room of rooms) {
    const removed = await cleanupInactiveParticipants(room.roomCode).catch(
      () => []
    );
    // Count only. This logged the room code and the participant DIDs, and a
    // room code is the room's entire membership secret - a console line is
    // exactly the sort of place it leaks out of (screenshots, bug reports,
    // an extension reading console output).
    if (removed.length > 0) {
      console.log("[room] removed", removed.length, "inactive participant(s)");
    }
  }
}

/**
 * Two rapid conversation switches race their awaits; only the LAST requested
 * open may touch view state. Each open claims a token and checks it after
 * every await - the loser bails without writing (and without acking).
 */
let _openRun = 0;
export function beginConversationOpen(): () => boolean {
  const run = ++_openRun;
  return () => run === _openRun;
}

export async function joinRoom(roomCode: string): Promise<boolean> {
  const stillCurrent = beginConversationOpen();
  if (!transportState.relayConnected) {
    await connect();
  }

  if (!transportState.relayConnected) {
    transportState.error = "Transport not connected to relay";
    transportState.connecting = false;
    return false;
  }

  transportState.error = null;
  transportState.connecting = true;
  try {
    // Claim the room before the awaits, not after. Everything that routes an
    // incoming message compares against transportState.roomCode, so during the
    // gap a message for the room being opened was dropped from the view, and -
    // worse - a message for the room being LEFT still matched and was appended
    // into the freshly loaded list. Clear the outgoing room's messages with it
    // so nothing from the old conversation is on screen under the new name.
    transportState.roomCode = roomCode;
    transportState.messages = [];
    // The roster too: the union below keeps whoever announces themselves
    // for THIS room during the awaits, but without this reset it also kept
    // the room just left, so switching rooms never changed the member list.
    transportState.roomUsers = [];
    // Only the entered room's cache: wiping everything dropped in-flight
    // ephemerals for pinned widgets and call tiles following OTHER rooms.
    clearCardStates(roomCode);
    await _loadHistory(roomCode, stillCurrent);
    // Background, one decrypt pass for blob URLs AND re-seeding: awaiting
    // this froze every room open for as long as its images take to decrypt
    // and re-hash - the messages are on screen, pictures pop in after.
    void _hydrateAndSeedAttachments(roomCode).catch((err) =>
      console.warn("[room] attachment hydrate/seed failed:", err)
    );
    if (!stillCurrent()) return false;
    _transport.joinRoom(roomCode);
    transportState.connected = true;
    transportState.chatMode = "room";
    transportState.activeDmPeerId = null;
    transportState.connecting = false;
    transportState.roomCode = roomCode;
    transportState.roomName = "";
    transportState.peers = _transport.peers();
    const selfDid = identityStore.did ?? _transport.selfId();
    const savedParticipants = await getRoomParticipants(roomCode);
    const participants = new Set(savedParticipants);
    participants.add(selfDid);
    if (!stillCurrent()) return false;
    transportState.roomUsers = [
      ...new Set([...transportState.roomUsers, ...participants]),
    ];
    await addRoomParticipant(roomCode, selfDid);
    // Seeding already runs in the background via _hydrateAndSeedAttachments
    // above - a second awaited decrypt-everything pass here was half the
    // reason opening a picture-heavy room hung the app.
    await _broadcastProfile();
    _broadcastJoinRoom();
    // Ask the peers we are ALREADY connected to for this room's history. The
    // digest only went out when a NEW peer connected, so joining a room while
    // the connections were already up pulled nothing and the room looked empty
    // until a reload rebuilt every connection.
    for (const pid of _transport.peers()) {
      _sendDigest(pid).catch(() => {});
    }
    return true;
  } catch (err) {
    // Roll back the partial join: _transport.joinRoom() already subscribed the
    // gossipsub topic and we flipped transportState to "in this room" before
    // the awaits that threw. Leaving that half-state makes the room look
    // joined-but-errored. Undo it.
    _transport.leaveRoom(roomCode);
    transportState.connected = false;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.error = err instanceof Error ? err.message : String(err);
    transportState.connecting = false;
    throw err;
  }
}

export function getRoomUsers(): string[] {
  return transportState.roomUsers;
}

/**
 * Remove a room COMPLETELY: say goodbye, stop listening, hang up if the call
 * lives there, and delete the history. Works whether or not the room is on
 * screen - removing a background room used to leave the transport subscribed,
 * so incoming traffic quietly re-stored messages for a room that no longer
 * existed, and a call held in it just kept going.
 */
export async function removeRoomCompletely(roomCode: string): Promise<void> {
  if (!roomCode) return;
  // As in _leaveCurrentRoom, and it matters more here: an in-flight join
  // resolving after the delete would resurrect the room as a live
  // subscription that quietly stores messages again.
  beginConversationOpen();
  const selfDid = identityStore.did ?? _transport.selfId();
  if (selfDid && _transport.rooms().includes(roomCode)) {
    // Before unsubscribing, or the broadcast no-ops and nobody sees us leave.
    await _transport
      .broadcast(
        encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
        roomCode
      )
      .catch(() => {});
  }
  _transport.leaveRoom(roomCode);
  if (transportState.callRoomCode === roomCode) leaveCall();
  if (transportState.roomCode === roomCode) {
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.roomUsers = [];
    transportState.messages = [];
    transportState.connected = false;
  }
  await removeRoom(roomCode);
}

export function leaveRoom(): void {
  void _leaveCurrentRoom();
}

/**
 * Leave the room on screen and nothing else.
 *
 * This used to stop the libp2p node outright and wipe every peer, name, avatar
 * and file transfer: leaving one room of several took down the rooms you were
 * staying in, the call you were on and any transfer in flight, and the app
 * only looked right again after a reload.
 */
async function _leaveCurrentRoom(): Promise<void> {
  // Claim the conversation token. Only joinRoom and openDmConversation did,
  // so a join still awaiting _loadHistory would finish AFTER this and put the
  // room back: re-set roomCode, re-subscribe the topic, re-add the
  // participant. Leaving is a conversation change like any other.
  beginConversationOpen();
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (selfDid) {
    // Await the publish: unsubscribing right after would drop the message and
    // nobody would ever see you leave.
    await _broadcastLeaveRoom().catch(() => {});
    removeRoomParticipant(roomCode, selfDid).catch(() => {});
  }
  _transport.leaveRoom(roomCode);
  // Only hang up if the call is in the room being left.
  if (transportState.callRoomCode === roomCode) leaveCall();

  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.roomUsers = [];
  transportState.messages = [];
  transportState.connected = false;
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
}

/** Full teardown: everything goes, including the libp2p node. */
export function disconnectTransport(): void {
  _disconnectWithoutBroadcasting();
}

function _disconnectWithoutBroadcasting(): void {
  rec(ev("session.end"));
  for (const transfer of transportState.fileTransfers.values()) {
    if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
  }
  // Clear the file transport's internal maps too - it's a session-long
  // singleton, so without this its stale (revoked) blobURLs get replayed on
  // rejoin and revoke freshly-hydrated ones. Keeps the client alive for reuse.
  _fileTransport.resetTransfers();
  leaveCall();
  _transport.disconnect();
  stopTelemetryTaps();
  _peerIdToDid.clear();
  clearCardStates();
  // The search corpus is decrypted message text; it dies with the session
  // for the same reason card states do.
  clearSearchCorpus();
  // Session-only plugin surfaces die with the session - a signout to another
  // identity must not inherit the previous identity's private cards.
  clearLocalCards();
  // Pending plugin questions die as declines with it.
  clearPluginConfirms();
  transportState.peerDidVersion += 1;
  // disconnect() fully stops and nulls the libp2p node, so the relay
  // connection is gone too. Without clearing this flag, connect()/joinRoom()
  // short-circuit on the stale `relayConnected === true` and never rebuild
  // the node - reconnect stays broken until a full page reload.
  transportState.relayConnected = false;
  transportState.connected = false;
  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.peers = [];
  transportState.provenPeers = new Set();
  transportState.messages = [];
  transportState.participants = new Map();
  transportState.peerNames = new Map();
  transportState.peerAvatars = new Map();
  transportState.peerColors = new Map();
  transportState.error = null;
  transportState.callPeerIds = new Set();
  transportState.pendingTransmissions = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
  transportState.fileTransfers = new Map();
  transportState.callPeerStates = new Map();
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
  transportState.micUnavailable = false;
  // Both belong to the session that just ended: a new identity must not
  // inherit the previous one's undelivered-message notes.
  transportState.dmQueuedP2POnly = new Set();
}

/**
 * Chat used to ride gossipsub alone, and a publish into a dead or still-forming
 * mesh is silently dropped (allowPublishToZeroTopicPeers) - only the slow
 * digest rotation repaired it, which read as "messages take forever unless I
 * refresh" while profiles stayed instant, because _sendProfile already sends
 * belt-and-braces: the broadcast plus a direct copy per peer. Give chat the
 * same insurance: after the publish, hand each connected peer that is KNOWN to
 * be in the room a one-message SyncBatch. The batch receive path verifies
 * signatures, refuses rooms it has not joined, dedups against storage and the
 * view, and evicts plugin card state - so the duplicate costs nothing when
 * gossip worked, and saves a refresh when it did not.
 *
 * Membership-gated on purpose: the roomCode is the room's join secret, and
 * roomUsers holds the DIDs that already possess it. A connected-but-unbound
 * peer gets no copy - gossip and sync still cover them.
 */
function _broadcastChatWire(wire: WireChatMessage, roomCode: string): boolean {
  const payload = encode(wire);
  _transport.broadcast(payload, roomCode);
  rec(
    ev("app.msg.out", {
      room: refs().roomRef(roomCode),
      d: { bytes: payload.byteLength },
    })
  );
  const batchOf = (w: WireChatMessage) =>
    encode({
      type: MessageType.SyncBatch,
      roomCode,
      messages: [w],
      batchIndex: 0,
      totalBatches: 1,
      // Not history repair: whichever copy of this message lands first is the
      // one that has to announce it, because the publish above is dropped
      // outright when the mesh has no topic peers for the room.
      live: true,
    });
  // DM rooms have no roomUsers roster - the direct copy goes to the one peer
  // the conversation is with (plugin cards and files ride this path too).
  if (roomCode.startsWith("dm-")) {
    void _sendDmBatch(roomCode, wire, batchOf).catch(() => {});
    return false;
  }
  const batch = batchOf(wire);
  const members = new Set(transportState.roomUsers);
  for (const pid of _transport.peers()) {
    const did = _peerIdToDid.get(pid);
    if (!did || !members.has(did)) continue;
    _transport.send(pid, batch).catch(() => {});
  }
  // "Handed to the network", not "delivered": a node with at least one peer
  // the relay places in this room. With neither, the publish went into a
  // mesh with nobody in it and the message is waiting on the digest - which
  // is what the room path's "sending" clock now says out loud.
  return !!_transport.p2pNode && _transport.peersInRoom(roomCode).length > 0;
}

/** Wire copy with the inline file bytes removed. They are the reason a DM
 *  with a picture blows past the mailbox's largest padding bucket, and the
 *  receiver fetches the file over the torrent either way. */
function _stripInlineFiles(wire: WireChatMessage): WireChatMessage {
  const files = wire.meta?.files;
  if (!files?.some((f) => f.inline)) return wire;
  return {
    ...wire,
    meta: {
      ...wire.meta,
      files: files.map(({ inline: _inline, ...rest }) => rest),
    },
  };
}

/**
 * The DM copy of a chat wire: files, plugin cards and plugin updates.
 *
 * This was a fire-and-forget send to `activeDmPeerId` - the conversation ON
 * SCREEN, which is not necessarily the conversation the message belongs to
 * (a pinned widget's update, or anything sent from the floating panel while
 * the pane shows another room), and nothing at all when the peer was
 * offline. It now gets exactly what a DM text envelope gets: the persisted
 * offline queue, and a sealed copy in the relay mailbox.
 */
async function _sendDmBatch(
  roomCode: string,
  wire: WireChatMessage,
  batchOf: (w: WireChatMessage) => Uint8Array
): Promise<void> {
  const peerDid = await dmPeerDidForRoom(roomCode);
  if (!peerDid) return;
  const batch = batchOf(wire);
  const peerId = didToPeerId(peerDid);
  if (peerId && (await _transport.send(peerId, batch))) {
    applyMessageStatus(wire.id, "sent");
    return;
  }
  // Queued, so the clock stays on the bubble until the flush (or the peer's
  // own digest) says otherwise.
  await queueDmMessage(peerDid, batch, wire.id);
  // The mailbox copy drops the inline bytes: they exist to save a round trip
  // for a peer who is online, and they are what pushes an ordinary photo
  // past the largest bucket the mailbox will hold.
  const { depositDmToMailbox } = await import("./mailbox.svelte");
  const result = await depositDmToMailbox(
    peerDid,
    batchOf(_stripInlineFiles(wire)),
    "batch"
  );
  noteMailboxDeposit(wire.id, result);
}

export async function sendMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
  if (transportState.chatMode === "dm") {
    await sendDirectMessage(text, { replyTo: options.replyTo });
    return;
  }
  if (!transportState.roomCode) return;

  const profile = await getOwnProfile(undefined, { skipBytes: true });
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const lamport = lamportSend(transportState.roomCode);

  let msg: Message = {
    id: crypto.randomUUID(),
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: Date.now(),
    lamport,
    type: options.type ?? MessageType.Text,
    content: text,
    meta: options.meta,
    attachments: options.attachments ?? [],
    replyTo: options.replyTo,
    reactionTo: options.reactionTo,
    reactionEmoji: options.reactionEmoji,
    reactionOp: options.reactionOp,
  };

  // Sign the message before sending
  msg = signMessage(msg);

  // Same clock a DM gets. A room message sent with no relay - no node, or a
  // room the relay has placed nobody in - went out looking identical to one
  // that landed, and only the digest rotation ever carried it. "sending"
  // says so; _handleDigest promotes it to "sent" once a member's watermark
  // proves they hold it. Set AFTER signing: status is not in the canonical
  // and never rides the wire.
  msg.status = _broadcastChatWire(messageToWire(msg), transportState.roomCode)
    ? "sent"
    : "sending";

  // Echo BEFORE the storage writes: seal + two IDB round-trips gated the
  // local echo, which read as send lag - the network send already left.
  transportState.messages = appendSorted(transportState.messages, msg);

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);
}

export async function sendReply(text: string, target: Message): Promise<void> {
  // The same helper the composer preview and the render path use. Building the
  // snapshot by hand here left an image-only target quoting an EMPTY string,
  // which is the bug this fixes - and this is the ordinary text-reply path, so
  // it is the one that matters most. A peer holding the original still renders
  // it correctly (quoted() prefers the held message), but anyone receiving it
  // by backfill, or on a fresh device, has only this snapshot to go on.
  const snapshot = getQuotableText(target);
  await sendMessage(text, {
    type: MessageType.Reply,
    replyTo: {
      id: target.id,
      senderName: target.senderName,
      content: snapshot,
    },
  });
}

export async function sendFiles(
  files: File[],
  text = "",
  options: Pick<SendMessageOptions, "replyTo"> = {}
): Promise<void> {
  if (!transportState.roomCode || !files.length) return;

  const seeded: FileDescriptor[] = [];
  const sourceByInfoHash = new Map<string, File>();
  // Small files also travel inside the message (wire copy only, never the
  // stored one): they render for everyone like a CDN gif, seeders or not.
  const _inlineByHash = new Map<string, string>();

  for (const file of files) {
    const fingerprint = await fileFingerprint(file);
    const existing = _seededByFingerprint.get(fingerprint);
    if (existing) {
      seeded.push(existing);
      sourceByInfoHash.set(existing.infoHash, file);
      continue;
    }

    const [newSeed] = await _fileTransport.seedFiles([file]);
    _seededByFingerprint.set(fingerprint, newSeed);
    seeded.push(newSeed);
    sourceByInfoHash.set(newSeed.infoHash, file);
  }

  const messageId = crypto.randomUUID();
  const attachmentIds: string[] = [];
  const createdAt = Date.now();
  // Measured here and carried with the announce so a receiver can reserve
  // the space before the bytes arrive. The sender is the only party who has
  // the file early enough for this to be worth anything.
  const dimsByHash = new Map<string, { width: number; height: number }>();

  for (let i = 0; i < seeded.length; i += 1) {
    const seededFile = seeded[i];
    const source = sourceByInfoHash.get(seededFile.infoHash);
    if (!source) continue;
    const dims = await measureMedia(source);
    if (dims) dimsByHash.set(seededFile.infoHash, dims);
    const canPersistData = source.size <= MAX_PERSISTED_ATTACHMENT_BYTES;
    if (source.size <= INLINE_FILE_MAX_BYTES) {
      _inlineByHash.set(
        seededFile.infoHash,
        bytesToBase64(new Uint8Array(await source.arrayBuffer()))
      );
    }
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      roomCode: transportState.roomCode,
      messageId,
      filename: seededFile.filename,
      mimeType: seededFile.mimeType,
      size: seededFile.size,
      infoHash: seededFile.infoHash,
      status: "seeding",
      createdAt,
      width: dims?.width,
      height: dims?.height,
      data: canPersistData ? await source.arrayBuffer() : undefined,
    };
    attachmentIds.push(attachment.id);
    await putAttachment(attachment);

    withFileTransfer({
      ...seededFile,
      status: "seeding",
      progress: 1,
      done: true,
      seeding: true,
      peers: 0,
      seeders: 1,
      blobURL: URL.createObjectURL(source),
    });
  }

  const profile = await getOwnProfile(undefined, { skipBytes: true });
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  // DM rooms order by wall-clock ms; a room-counter lamport (~small int)
  // filed the file before the entire conversation and it vanished on reload.
  const lamport = transportState.roomCode.startsWith("dm-")
    ? await nextDmLamport(transportState.roomCode, createdAt)
    : lamportSend(transportState.roomCode);

  let msg: Message = {
    id: messageId,
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: createdAt,
    lamport,
    type: MessageType.File,
    content: text.trim(),
    meta: {
      files: seeded.map((f) => ({ ...f, ...dimsByHash.get(f.infoHash) })),
    },
    attachments: attachmentIds,
    replyTo: options.replyTo,
  };

  msg = signMessage(msg);

  const wire = messageToWire(msg);
  if (_inlineByHash.size) {
    wire.meta = {
      // From the SAME dim-enriched entries the stored message carries.
      // Rebuilding from `seeded` dropped width/height from the wire for
      // every inline-sized file - which is every ordinary chat image - so
      // receivers never got the dimensions and the loading skeleton only
      // ever worked on the sender's own echo.
      files: seeded.map((f) => {
        const withDims = { ...f, ...dimsByHash.get(f.infoHash) };
        const b64 = _inlineByHash.get(f.infoHash);
        return b64 ? { ...withDims, inline: b64 } : withDims;
      }),
    };
  }
  // Same clock as a text send; see sendMessage.
  msg.status = _broadcastChatWire(wire, transportState.roomCode)
    ? "sent"
    : "sending";
  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = appendSorted(transportState.messages, msg);

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);
}

// ponytail: sendCard duplicates the send pipeline (signing, lamport, putMessage,
// setWatermark, appendSorted, markRoomSeen, noteRoomActivity) without sharing
// it with sendMessage. This is debt: generalize to a _sendChatMessage(type, ...)
// path.
export async function sendCard(
  pluginId: string,
  payload: unknown
): Promise<string> {
  if (!transportState.roomCode) {
    throw new Error("Not in a room");
  }

  // Validate plugin ID and payload
  const idValidation = validatePluginId(pluginId);
  if (!idValidation.ok) {
    throw new Error(`Invalid plugin ID: ${idValidation.reason}`);
  }

  const payloadValidation = validateCardPayload(payload);
  if (!payloadValidation.ok) {
    throw new Error(`Card payload error: ${payloadValidation.reason}`);
  }

  const profile = await getOwnProfile(undefined, { skipBytes: true });
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const ts = Date.now();
  // Same rule as files: DM rooms order by wall-clock ms, a room-counter
  // lamport would file the card before the whole conversation.
  const lamport = transportState.roomCode.startsWith("dm-")
    ? await nextDmLamport(transportState.roomCode, ts)
    : lamportSend(transportState.roomCode);

  const cardId = crypto.randomUUID();
  const content = JSON.stringify({ pluginId, data: payload });

  let msg: Message = {
    id: cardId,
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: ts,
    lamport,
    type: MessageType.PluginCard,
    content,
    attachments: [],
  };

  // Sign the message
  msg = signMessage(msg);

  _broadcastChatWire(messageToWire(msg), transportState.roomCode);

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = appendSorted(transportState.messages, msg);

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);

  return cardId;
}

let cachedPluginSenderName = "";

export async function sendUpdate(
  pluginId: string,
  cardId: string,
  payload: unknown,
  opts: { ephemeral?: boolean } = {},
  // A pinned sidebar widget acts on its card's room, not whatever room is
  // open - the host API binds this to the card's room at construction.
  targetRoom?: string
): Promise<void> {
  const roomCode = targetRoom ?? transportState.roomCode;
  if (!roomCode) {
    throw new Error("Not in a room");
  }

  // Validate plugin ID and payload
  const idValidation = validatePluginId(pluginId);
  if (!idValidation.ok) {
    throw new Error(`Invalid plugin ID: ${idValidation.reason}`);
  }

  const payloadValidation = validateUpdatePayload(payload);
  if (!payloadValidation.ok) {
    throw new Error(`Update payload error: ${payloadValidation.reason}`);
  }

  const profile = await getOwnProfile(undefined, { skipBytes: true });
  const senderName = profile?.nickname?.trim() || "Anonymous";
  cachedPluginSenderName = cachePluginSenderName(
    cachedPluginSenderName,
    profile?.nickname
  );
  const myId = identityStore.did ?? _transport.selfId();

  // Ephemeral messages: check flood cap, wire-only (lamport:0), PluginEphemeral type
  if (opts.ephemeral) {
    if (!_checkEphemeralFloodCap(pluginId, myId)) {
      // Rate-limited, drop this message
      return;
    }

    const content = JSON.stringify({ pluginId, cardId, data: payload });
    let wire: WirePluginEphemeral = {
      type: MessageType.PluginEphemeral,
      id: crypto.randomUUID(),
      senderId: myId,
      senderName,
      timestamp: Date.now(),
      lamport: 0, // Ephemeral messages don't use lamport but need it for signing
      content,
    };

    // Sign the ephemeral message (cast to Message-compatible shape). The
    // wire itself carries no roomCode, but the v3 canonical covers it -
    // the receiver reconstructs it from the topic - so it must be present
    // AT SIGNING or every ephemeral fails verification.
    const signed = signMessage({ ...wire, roomCode } as unknown as Message);
    wire = signed as any as WirePluginEphemeral;
    _transport.broadcast(encode(wire), roomCode);
    // Wire-only: no storage, no watermark, no visibleMessages, no noteRoomActivity
    return;
  }

  // Persisted updates
  const updateTs = Date.now();
  // DM rooms order by wall-clock ms, same as files and cards.
  const lamport = roomCode.startsWith("dm-")
    ? await nextDmLamport(roomCode, updateTs)
    : lamportSend(roomCode);
  const content = JSON.stringify({ pluginId, cardId, data: payload });

  let msg: Message = {
    id: crypto.randomUUID(),
    roomCode,
    senderId: myId,
    senderName,
    timestamp: updateTs,
    lamport,
    type: MessageType.PluginUpdate,
    content,
    attachments: [],
  };

  // Sign the message
  msg = signMessage(msg);

  _broadcastChatWire(messageToWire(msg), roomCode);

  // Persist non-ephemeral updates
  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);
  // View and seen-watermark belong to the OPEN room only: a widget update
  // for a background room must not paint here or mark that room read.
  if (transportState.roomCode === msg.roomCode) {
    transportState.messages = appendSorted(transportState.messages, msg);
    markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
  }

  // Fold our OWN update into the card state - the dispatcher only folds
  // INCOMING messages, so the sender's card never saw their own vote or spin
  // until a reload rebuilt it from storage.
  try {
    const { getPlugin } = await import("../plugins/registry");
    const plugin = await getPlugin(pluginId);
    if (plugin) {
      foldUpdate(cardId, plugin, {
        id: msg.id,
        senderId: msg.senderId,
        senderDid: msg.senderDid,
        senderName: msg.senderName,
        lamport: msg.lamport,
        data: payload,
        roomCode: msg.roomCode,
      });
    }
    touchCardStates();
  } catch (err) {
    console.warn("[plugins] failed to fold own update:", err);
  }

  noteRoomActivity(msg.roomCode, msg.timestamp);
}

/**
 * Broadcast a signed plugin update without asynchronous work. This is only
 * for page teardown, when awaiting a profile lookup would lose the message.
 */
export function sendUpdateImmediately(
  pluginId: string,
  cardId: string,
  payload: unknown,
  targetRoom?: string
): void {
  // Bound to the host's room like sendUpdate: a teardown beacon fired while
  // the user reads ANOTHER room (or a DM) must still land in the card's own
  // room - hardcoding the open room misrouted or dropped it.
  const roomCode = targetRoom ?? transportState.roomCode;
  if (!roomCode || (!targetRoom && transportState.chatMode === "dm")) return;
  if (!validatePluginId(pluginId).ok || !validateUpdatePayload(payload).ok)
    return;
  const msg = signMessage({
    id: crypto.randomUUID(),
    roomCode,
    senderId: identityStore.did ?? _transport.selfId(),
    senderName: immediatePluginSenderName(
      cachedPluginSenderName,
      identityStore.did,
      _transport.selfId()
    ),
    timestamp: Date.now(),
    lamport: lamportSend(roomCode),
    type: MessageType.PluginUpdate,
    content: JSON.stringify({ pluginId, cardId, data: payload }),
    attachments: [],
  });
  _broadcastChatWire(messageToWire(msg), roomCode);
  // The broadcast gets the departure to connected peers immediately. Keep a
  // best-effort local copy too: after a refresh the sender must rebuild the
  // same closed/left state without waiting for another peer's next digest.
  void putMessage(msg)
    .then(() => setWatermark(roomCode, msg.senderId, msg.lamport))
    .then(() => markRoomSeen(roomCode, msg.lamport))
    .catch(() => {});
}

export function requestFileDownload(
  file: FileEntry,
  senderId?: string | null
): void {
  const peerId = senderId ? maybePeerIdFromSenderId(senderId) : null;
  if (peerId) {
    _fileTransport.registerSeeder(file, peerId);
  }
  _fileTransport.ensureDownload(file);
}

export async function toggleReaction(
  messageId: string,
  emoji: string
): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  // The loaded page cannot see reactions on older messages, which made
  // un-reacting there impossible: the prior comes from storage. Reaction
  // rows only - every emoji click used to decrypt the entire room.
  const all = await getMessagesOfTypes(roomCode, [MessageType.Reaction]);
  const existing = all
    .filter(
      (m) =>
        m.reactionTo === messageId &&
        m.reactionEmoji === emoji &&
        isSelfSender(m.senderId)
    )
    .sort((a, b) => b.lamport - a.lamport)[0];
  const reactionOp: "add" | "remove" =
    existing?.reactionOp === "add" ? "remove" : "add";

  if (transportState.chatMode === "dm") {
    await sendDirectMessage("", {
      reaction: { to: messageId, emoji, op: reactionOp },
    });
    return;
  }

  await sendMessage("", {
    type: MessageType.Reaction,
    reactionTo: messageId,
    reactionEmoji: emoji,
    reactionOp,
  });
}

export async function loadMoreMessages(
  beforeLamport: number
): Promise<boolean> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return false;
  const older = await getMessages(roomCode, beforeLamport);
  // The user can switch rooms while the page loads; prepending the old
  // room's backlog into the new room's view crosses histories.
  if (transportState.roomCode !== roomCode) return false;
  if (!older.length) return false;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newOnes = older.filter((m) => !existingIds.has(m.id));
  transportState.messages = [...newOnes, ...transportState.messages].sort(
    MSG_ORDER
  );
  // "more exists" comes from the raw page size: dedup can shrink newOnes on
  // a full page, which used to hide the load-older button early.
  return older.length === PAGE_SIZE;
}

/**
 * Mark everything loaded in the open conversation as read.
 *
 * Only while the page is actually visible. A backgrounded tab parked on a room
 * kept marking arriving messages read, so that room accrued no unread count and
 * the tab title and app icon under-counted by exactly its traffic - the whole
 * point of a counter is to survive not looking. Callers re-run this when the
 * page comes back.
 */
export async function markSeen(): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState !== "visible")
    return;
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  // Only this room's messages: a sync batch for another room can share the
  // array briefly, and its lamports must not become this room's watermark.
  let maxLamport = 0;
  for (const m of transportState.messages) {
    if (m.roomCode === roomCode && m.lamport > maxLamport)
      maxLamport = m.lamport;
  }
  if (maxLamport === 0) return;
  await markRoomSeen(roomCode, maxLamport);
  if (roomCode.startsWith("dm-")) {
    // DM rooms live in their own mirror, and the DM badge recomputes on
    // dmVersion - the rooms maps below never carried them.
    const idx = roomsStore.dmRooms.findIndex((r) => r.roomCode === roomCode);
    if (idx !== -1) {
      roomsStore.dmRooms[idx] = {
        ...roomsStore.dmRooms[idx],
        lastSeenLamport: Math.max(
          roomsStore.dmRooms[idx].lastSeenLamport ?? 0,
          maxLamport
        ),
      };
    }
    transportState.dmVersion += 1;
    return;
  }
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) {
    roomsStore.rooms[idx] = {
      ...roomsStore.rooms[idx],
      lastSeenLamport: Math.max(
        roomsStore.rooms[idx].lastSeenLamport ?? 0,
        maxLamport
      ),
    };
  }
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, 0);
  roomsStore.unreadCounts = next;
}

export function broadcastProfile(): void {
  _broadcastProfile().catch(() => {});
}

export function setRoomName(name: string): void {
  transportState.roomName = name.trim().slice(0, 64);
  _sendRoomName();
}

export function selfId(): string {
  return identityStore.did ?? _transport.selfId();
}

/**
 * Whether a stored senderId refers to this user. Messages written while the
 * identity was locked carry the raw peerId instead of the DID, so a single-
 * form comparison misclassifies our own history as someone else's.
 */
export function isSelfSender(senderId: string): boolean {
  return senderId === selfId() || senderId === _transport.selfId();
}

export function peerId(): string {
  return _transport.selfId();
}

export function peerIdToDid(peerId: string): string {
  // Reading the version makes callers inside $derived recompute when the map
  // changes: the map itself is a plain Map, so a mapping learned after the
  // "connect" event used to leave presence and profile lookups stale forever.
  void transportState.peerDidVersion;
  return _peerIdToDid.get(peerId) ?? peerId;
}

export function didToPeerId(did: string): string | null {
  void transportState.peerDidVersion;
  for (const [peerId, mappedDid] of _peerIdToDid) {
    if (mappedDid === did) return peerId;
  }
  return null;
}

/**
 * Round-trip time to a peer by DID, in milliseconds, or null for no answer.
 *
 * Takes a DID because that is the identity every surface above the
 * transport uses; the peerId is an implementation detail of this layer.
 */
export async function measureRtt(
  did: string,
  timeoutMs?: number
): Promise<number | null> {
  const peerId = didToPeerId(did) ?? did;
  return _transport.measureRtt(peerId, timeoutMs);
}

/** One NTP-style clock sample against a peer, by DID - see measureClock. */
export async function measureClockSample(
  did: string,
  timeoutMs?: number
): Promise<{ t0: number; t1: number; t2: number; t3: number } | null> {
  const peerId = didToPeerId(did) ?? did;
  return _transport.measureClock(peerId, timeoutMs);
}

export function isRelayed(peerId: string): boolean {
  return transportState.relayedPeers.has(peerId);
}
