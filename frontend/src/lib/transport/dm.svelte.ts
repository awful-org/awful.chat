import { identityStore } from "$lib/identity/identity.svelte";
import { captureDmOwnership } from "./dm-ownership";
import {
  requireSession,
  didToPublicKey,
  onIdentityLock,
  type UnlockedSession,
} from "$lib/identity/identity";
import { hybridPairwiseRoomSecret, type DmPqState } from "$lib/room-security/pq-dm";
import { joinDmConversation, joinStoredRoom } from "$lib/room-security/room-lifecycle";
import { refreshDmRooms } from "$lib/rooms.svelte";
import { dropRoomCorpus } from "$lib/search/corpus.svelte";
import {
  deleteMessagesForRoom,
  deletePhonebookEntry,
  deleteRoom,
  getAllRooms,
  getDMRooms,
  getPeerProfile,
  getPhonebookEntries,
  getRoom,
  getWatermark,
  setDeletedFloor,
  putMessage,
  markRoomSeen,
  setWatermark,
  roomHoldsMessages,
  getLastMessageFrom,
  nextDmLamport,
  putPhonebookEntry,
  putRoom,
  setDmPqState,
  setDmRequest,
  type DMRoom,
  type PhonebookEntry,
  type Room,
  getMessages,
} from "$lib/storage";
import { roomsStore } from "$lib/rooms.svelte";
import {
  appendToDmPanel,
  defaultPanelPosition,
  dmPanel,
  dmPanelIsShowing,
} from "$lib/dm-panel.svelte";
import { MessageType, type Message, type WireTyping } from "$lib/types/message";
import { signMessage } from "$lib/messaging";
import { prepareOutgoingText } from "./outgoing-text";
import { dmInboxNotice } from "$lib/dm-inbox-notice";
import { base64ToBytes, bytesToBase64, encode } from "$lib/utils";
import { typingPrefs } from "$lib/typing.svelte";
import { leaveCall } from "./call.svelte";
import {
  _hydrateAndSeedAttachments,
} from "./files.svelte";
import {
  appendSorted,
  beginConversationOpen,
  _loadHistory,
  _peerIdToDid,
  peerIdToDid,
  _transport,
  applyMessageStatus,
  transportState,
} from "./transport.svelte";
import {
  looksLikePeerId,
  looksLikeDid,
  resolveToDid,
  didToPeerId,
} from "$lib/identity/identity-utils";

import {
  encodeDmChatEnvelope,
  encodeDmReadEnvelope,
  hashDmRoomCode,
  MAX_DM_READ_IDS,
} from "./dm-codec";
import type { MailboxDepositResult } from "./mailbox.svelte";
import {
  openRow,
  sealRow,
  storageCryptoReady,
  type StoreCryptoSpec,
} from "$lib/storage-crypto";
import { ev, errText } from "$lib/telemetry/event";
import { rec } from "$lib/telemetry/recorder";
import { newMessageId } from "../message-id";

interface QueuedMessage {
  to: string;
  data: number[];
  queuedAt: number;
  messageId?: string; // for status updates once the flush succeeds
}

const DM_QUEUE_KEY = "awful:dm-queue:v1";

// The queue holds message plaintext - body text, quoted replies, reaction
// emoji, the recipient's DID - which everywhere else in the app reaches disk
// only as AES-GCM ciphertext (storage-crypto.ts). Written as readable JSON it
// also survived lockIdentity(), which drops the at-rest key but not
// localStorage, so a locked or seized device still gave up every undelivered
// DM. The value is now a single sealed blob under that same at-rest key.
// localStorage stays the medium because the send path needs the queue to
// survive a reload; base64 because localStorage only holds strings.
const DM_QUEUE_SPEC: StoreCryptoSpec = { clear: [] };

function validQueueEntries(items: unknown[]): QueuedMessage[] {
  return items.filter(
    (item): item is QueuedMessage =>
      !!item &&
      typeof (item as QueuedMessage).to === "string" &&
      Array.isArray((item as QueuedMessage).data) &&
      typeof (item as QueuedMessage).queuedAt === "number"
  );
}

async function loadQueuedDmMessages(): Promise<QueuedMessage[]> {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DM_QUEUE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // A queue left by a build from before the sealing. Read it so pending
      // messages still go out, then write it straight back sealed: that
      // clears the readable copy, though the bytes already handed to the
      // profile's LevelDB stay recoverable until a compaction the page
      // cannot trigger.
      const legacy = validQueueEntries(parsed);
      await saveQueuedDmMessages(legacy);
      return legacy;
    }
    const blob = parsed as { iv?: unknown; ct?: unknown };
    if (typeof blob.iv !== "string" || typeof blob.ct !== "string") return [];
    // Locked: there is nothing to flush before unlock anyway, and returning
    // empty here is safe only because saveQueuedDmMessages refuses to write
    // while locked - otherwise an empty read would overwrite the queue.
    if (!storageCryptoReady()) return [];
    const opened = await openRow<{ q?: unknown }>(
      {
        _enc: { iv: base64ToBytes(blob.iv), ct: base64ToBytes(blob.ct).buffer },
      },
      DM_QUEUE_SPEC
    );
    return Array.isArray(opened.q) ? validQueueEntries(opened.q) : [];
  } catch {
    // Undecryptable (another identity's key, a truncated write): the queue is
    // unrecoverable, and treating it as empty beats throwing out of the send
    // path. Nothing overwrites it until the next successful save.
    return [];
  }
}

async function saveQueuedDmMessages(queue: QueuedMessage[]): Promise<void> {
  if (typeof localStorage === "undefined") return;
  if (!storageCryptoReady()) {
    // No at-rest key means no way to persist this without putting plaintext
    // back on disk, and refusing beats that. Unreachable from the send path:
    // composing a DM already needs the unlocked identity to sign the envelope
    // and to allocate a lamport out of IndexedDB, so the key is armed by the
    // time anything can be queued.
    console.warn("[dm] storage locked: offline queue not persisted");
    rec(ev("storage.locked", { d: { what: "dm-queue" } }));
    return;
  }
  try {
    const session = requireSession();
    const sealed = await sealRow({ q: queue }, DM_QUEUE_SPEC);
    if (requireSession() !== session) return;
    localStorage.setItem(
      DM_QUEUE_KEY,
      JSON.stringify({
        iv: bytesToBase64(sealed._enc.iv),
        ct: bytesToBase64(new Uint8Array(sealed._enc.ct)),
      })
    );
  } catch (err) {
    // Storage full or blocked: the message still sent or sits in memory;
    // a quota error must not blow up out of sendDirectMessage.
    rec(ev("storage.quota", { d: { err: errText(err) } }));
  }
}

function resolveDmPeerId(candidate: string): string | null {
  if (!candidate) return null;
  // If it's a current peer, use it
  if (_transport.peers().includes(candidate)) return candidate;
  // If it looks like a peer ID, use it
  if (looksLikePeerId(candidate)) return candidate;
  // If it's a DID, try to find the peer ID, but if not found, use the DID itself
  // This is important because DIDs are stable identities
  if (looksLikeDid(candidate)) {
    for (const [peerId, did] of _peerIdToDid) {
      if (did === candidate) return peerId;
    }
    // No mapping found, but it's a valid DID - return it as-is
    // The room code will be computed from the DID which is stable
    return candidate;
  }
  // Try reverse lookup for DID→peerId
  for (const [peerId, did] of _peerIdToDid) {
    if (did === candidate) return peerId;
  }
  return null;
}

/** Bound the offline queue; beyond this the oldest entries give way. */
const DM_QUEUE_MAX = 200;

// Every read-modify-write of the queue runs through this chain, one at a time.
// Sealing the queue made load and save asynchronous, and ChatView calls
// sendMessage() without awaiting it, so two quick sends to an offline peer both
// loaded the same snapshot and both wrote snapshot+1: the first message was
// dropped without a trace, never retried, its status stuck on "sending"
// forever. Holding the chain across the load AND the save is what makes each
// mutation see the previous one's write.
let _queueChain: Promise<void> = Promise.resolve();

function mutateDmQueue(
  mutate: (queue: QueuedMessage[]) => QueuedMessage[]
): Promise<void> {
  const session = requireSession();
  const run = _queueChain.then(async () => {
    const apply = async () => {
      if (requireSession() !== session) return;
      const queue = await loadQueuedDmMessages();
      if (requireSession() !== session) return;
      await saveQueuedDmMessages(mutate(queue));
    };
    // The chain above only serializes THIS context. The queue lives in
    // localStorage, which a second tab (or the installed PWA alongside the
    // browser) shares: both read the same blob, both write blob+1, and the
    // loser's message is gone with no trace and no retry. Best effort - a
    // browser without the Lock Manager still gets the in-context chain.
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request("awful:dm-queue", apply);
      return;
    }
    await apply();
  });
  // One failed mutation must not wedge the chain for every later one.
  _queueChain = run.catch(() => {});
  return run;
}

/**
 * Park a frame for a peer who is not reachable right now. Exported because
 * DM sync batches (files, plugin cards, plugin updates) get the same
 * treatment as chat envelopes - they used to be fire-and-forget.
 */
export function queueDmMessage(
  toDid: string,
  data: Uint8Array,
  messageId?: string
): Promise<void> {
  return mutateDmQueue((queue) => {
    while (queue.length >= DM_QUEUE_MAX) queue.shift();
    queue.push({
      to: toDid,
      data: Array.from(data),
      queuedAt: Date.now(),
      messageId,
    });
    return queue;
  });
}

/**
 * Record that a queued message will only ever go peer to peer.
 *
 * `Message["status"]` is a closed union owned elsewhere, so a distinct
 * "queued-p2p" cannot live there. This set is the same fact by another
 * route: an id in it is queued, waiting, and too big for the offline inbox.
 */
export function noteMailboxDeposit(
  messageId: string,
  result: MailboxDepositResult
): void {
  const next = new Set(transportState.dmQueuedP2POnly);
  if (result === "oversized") next.add(messageId);
  else if (!next.delete(messageId)) return;
  transportState.dmQueuedP2POnly = next;
}

/**
 * Who a DM room is with, from the room code alone.
 *
 * The code is a hash of both DIDs, so it cannot be reversed - the stored
 * room row carries the answer. Needed because the conversation a message
 * belongs to is not the conversation on screen: a plugin card fired from a
 * pinned widget, or a file dropped into the floating panel, used to be sent
 * to whoever the pane happened to be showing.
 */
export async function dmPeerDidForRoom(
  roomCode: string
): Promise<string | null> {
  if (!roomCode.startsWith("dm-")) return null;
  const room = await getRoom(roomCode).catch(() => null);
  const stored = (room as DMRoom | null | undefined)?.participantDid;
  if (stored && looksLikeDid(stored)) return stored;
  // A room row from before participantDid was written: fall back to the two
  // conversations we can still name, and only if the code matches.
  const selfDid = identityStore.did ?? _transport.selfId();
  for (const candidate of [transportState.activeDmPeerId, dmPanel.peerId]) {
    if (!candidate) continue;
    const did = dmPeerDid(candidate);
    if (!did) continue;
    if ((await hashDmRoomCode(selfDid, did)) === roomCode) return did;
  }
  return null;
}

export async function dmConversationCodeFor(
  peerIdOrDid: string
): Promise<string | null> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  return dmConversationCodeAsync(resolvedPeerId);
}

/**
 * Get the stable DM room code for a conversation with a peer.
 * Uses DIDs (stable identity) not peer IDs (ephemeral).
 */
/**
 * The peer's stable DID, or null if we have not verified it yet.
 *
 * A DM room code is a hash of the two DIDs, so a peerId standing in for one of
 * them produces a DIFFERENT room: the conversation silently forks into a
 * second thread that never merges back. A peerId cannot be turned into a DID
 * any more (devices carry their own libp2p keys), so the only safe answer when
 * the binding has not arrived is "not yet".
 */
export function dmPeerDid(peerIdOrDid: string): string | null {
  if (looksLikeDid(peerIdOrDid)) return peerIdOrDid;
  const resolved = resolveToDid(peerIdOrDid, _peerIdToDid);
  return looksLikeDid(resolved) ? resolved : null;
}

export async function dmConversationCodeAsync(
  peerIdOrDid: string
): Promise<string | null> {
  const selfDid = identityStore.did ?? _transport.selfId();
  const peerDid = dmPeerDid(peerIdOrDid);
  if (!peerDid) return null;
  return hashDmRoomCode(selfDid, peerDid);
}

export async function openDmConversation(
  peerIdOrDid: string
): Promise<boolean> {
  if (!_transport.selfId()) return false;
  // A faster second switch supersedes this one: view state and read acks
  // belong to the conversation the user asked for LAST.
  const session = requireSession();
  const currentView = beginConversationOpen();
  const stillCurrent = () => {
    try { return currentView() && requireSession() === session; } catch { return false; }
  };
  // Use the input as-is if we can't resolve to a peer ID
  // This supports opening DMs with DIDs directly
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  if (!resolvedPeerId) return false;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  if (!roomCode) {
    transportState.error =
      "Cannot open this conversation yet: waiting to verify who this peer is.";
    return false;
  }
  if (!stillCurrent()) return false;
  // Claim the conversation BEFORE the awaits, exactly like joinRoom does:
  // while _loadHistory and the hydrations were in flight, roomCode still
  // named the room being LEFT, so a live message or sync batch for that room
  // matched the "is this for the open room" checks and landed in the freshly
  // loaded DM view - room history inside a DM until the next reload.
  transportState.chatMode = "dm";
  transportState.activeDmPeerId = resolvedPeerId;
  transportState.roomCode = roomCode;
  transportState.roomName = resolveDmDisplayName(resolvedPeerId);
  transportState.messages = [];
  // The roster belongs to the room being left. Kept, it was answered to
  // this DM's peer as the DM's own (a stranger's request included): every
  // member of the last private room opened, offline ones too.
  transportState.roomUsers = [];
  await _loadHistory(roomCode, stillCurrent);
  // Blob URLs for saved attachments AND re-seeding (a peer sees 0 seeders
  // for a file we are plainly looking at without the torrent), from one
  // decrypt pass, in the BACKGROUND: awaiting it froze the conversation
  // open for as long as its images take to decrypt and re-hash.
  void _hydrateAndSeedAttachments(roomCode).catch((err) =>
    console.warn("[dm] attachment hydrate/seed failed:", err)
  );
  if (!stillCurrent()) return false;
  transportState.connected = true;

  // Everything now on screen counts as read - tell the sender.
  const selfDid = identityStore.did ?? _transport.selfId();
  const theirMessageIds = transportState.messages
    .filter((m) => m.roomCode === roomCode && m.senderId !== selfDid)
    .map((m) => m.id);
  if (theirMessageIds.length === 0) {
    // The loaded page can be all our own messages; ack their newest from
    // storage so the sender-side cascade still marks the backlog read.
    const lastTheirs = await getLastMessageFrom(roomCode, selfDid);
    if (lastTheirs) theirMessageIds.push(lastTheirs.id);
  }
  if (!stillCurrent()) return false;
  sendDmReadAcks(resolvedPeerId, theirMessageIds);
  return true;
}

/**
 * Open a conversation in the floating panel, leaving the view alone.
 *
 * The counterpart to openDmConversation, which claims the whole chat pane. Use
 * this when the user asked to message somebody WITHOUT leaving what they are
 * doing - from a call tile, most obviously, where taking over the pane also
 * unmounts the call stage.
 */
let panelOpenEpoch = 0;
export async function openDmPanel(peerIdOrDid: string): Promise<boolean> {
  if (!_transport.selfId()) return false;
  const epoch = ++panelOpenEpoch;
  const session = requireSession();
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  if (!resolvedPeerId) return false;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  if (epoch !== panelOpenEpoch || requireSession() !== session) return false;
  if (!roomCode) {
    transportState.error =
      "Cannot open this conversation yet: waiting to verify who this peer is.";
    return false;
  }
  // Files and plugin cards in a DM ride the room topic, so the panel has to be
  // subscribed for the same reasons the pane is. Text arrives over a direct
  // stream either way.

  if (dmPanel.peerId !== resolvedPeerId) {
    Object.assign(dmPanel, defaultPanelPosition());
  }
  dmPanel.peerId = resolvedPeerId;
  dmPanel.roomCode = roomCode;
  dmPanel.peerName = resolveDmDisplayName(resolvedPeerId);
  dmPanel.messages = [];
  dmPanel.minimized = false;
  dmPanel.loading = true;

  const page = await getMessages(roomCode);
  // The user can close the panel, or open another conversation in it, while
  // the page is in flight.
  if (epoch !== panelOpenEpoch || requireSession() !== session || dmPanel.roomCode !== roomCode) return false;
  dmPanel.messages = page;
  dmPanel.loading = false;

  const selfDid = identityStore.did ?? _transport.selfId();
  const theirs = page
    .filter((m) => m.senderId !== selfDid)
    .map((m) => m.id);
  if (theirs.length) sendDmReadAcks(resolvedPeerId, theirs);
  await markRoomSeen(roomCode, page[page.length - 1]?.lamport ?? 0).catch(
    () => {}
  );
  await refreshDmRooms();
  transportState.dmVersion += 1;
  return true;
}

export function closeDmPanel(): void {
  panelOpenEpoch++;
  dmPanel.peerId = null;
  dmPanel.roomCode = null;
  dmPanel.peerName = "";
  dmPanel.messages = [];
  dmPanel.minimized = false;
  dmPanel.loading = false;
}

export interface DirectMessageOptions {
  replyTo?: { id: string; senderName: string; content: string };
  reaction?: { to: string; emoji: string; op: "add" | "remove" };
  /**
   * Send to this peer instead of the conversation on screen. The floating DM
   * panel is a second conversation surface, so "the active DM" stopped being
   * the only possible answer to "who is this for".
   */
  peerId?: string;
}

export async function sendDirectMessage(
  text: string,
  options: DirectMessageOptions = {}
): Promise<void> {
  const guard = captureDmOwnership();
  const session = requireSession();
  const peerId = options.peerId ?? transportState.activeDmPeerId;
  if (!peerId) throw new Error("Open a direct conversation before sending");
  const body = text.trim();
  // Reactions travel as empty-bodied envelopes; everything else needs text.
  if (!body && !options.reaction) return;

  const roomCode = await ensureDmRoomForPeer(peerId);
  if (requireSession() !== session) throw new Error("Identity changed");
  // Answering a message request accepts it.
  if (roomCode) await acceptIfDmRequest(roomCode, peerId);
  if (requireSession() !== session) throw new Error("Identity changed");
  if (!roomCode) {
    // Sending into a peerId-derived room would file the message in a thread
    // the other side never reads.
    transportState.error = "Cannot send yet: still verifying who this peer is.";
    throw new Error(transportState.error);
  }

  const prepared = prepareOutgoingText(body);
  if (prepared.files.length && !options.reaction) {
    const { sendFiles } = await import("./transport.svelte");
    guard();
    await sendFiles(prepared.files, prepared.text, { roomCode, replyTo: options.replyTo });
    return;
  }

  const id = newMessageId(session.did);
  const ts = Date.now();
  // Monotonic per room: a behind-running clock must not file this message
  // below the peer's seen watermark. Shipped in the envelope so both sides
  // store the same value and watermarks stay comparable.
  const lamport = await nextDmLamport(roomCode, ts);
  if (requireSession() !== session) throw new Error("Identity changed");
  const envelope = encodeDmChatEnvelope({
    id,
    // A reaction's emoji doubles as the text so an older client renders it
    // as a message instead of dropping it.
    text: options.reaction ? options.reaction.emoji : body,
    ts,
    lamport,
    replyTo: options.replyTo,
    reaction: options.reaction,
  });

  // Key the offline queue by the STABLE DID so a queued message still matches
  // once the peer connects - even if we didn't know the DID at queue time.
  const peerDid = resolveToDid(peerId, _peerIdToDid);

  // Resolve to an actual peer ID (not a DID) before checking online status.
  // resolveDmPeerId already handles peerId→peerId and DID→peerId via _peerIdToDid,
  // but falls back to the DID itself when no mapping exists. We need a real peer ID
  // to check _transport.peers(), so we try didToPeerId as a second pass.
  let resolvedPeerId = resolveDmPeerId(peerId);
  if (resolvedPeerId && looksLikeDid(resolvedPeerId)) {
    resolvedPeerId =
      didToPeerId(resolvedPeerId, _peerIdToDid) ?? resolvedPeerId;
  }

  const isOnline =
    !!resolvedPeerId &&
    !looksLikeDid(resolvedPeerId) &&
    _transport.peers().includes(resolvedPeerId);

  let delivered = false;
  if (isOnline) {
    delivered = await sendDmFrame(resolvedPeerId!, envelope);
    rec(ev("dm.send", { peer: resolvedPeerId, d: { delivered } }));
  }
  if (requireSession() !== session) throw new Error("Identity changed");
  // STARTED here, awaited after the local echo. The queue write is now a
  // sealed read-modify-write of the whole queue (AES-GCM both ways), and
  // awaiting it here put all of that in front of the user's own bubble - the
  // exact send lag the echo below was reordered to remove.
  let queued: Promise<void> | null = null;
  if (!delivered) {
    queued = queueDmMessage(peerDid, envelope, id);
    rec(
      ev("dm.queue", {
        peer:
          resolvedPeerId && !looksLikeDid(resolvedPeerId)
            ? resolvedPeerId
            : null,
        d: { delivered: false },
      })
    );
    // Opt-in relay mailbox: a sealed copy waits for the offline peer so
    // delivery does not require both of you online at once. Best-effort -
    // the queue keeps retrying P2P either way.
    if (peerDid.startsWith("did:")) {
      const { depositDmToMailbox } = await import("./mailbox.svelte");
      guard();
      void depositDmToMailbox(peerDid, envelope).then((result) => {
        guard();
        noteMailboxDeposit(id, result);
        // One tick: the relay holds a sealed copy, so the message is out of
        // this device's hands even though nobody has it yet. It sat on the
        // clock until their ack came back, which for an offline peer could
        // be days, and read as "never left".
        if (result === "sent") applyMessageStatus(id, "sent");
      }).catch(() => {});
    }
  }

  const mySenderId = identityStore.did ?? _transport.selfId();
  let msg: Message = {
    id,
    roomCode,
    senderId: mySenderId,
    senderName: "You",
    timestamp: ts,
    lamport,
    type: options.reaction
      ? MessageType.Reaction
      : options.replyTo
        ? MessageType.Reply
        : MessageType.Text,
    content: options.reaction ? "" : body,
    replyTo: options.replyTo,
    reactionTo: options.reaction?.to,
    reactionEmoji: options.reaction?.emoji,
    reactionOp: options.reaction?.op,
    attachments: [],
    // "sending" = queued locally, "sent" = handed to the transport;
    // "delivered"/"read" arrive later via acks
    status: delivered ? "sent" : "sending",
  };

  // Sign the message before storing
  msg = signMessage(msg);

  // Echo BEFORE the storage chain: put + watermark + seen + rooms refresh
  // gated the local echo behind four storage operations, which read as
  // send lag. Status updates flow into this same object via
  // applyMessageStatus once acks arrive.
  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === peerId
  ) {
    transportState.messages = appendSorted(transportState.messages, msg);
  }
  // The panel keys on the room code, so this is a no-op unless the panel is
  // showing this very conversation - including when the pane behind it shows
  // something else entirely, which is the whole reason the panel exists.
  appendToDmPanel(msg);

  // Now that the bubble is on screen, make sure the offline queue write
  // actually landed - it is what retries this message after a reload.
  if (queued) await queued;

  if (requireSession() !== session) throw new Error("Identity changed");
  await putMessage(msg, guard);
  await setWatermark(roomCode, mySenderId, msg.lamport, guard);
  // Sending is reading: your own message must not count as unread, and the
  // watermark - not a sender-id comparison - is what the badge trusts.
  await markRoomSeen(roomCode, msg.lamport, guard);
  await refreshDmRooms();
  guard();
  transportState.dmVersion += 1;
}

/** The peer's live transport id, or null when they are not connected now. */
function _connectedDmPeerId(peerIdOrDid: string): string | null {
  let resolved = resolveDmPeerId(peerIdOrDid);
  if (resolved && looksLikeDid(resolved)) {
    resolved = didToPeerId(resolved, _peerIdToDid) ?? resolved;
  }
  return resolved && !looksLikeDid(resolved) && _transport.peers().includes(resolved)
    ? resolved
    : null;
}

/**
 * Send read acks to a peer for messages we just displayed.
 * Fire-and-forget: if the peer is offline the acks are simply dropped -
 * they'll be re-sent the next time the conversation is opened while
 * both peers are online (idempotent on the receiving side).
 *
 * Never into a message request. Opening one is how it gets judged, and a
 * stranger the user has not accepted learned from the receipt that, and
 * when, their message was looked at. The receipt it held back goes out
 * when the request is accepted (acceptIfDmRequest).
 */
export function sendDmReadAcks(peerId: string, messageIds: string[]): void {
  if (!messageIds.length) return;
  void (async () => {
    const roomCode = await dmConversationCodeAsync(peerId);
    if (!roomCode || (await dmRequestPending(roomCode))) return;
    const envelope = encodeDmReadEnvelope(messageIds);
    const resolved = _connectedDmPeerId(peerId);
    if (resolved && (await sendDmFrame(resolved, envelope))) return;
    // Offline: leave the receipt in their mailbox instead of dropping it. The
    // sender's ticks were stuck at "sent" until the two of you next happened
    // to be online together, which for an offline-delivered DM could be never.
    await depositDmReceipt(peerId, envelope);
  })().catch(() => {});
}

/**
 * Tell a DM peer we are typing, or that we stopped. Only while they are
 * online: unlike a receipt it never goes to the mailbox, where it would be
 * read long after it stopped being true.
 */
export function sendDmTyping(peerId: string, typing: boolean): void {
  if (typing && !typingPrefs.sendTyping) return;
  const resolved = _connectedDmPeerId(peerId);
  if (!resolved) return;
  const frame: WireTyping = { type: MessageType.Typing, typing };
  void sendDmFrame(resolved, encode(frame)).catch(() => {});
}

/** Seal a receipt into the peer's relay mailbox. Best effort by design. */
export async function depositDmReceipt(
  peerIdOrDid: string,
  envelope: Uint8Array
): Promise<void> {
  const session = requireSession();
  const did = dmPeerDid(peerIdOrDid);
  if (!did) return;
  const { depositDmToMailbox } = await import("./mailbox.svelte");
  if (requireSession() !== session) return;
  await depositDmToMailbox(did, envelope, "receipt").catch(() => "failed");
}

// Flushes are serialized and sent entries are removed against a FRESH read
// of the queue: a snapshot write-back would clobber messages queued (for any
// peer) while the awaited sends were in flight.
let _flushChain: Promise<void> = Promise.resolve();

/** All live DM envelopes and batches use the pairwise channel, never raw send. */
export async function sendDmFrame(peerId: string, data: Uint8Array): Promise<boolean> {
  try {
    const session = requireSession();
    const room = await ensureDmRoomForPeer(peerId);
    if (!room || requireSession() !== session) return false;
    return await _transport.sendRoom(peerId, room, data);
  } catch { return false; }
}

export function flushQueuedDmForPeer(peerId: string): Promise<void> {
  _flushChain = _flushChain.catch(() => {}).then(() => _flushQueuedDmForPeer(peerId));
  return _flushChain;
}

/**
 * Drain everything queued for anybody currently connected.
 *
 * The queue only ever drained on a "connect" event, and the event you miss
 * is exactly the one that leaves a message sitting there - a peer already
 * connected when the queue was written fires none at all. One pass over the
 * queue rather than one per peer: this runs on the repair tick, and every
 * pass costs a decrypt of the whole sealed blob.
 */
export function flushQueuedDmForConnectedPeers(): Promise<void> {
  _flushChain = _flushChain.catch(() => {}).then(() => _flushAllQueuedDm());
  return _flushChain;
}

async function _flushAllQueuedDm(): Promise<void> {
  const session = requireSession();
  const peerIds = _transport.peers();
  if (peerIds.length === 0) return;
  const byDid = new Map<string, string>();
  for (const pid of peerIds) {
    const did = _peerIdToDid.get(pid);
    if (did) byDid.set(did, pid);
  }
  const connected = new Set(peerIds);
  const sent = new Set<string>();
  for (const entry of await loadQueuedDmMessages()) {
    if (requireSession() !== session) return;
    // Entries are keyed by DID, except the older ones queued before the
    // binding arrived, which are keyed by the raw peerId.
    const pid = byDid.get(entry.to) ?? (connected.has(entry.to) ? entry.to : null);
    if (!pid) continue;
    const ok = await sendDmFrame(pid, new Uint8Array(entry.data));
    if (requireSession() !== session) return;
    if (!ok) continue;
    sent.add(queueEntryKey(entry));
    if (entry.messageId) {
      applyMessageStatus(entry.messageId, "sent");
      noteMailboxDeposit(entry.messageId, "sent");
    }
  }
  if (sent.size === 0) return;
  await mutateDmQueue((queue) =>
    queue.filter((e) => !sent.has(queueEntryKey(e)))
  );
  rec(ev("dm.flush", { d: { removed: sent.size } }));
}

function queueEntryKey(e: QueuedMessage): string {
  return `${e.to}|${e.queuedAt}|${e.messageId ?? ""}`;
}

async function _flushQueuedDmForPeer(peerId: string): Promise<void> {
  const session = requireSession();
  const peerDid =
    _peerIdToDid.get(peerId) ?? resolveToDid(peerId, _peerIdToDid);
  if (!peerDid) return; // Can't flush if we don't know their DID yet

  const sent = new Set<string>();
  for (const entry of await loadQueuedDmMessages()) {
    if (requireSession() !== session) return;
    // Match entries keyed by the DID *or* by the raw peerId - older entries
    // queued before the DID was known were stored under the peerId.
    if (entry.to !== peerDid && entry.to !== peerId) continue;
    const ok = await sendDmFrame(peerId, new Uint8Array(entry.data));
    if (requireSession() !== session) return;
    if (ok) {
      sent.add(queueEntryKey(entry));
      if (entry.messageId) {
        applyMessageStatus(entry.messageId, "sent");
        // It went peer to peer after all, so the "too long for the offline
        // inbox" note has to come off with it.
        noteMailboxDeposit(entry.messageId, "sent");
      }
    }
  }
  if (sent.size === 0) return;
  // The fresh read and the write-back have to be one uninterrupted step, or a
  // message queued (for any peer) while the sends above were in flight is
  // clobbered by this write - which is exactly what the comment above promises.
  await mutateDmQueue((queue) =>
    queue.filter((e) => !sent.has(queueEntryKey(e)))
  );
  rec(ev("dm.flush", { peer: peerId, d: { removed: sent.size } }));
}

/**
 * A readable name for the other side of a DM.
 *
 * `peerId` is a real peer id on the live path but the sender's DID on the
 * mailbox path, so both keys are tried either way: the peerId-to-DID map misses
 * for a DID input, which used to drop straight through to a `did:key:z6Mk`
 * fragment as the sender's name.
 */
export function resolveDmDisplayName(peerId: string): string {
  return knownDmName(peerId) ?? peerId.slice(0, 12);
}

/**
 * The name we know the other side of a DM by - their proven profile's, or
 * the nickname we saved for them - or null when we know none. A DID's first
 * characters are "did:key:z6Mk" for everyone, so where a stand-in would be
 * read as a name (a notification's title), the caller picks its own.
 */
export function knownDmName(peerId: string): string | null {
  const did = _peerIdToDid.get(peerId);
  const names = transportState.peerNames;
  const named = (did ? names.get(did) : undefined) ?? names.get(peerId);
  if (named) return named;
  // The phonebook nickname survives a reload even when no profile was ever
  // cached, which is exactly the case a mailbox DM from a stranger hits.
  const entry = roomsStore.phonebook.find(
    (e) => e.peerId === peerId || e.did === peerId || (!!did && e.did === did)
  );
  return entry?.nickname || null;
}

/**
 * The composer warning for a DM with this person, or null (see
 * dm-inbox-notice.ts). `myInboxOff` comes from the caller, which already
 * reads the mailbox prefs reactively - importing them here would close the
 * mailbox -> transport -> dm cycle.
 */
export function dmInboxNoticeFor(
  peerIdOrDid: string,
  myInboxOff: boolean
): string | null {
  const did = dmPeerDid(peerIdOrDid);
  if (!did) return null;
  void transportState.peerDidVersion;
  const peerId = looksLikeDid(peerIdOrDid)
    ? didToPeerId(did, _peerIdToDid)
    : peerIdOrDid;
  return dmInboxNotice({
    peerName: resolveDmDisplayName(peerId ?? peerIdOrDid),
    peerOnline: !!peerId && transportState.peers.includes(peerId),
    theirInboxOff: transportState.peerInboxOff.has(did),
    myInboxOff,
  });
}

export async function joinPhonebookDmRooms(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid) return;
  const entries = await getPhonebookEntries();
  for (const entry of entries) {
    // entry.did first: this runs right after connecting, when no peer has been
    // bound yet, so resolving the peerId would subscribe to a room code built
    // from a peerId and quietly miss every DM sent to the real one.
    const peerDid = dmPeerDid(entry.did ?? entry.peerId);
    if (!peerDid) continue;
    await ensureDmRoomForPeer(peerDid);
  }
}

/**
 * Message requests held at once. Past this, a stranger's new conversation is
 * dropped (a copy in the mailbox stays there for a later collect): every
 * request is a stored room, a relay registration while it is joined and one
 * of the transport's 512 conversation bindings, so a script minting
 * identities could otherwise fill all three - and bury the user's real rooms
 * at the relay, which caps a peer's registrations into empty rooms. Only
 * requests somebody wrote in count (_heldRequests), and deleting requests
 * makes room for new ones.
 */
export const MAX_DM_REQUESTS = 20;

/**
 * New conversations nobody here asked for, per unlocked session, from people
 * we do not know for sure: strangers' requests and members of rooms we
 * share. Sharing a room proves nothing about anyone - a member can list
 * identities it mints in a protected room (a profile over the room's channel
 * is all it takes), and each was "known", so one member could open DM after
 * DM with us until the transport's 512 conversation bindings were gone.
 * Contacts and people we reached out to are never counted. Past it, a new
 * conversation is held back like a full request: dropped live, left in the
 * mailbox for the next session. What such DMs can keep joined is bounded
 * apart, across sessions too: MAX_DMS_JOINED_FOR_THEM.
 *
 * Only a conversation that keeps something is charged. Admitting one takes
 * its unit at once, so a burst cannot slip past, and one undone because
 * nothing it brought was stored, or never made at all, gives it back. The
 * unit used to stay spent: sixty-four junk batches from anyone who knew our
 * DID, each with one signed row the batch handler then refused, left
 * nothing behind and held back every first contact - room-mates' too - for
 * the rest of the session.
 *
 * What is left: a member of a room we share can still spend it all with as
 * many DMs from identities it mints, a message in each. Those are listed
 * and can be deleted, but until the next session every other new
 * conversation from someone we do not know for sure is held back.
 */
export const MAX_UNSOLICITED_DMS = 64;
let _unsolicited: { session: UnlockedSession; rooms: Set<string> } | null = null;

/** This session's new conversations charged to MAX_UNSOLICITED_DMS. */
function _unsolicitedCharged(session: UnlockedSession): Set<string> {
  if (_unsolicited?.session !== session) _unsolicited = { session, rooms: new Set() };
  return _unsolicited.rooms;
}

/**
 * Conversations joined for an introduction alone, with nothing stored. The
 * other side has just opened a DM with us, so the channel has to be up for
 * their first message to arrive live; but the DM is stored only with that
 * message, or when the user opens it. An introduction never followed by one
 * used to leave a DM behind that nothing listed and nothing could delete,
 * joined again at every start. Oldest out first past the bound - nothing is
 * lost with one, their next introduction joins it again. A post-quantum
 * state the introduction agreed waits here for the DM it is stored with.
 */
const MAX_PROVISIONAL_DMS = 32;
const _provisional = new Map<string, DmPqState | undefined>();

/**
 * Conversations joined on the other side's account rather than the user's:
 * a saved DM restored at connect, or one joined because the other side
 * wrote or introduced themselves - any DM but a contact's or one the user
 * opened or wrote in this session. Each holds one of the transport's 512
 * conversation bindings, and what others can make us hold has to leave the
 * rest to the user. A member of a room we share can have up to
 * MAX_UNSOLICITED_DMS new DMs from identities it mints stored with us each
 * session, and every stored DM was joined again at each connect, so a few
 * unlocks gave them every binding. Past the bound a conversation is still
 * stored and carries on through the mailbox; opening it joins it. Released
 * on lock with the rest of the session.
 */
export const MAX_DMS_JOINED_FOR_THEM = 128;
/**
 * How many saved DMs connecting joins, the ones the user read last first.
 * The rest of the bound is left for whoever turns up during the session.
 */
export const SAVED_DMS_JOINED_AT_CONNECT = 64;
let _forThem: { session: UnlockedSession; rooms: Set<string> } | null = null;

/** This session's joins on the other side's account (MAX_DMS_JOINED_FOR_THEM). */
function _joinedForThem(session: UnlockedSession): Set<string> {
  if (_forThem?.session !== session) _forThem = { session, rooms: new Set() };
  return _forThem.rooms;
}

/** Leave a conversation for good, whoever's account it was joined on. */
function _forgetJoin(roomCode: string): void {
  _transport.forgetConversation(roomCode);
  _provisional.delete(roomCode);
  _forThem?.rooms.delete(roomCode);
}

/**
 * Whoever this session reached out to, by peerId or DID. An introduction we
 * start comes back through the same hook as one a stranger starts, often
 * before our own call has stored the room, and must not come back a request.
 */
const _solicited = new Set<string>();
const _requestsInFlight = new Set<string>();
let _requestChain: Promise<unknown> = Promise.resolve();

function _noteSolicited(peerIdOrDid: string | null | undefined): void {
  if (!peerIdOrDid) return;
  if (_solicited.size >= 1024) _solicited.clear();
  _solicited.add(peerIdOrDid);
}

/**
 * How long a request takes a slot before anything is in it. It is stored a
 * moment before its first message, and a burst must not slip past the cap
 * in between.
 */
const REQUEST_SETTLE_MS = 60_000;

/**
 * Whether anything was ever written in this conversation, from the index
 * alone: no row is opened, so one that will not open still counts. A read
 * that fails counts as yes.
 */
async function _holdsMessages(roomCode: string): Promise<boolean> {
  try {
    return await roomHoldsMessages(roomCode);
  } catch {
    return true;
  }
}

/**
 * Requests that take a slot: the ones somebody wrote in, and any made a
 * moment ago. Every stored request used to count, and a request was stored
 * before its message was checked - so twenty refused messages, from anyone
 * who knows our DID, left twenty empty requests that nothing listed and
 * nothing could delete, and no stranger reached us again.
 */
async function _heldRequests(rooms: (Room | DMRoom)[], now: number): Promise<number> {
  const requests = rooms.filter((r) => r.type === "dm" && (r as DMRoom).request === true);
  const held = await Promise.all(
    requests.map(async (r) =>
      now - (r.createdAt ?? 0) < REQUEST_SETTLE_MS || (await _holdsMessages(r.roomCode))
    )
  );
  return held.filter(Boolean).length;
}

/**
 * What admitting a new conversation reads: our contacts, every room's
 * members and the requests that take a slot. Read once for a burst, not per
 * sender: a mailbox drain admits one after another, a DM the full requests
 * cannot take waits in the mailbox and comes back every collect, and each
 * read decrypts every contact and room record we hold. Dropped whenever
 * this module stores, accepts or deletes a DM, and kept a second at most.
 */
interface AdmissionView {
  session: UnlockedSession;
  generation: number;
  at: number;
  contacts: PhonebookEntry[];
  roomMates: Set<string>;
  held: number;
}
const ADMISSION_VIEW_MS = 1_000;
let _admission: AdmissionView | null = null;
let _admissionGeneration = 0;

function _admissionChanged(): void {
  _admissionGeneration += 1;
}
onIdentityLock(() => {
  _admission = null;
  _admissionChanged();
  _unsolicited = null;
  // Their bindings too: kept across a lock, they piled up unlock after
  // unlock in a page that was never reloaded.
  for (const roomCode of [..._provisional.keys(), ...(_forThem?.rooms ?? [])]) {
    _transport.forgetConversation(roomCode);
  }
  _provisional.clear();
  _forThem = null;
});

async function _admissionView(): Promise<AdmissionView> {
  const session = requireSession();
  const now = Date.now();
  const cached = _admission;
  if (
    cached?.session === session &&
    cached.generation === _admissionGeneration &&
    now - cached.at < ADMISSION_VIEW_MS
  ) {
    return cached;
  }
  const generation = _admissionGeneration;
  const [contacts, rooms] = await Promise.all([getPhonebookEntries(), getAllRooms()]);
  const roomMates = new Set(
    rooms.filter((r) => r.type !== "dm").flatMap((r) => r.participants ?? [])
  );
  const held = await _heldRequests(rooms, now);
  _admission = { session, generation, at: now, contacts, roomMates, held };
  return _admission;
}

/** In the phonebook, or reached out to by us. */
function _isTrustedDmPeer(peerDid: string, view: AdmissionView): boolean {
  if (_reachedOutTo(peerDid)) return true;
  return view.contacts.some((e) => e.did === peerDid || dmPeerDid(e.peerId) === peerDid);
}

/** Whether this session reached out to them: opened their DM, or wrote in it. */
function _reachedOutTo(peerDid: string): boolean {
  for (const id of _solicited) {
    if (id === peerDid || dmPeerDid(id) === peerDid) return true;
  }
  return false;
}

/**
 * Joins an introduction alone may cost us a minute, from anyone not in the
 * phonebook and not reached out to. Each is a relay registration, and once
 * MAX_PROVISIONAL_DMS are held each also sends the oldest away - a departure
 * that closes every room handshake still in progress. An introduction costs
 * its sender nothing but a minted identity, so a stranger who knew our
 * device could keep that churning, one join and one departure per
 * introduction. Past this an introduction joins nothing, and the first
 * message it was for comes through the mailbox instead.
 */
export const INTRODUCTION_JOINS_PER_MINUTE = 16;
let _introductionJoins: { session: UnlockedSession; at: number[] } | null = null;

function _chargeIntroductionJoin(session: UnlockedSession): boolean {
  const now = Date.now();
  if (_introductionJoins?.session !== session) _introductionJoins = { session, at: [] };
  const at = _introductionJoins.at;
  while (at.length > 0 && now - at[0] >= 60_000) at.shift();
  if (at.length >= INTRODUCTION_JOINS_PER_MINUTE) return false;
  at.push(now);
  return true;
}

/**
 * Decide, one at a time so the caps hold under a burst, what an unsolicited
 * new conversation becomes: an ordinary DM (someone we know), a request, or
 * nothing (the requests, or this session's new conversations, are full). A
 * "request" verdict reserves a slot until the caller releases it, once the
 * room is stored or abandoned. `reserve` false asks without taking anything
 * a message would: an introduction's join stores nothing, and its first
 * message is admitted again. The join itself is charged, though, unless
 * they are a contact or someone we reached out to.
 */
function _admitUnsolicited(
  peerDid: string,
  roomCode: string,
  reserve = true
): Promise<"known" | "request" | "full"> {
  const run = _requestChain.then(async () => {
    const view = await _admissionView();
    if (_isTrustedDmPeer(peerDid, view)) return "known" as const;
    const verdict = _admitUntrusted(peerDid, roomCode, reserve, view);
    if (!reserve && verdict !== "full" && !_chargeIntroductionJoin(view.session)) {
      return "full" as const;
    }
    return verdict;
  });
  _requestChain = run.catch(() => {});
  return run;
}

function _admitUntrusted(
  peerDid: string,
  roomCode: string,
  reserve: boolean,
  view: AdmissionView
): "known" | "request" | "full" {
  const charged = _unsolicitedCharged(view.session);
  // Once a session per conversation: one deleted since and written in again
  // is the same conversation.
  if (!charged.has(roomCode) && charged.size >= MAX_UNSOLICITED_DMS) return "full";
  if (view.roomMates.has(peerDid)) {
    if (reserve) charged.add(roomCode);
    return "known";
  }
  if (_requestsInFlight.has(roomCode)) return "request";
  if (view.held + _requestsInFlight.size >= MAX_DM_REQUESTS) return "full";
  if (reserve) {
    _requestsInFlight.add(roomCode);
    charged.add(roomCode);
  }
  return "request";
}

/**
 * Whether an introduction alone may join a DM we hold with nothing in it:
 * charged like a new one (INTRODUCTION_JOINS_PER_MINUTE).
 */
function _admitIntroductionJoin(peerDid: string): Promise<boolean> {
  const run = _requestChain.then(async () => {
    const view = await _admissionView();
    return _isTrustedDmPeer(peerDid, view) || _chargeIntroductionJoin(view.session);
  });
  _requestChain = run.catch(() => {});
  return run;
}

/**
 * Join a conversation an introduction alone asked for, storing nothing (see
 * _provisional). The oldest such join makes way past the bound.
 */
function _joinProvisionally(
  session: ReturnType<typeof requireSession>,
  roomCode: string,
  peerDid: string,
  pqState: DmPqState | undefined
): string {
  if (_joinedForThem(session).has(roomCode)) {
    // Already counted on their account: joined again there, under the key
    // it has now.
    joinDmConversation(_transport, session, roomCode, peerDid, pqState);
    return roomCode;
  }
  if (!_provisional.has(roomCode)) {
    for (const oldest of _provisional.keys()) {
      if (_provisional.size < MAX_PROVISIONAL_DMS) break;
      _provisional.delete(oldest);
      _transport.forgetConversation(oldest);
    }
  }
  joinDmConversation(_transport, session, roomCode, peerDid, pqState);
  _provisional.delete(roomCode);
  _provisional.set(roomCode, pqState);
  return roomCode;
}

/**
 * Join the saved DMs at connect, on the other side's account (see
 * MAX_DMS_JOINED_FOR_THEM): the ones somebody wrote in, those the user read
 * last first, at most SAVED_DMS_JOINED_AT_CONNECT - and, on the user's,
 * any the user opened or wrote in this session. Joining every stored DM
 * gave whoever could get DMs stored with us the conversation bindings, at
 * every start: the empty ones an older build made for introductions alone,
 * and the ones a room member's minted identities pile up session after
 * session. One left out is joined when the user opens it, or when the other
 * side writes or introduces themselves while there is room. Contacts are
 * joined by joinPhonebookDmRooms whatever they hold, requests not at all.
 */
export async function joinSavedDms(rooms: (Room | DMRoom)[]): Promise<void> {
  const session = requireSession();
  const contacts = new Set(
    (await getPhonebookEntries()).map((e) => dmPeerDid(e.did ?? e.peerId))
  );
  const saved = rooms
    .filter(
      (r): r is DMRoom =>
        r.type === "dm" &&
        (r as DMRoom).request !== true &&
        !contacts.has((r as DMRoom).participantDid)
    )
    .sort(
      (a, b) =>
        (b.lastSeenLamport ?? 0) - (a.lastSeenLamport ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );
  const written = await Promise.all(saved.map((r) => _holdsMessages(r.roomCode)));
  if (requireSession() !== session) return;
  const theirs = _joinedForThem(session);
  let joined = 0;
  for (const [i, room] of saved.entries()) {
    if (!written[i]) continue;
    const roomCode = room.roomCode;
    // One the user opened or wrote in this session is theirs, and comes back
    // joined whatever others hold - after another tab held the node, say.
    const mine = _reachedOutTo(room.participantDid);
    if (!mine) {
      if (joined >= SAVED_DMS_JOINED_AT_CONNECT) continue;
      // Joined on the user's account already.
      if (
        _transport.rooms().includes(roomCode) &&
        !theirs.has(roomCode) &&
        !_provisional.has(roomCode)
      ) {
        continue;
      }
      if (!theirs.has(roomCode) && theirs.size >= MAX_DMS_JOINED_FOR_THEM) continue;
    }
    try {
      joinStoredRoom(_transport, roomCode, room);
    } catch {
      // Never include the record or secret in diagnostics.
      console.warn("[dm] skipped a saved DM that could not be joined");
      continue;
    }
    _provisional.delete(roomCode);
    if (mine) {
      theirs.delete(roomCode);
      continue;
    }
    theirs.add(roomCode);
    joined += 1;
  }
}

/**
 * Undo a conversation made for a first contact that brought nothing in: a
 * batch whose every row was refused, or that could not be joined. Left, it
 * was an empty request that nothing listed and nothing could delete; and
 * what admitting it charged is given back (MAX_UNSOLICITED_DMS).
 */
export async function dropDmIfEmpty(roomCode: string): Promise<void> {
  const guard = captureDmOwnership();
  if (await _holdsMessages(roomCode)) return;
  guard();
  _forgetJoin(roomCode);
  await deleteRoom(roomCode);
  _unsolicited?.rooms.delete(roomCode);
  _admissionChanged();
  await refreshDmRooms();
  guard();
  transportState.dmVersion += 1;
}

/**
 * The message requests an older build stored with nothing in them - made
 * for an introduction alone, or for a message it then refused. They held a
 * request slot each, for good. Run at connect; one made a moment ago is
 * left alone, as its first message may still be on its way into storage.
 */
export async function pruneEmptyDmRequests(rooms: (Room | DMRoom)[]): Promise<void> {
  const guard = captureDmOwnership();
  const now = Date.now();
  let pruned = false;
  for (const room of rooms) {
    if (room.type !== "dm" || (room as DMRoom).request !== true) continue;
    if (now - (room.createdAt ?? 0) < REQUEST_SETTLE_MS) continue;
    if (await _holdsMessages(room.roomCode)) continue;
    guard();
    _forgetJoin(room.roomCode);
    await deleteRoom(room.roomCode);
    _unsolicited?.rooms.delete(room.roomCode);
    _admissionChanged();
    pruned = true;
  }
  if (!pruned) return;
  await refreshDmRooms();
  guard();
  transportState.dmVersion += 1;
}

/** Whether this DM is a message request the user has not accepted. */
export function isDmRequestRoom(roomCode: string): boolean {
  return roomsStore.dmRooms.some(
    (r) => r.roomCode === roomCode && r.request === true
  );
}

/**
 * The same question for what has to wait until a request is accepted
 * (receipts): the stored record, and the sidebar's copy, which can only be
 * the more cautious of the two - an acceptance it has not caught up with.
 * A record that cannot be read counts as a request.
 */
export async function dmRequestPending(roomCode: string): Promise<boolean> {
  if (isDmRequestRoom(roomCode)) return true;
  try {
    return ((await getRoom(roomCode)) as DMRoom | undefined)?.request === true;
  } catch {
    return true;
  }
}

/** The user accepted a message request: an ordinary DM from now on. */
export async function acceptDmRequest(peerIdOrDid: string): Promise<void> {
  const roomCode = await ensureDmRoomForPeer(peerIdOrDid);
  if (!roomCode) return;
  if (await acceptIfDmRequest(roomCode, peerIdOrDid)) {
    transportState.dmVersion += 1;
  }
}

/**
 * Accept the request in this conversation, if it is one; resolves whether
 * it was. The Accept button, answering it (text or files) and saving the
 * person as a contact all come here.
 */
export async function acceptIfDmRequest(
  roomCode: string,
  peerIdOrDid: string
): Promise<boolean> {
  if (!(await setDmRequest(roomCode, false))) return false;
  _admissionChanged();
  await refreshDmRooms();
  _sendHeldReadReceipt(roomCode, peerIdOrDid);
  return true;
}

/**
 * The read receipt a request held back, now that it is accepted: for
 * whatever of theirs is on screen, in the pane or the panel. Nothing on
 * screen, nothing to say - opening it later sends one, as for any DM.
 */
function _sendHeldReadReceipt(roomCode: string, peerIdOrDid: string): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const shown =
    transportState.chatMode === "dm" && transportState.roomCode === roomCode
      ? transportState.messages
      : dmPanelIsShowing(roomCode)
        ? dmPanel.messages
        : [];
  const theirs = shown
    .filter((m) => m.roomCode === roomCode && m.senderId !== selfDid)
    .map((m) => m.id);
  sendDmReadAcks(peerIdOrDid, theirs.slice(-MAX_DM_READ_IDS));
}

export interface EnsureDmOptions {
  /**
   * Nobody on this device asked for this conversation: the other side's
   * introduction, or a delivery out of the mailbox. A NEW conversation with a
   * stranger then becomes a message request (or nothing, when the requests
   * are full). An existing one is joined as it is, request or not - only
   * acceptDmRequest, or answering it, accepts a request.
   */
  unsolicited?: boolean;
  /**
   * An introduction alone, unsolicited as well: a DM we hold is joined as it
   * is, a new one only joined - stored with its first message (see
   * _provisional).
   */
  provisional?: boolean;
}

/**
 * Join (and if need be create) the DM with this person.
 *
 * `pqState` is a post-quantum state an introduction just agreed with them
 * (room-security/pq-dm.ts). It is checked by deriving from it before anything
 * is stored, then recorded, and the conversation moves onto the hybrid key in
 * place: same room code, same history, a different key on the wire.
 */
export async function ensureDmRoomForPeer(
  peerIdOrDid: string,
  pqState?: DmPqState,
  opts: EnsureDmOptions = {}
): Promise<string | null> {
  const guard = captureDmOwnership();
  const session = requireSession();
  const unsolicited = opts.unsolicited || opts.provisional;
  if (!unsolicited) _noteSolicited(peerIdOrDid);
  let peerDid = dmPeerDid(peerIdOrDid);
  if (!peerDid && looksLikePeerId(peerIdOrDid)) {
    await _transport.introduceDm(peerIdOrDid);
    peerDid = dmPeerDid(peerIdOrDid);
  }
  const roomCode = peerDid ? await dmConversationCodeAsync(peerIdOrDid) : null;
  if (!roomCode || !peerDid) return null;
  if (!unsolicited) _noteSolicited(peerDid);
  if (pqState) hybridPairwiseRoomSecret(session.privateKey, didToPublicKey(peerDid), pqState);
  const existing = (await getRoom(roomCode)) as DMRoom | undefined;
  if (requireSession() !== session) throw new Error("Identity changed");
  // Joined for an introduction until now: stored under the key it agreed.
  if (!existing) pqState ??= _provisional.get(roomCode);
  let request = false;
  const charged = _unsolicitedCharged(session);
  const chargedBefore = charged.has(roomCode);
  // Another introduction for one an introduction already joined is joined
  // again as it is (an upgrade may have moved its key), and charged nothing.
  if (!existing && unsolicited && !(opts.provisional && _provisional.has(roomCode))) {
    const verdict = await _admitUnsolicited(peerDid, roomCode, !opts.provisional);
    if (verdict === "full") {
      console.warn("[dm] no room for a new conversation now; dropped one");
      return null;
    }
    request = verdict === "request";
  }
  if (!existing && opts.provisional) {
    return _joinProvisionally(session, roomCode, peerDid, pqState);
  }
  // An empty DM - one an older build stored for an introduction alone - is
  // joined the same bounded way, or introducing themselves as each of those
  // identities again took the bindings back. And it stays in the bound
  // however often they introduce themselves: a second introduction, or a
  // post-quantum upgrade, used to make the join permanent. One the user
  // opened is left as it is. Its record still takes a key the introduction
  // agreed.
  if (
    existing &&
    opts.provisional &&
    (_provisional.has(roomCode) || !_transport.rooms().includes(roomCode)) &&
    !(await _holdsMessages(roomCode))
  ) {
    guard();
    if (pqState) await setDmPqState(roomCode, pqState);
    guard();
    // Charged like a new one, unless an account holds it already.
    if (
      !_provisional.has(roomCode) &&
      !_joinedForThem(session).has(roomCode) &&
      !(await _admitIntroductionJoin(peerDid))
    ) {
      console.warn("[dm] no room for a new conversation now; dropped one");
      return null;
    }
    if (requireSession() !== session) throw new Error("Identity changed");
    return _joinProvisionally(session, roomCode, peerDid, pqState ?? existing.pq);
  }
  try {
    return await _joinDm(session, guard, peerIdOrDid, peerDid, roomCode, existing, pqState, request, !!unsolicited);
  } catch (error) {
    // Never made (the transport's bindings were full, say): a first contact
    // that could not be joined costs this session nothing.
    if (!existing && !chargedBefore) charged.delete(roomCode);
    throw error;
  } finally {
    if (request) _requestsInFlight.delete(roomCode);
  }
}

/**
 * Whose account a join goes on: the user's, the other side's (within
 * MAX_DMS_JOINED_FOR_THEM), still the introduction's that joined it
 * (_provisional) - or nobody's, and then it is not joined at all.
 */
function _joinAccount(
  session: UnlockedSession,
  roomCode: string,
  forThem: boolean
): "user" | "theirs" | "introduction" | null {
  if (!forThem) return "user";
  if (_provisional.has(roomCode)) return "introduction";
  const theirs = _joinedForThem(session);
  if (theirs.has(roomCode)) return "theirs";
  // Joined for the user already: it stays the user's.
  if (_transport.rooms().includes(roomCode)) return "user";
  return theirs.size < MAX_DMS_JOINED_FOR_THEM ? "theirs" : null;
}

function _noteJoin(
  session: UnlockedSession,
  roomCode: string,
  account: "user" | "theirs" | "introduction"
): void {
  const theirs = _joinedForThem(session);
  if (account === "user") {
    _provisional.delete(roomCode);
    theirs.delete(roomCode);
  } else if (account === "theirs" || theirs.size < MAX_DMS_JOINED_FOR_THEM) {
    // An introduction's join that a message is now stored in leaves the
    // bound that evicts, while there is room in this one.
    _provisional.delete(roomCode);
    theirs.add(roomCode);
  }
}

async function _joinDm(
  session: ReturnType<typeof requireSession>,
  guard: ReturnType<typeof captureDmOwnership>,
  peerIdOrDid: string,
  peerDid: string,
  roomCode: string,
  existing: DMRoom | undefined,
  pqState: DmPqState | undefined,
  request: boolean,
  /** Nobody here asked for it: joined on the other side's account. */
  forThem: boolean
): Promise<string | null> {
  if (requireSession() !== session) throw new Error("Identity changed");
  if (existing && pqState) {
    await setDmPqState(roomCode, pqState);
    if (requireSession() !== session) throw new Error("Identity changed");
  }
  // Past the bound on what others can make us join, the conversation is
  // stored all the same and carries on through the mailbox.
  const account = _joinAccount(session, roomCode, forThem);
  if (account) {
    try {
      joinDmConversation(_transport, session, roomCode, peerDid, pqState ?? existing?.pq);
    } catch (error) {
      // An upgrade can land between the read above and this join, and the
      // transport then (rightly) refuses the classical key. Read once more
      // rather than fail a send over a race it already won.
      if (pqState || existing?.pq) throw error;
      const fresh = (await getRoom(roomCode)) as DMRoom | undefined;
      if (requireSession() !== session || !fresh?.pq) throw error;
      joinDmConversation(_transport, session, roomCode, peerDid, fresh.pq);
    }
    _noteJoin(session, roomCode, account);
    const device = looksLikePeerId(peerIdOrDid) ? peerIdOrDid : didToPeerId(peerDid, _peerIdToDid);
    // A known profile is not proof the other device has opened this DM yet.
    // Explicit device inputs initiate first contact; DID-only restore is passive.
    if (device === peerIdOrDid && !_transport.isRoomPeer(roomCode, device)) {
      await _transport.introduceDm(device, peerDid);
      if (requireSession() !== session) throw new Error("Identity changed");
    }
  }
  if (existing) return roomCode;
  const room: DMRoom = {
    roomCode,
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: [peerDid],
    participantLastSeen: {},
    participantDid: peerDid,
    ...(pqState ? { pq: pqState } : {}),
    // Explicit either way: a room we create for someone we reached out to
    // must not inherit a request flag a racing stranger-path write left.
    request,
  };
  await putRoom(room, guard);
  _admissionChanged();
  // Our own introduction comes back through the stranger's hook, often
  // before this store: a provisional join it made meanwhile is ours.
  if (account === "user") _provisional.delete(roomCode);
  if (requireSession() !== session) throw new Error("Identity changed");
  // isDmRequestRoom and the request banner read the sidebar's copy, which
  // only a refresh used to bring this into: until then the request was
  // treated as an accepted DM.
  if (request && !roomsStore.dmRooms.some((r) => r.roomCode === roomCode)) {
    roomsStore.dmRooms = [...roomsStore.dmRooms, room];
  }
  return roomCode;
}

/** Whether we already have a DM with this person. */
export async function dmRoomExists(peerDid: string): Promise<boolean> {
  const roomCode = await dmConversationCodeAsync(peerDid);
  return !!roomCode && (await getRoom(roomCode))?.type === "dm";
}

/**
 * Upgrade our existing DM with this person to post-quantum, if the device
 * we are talking to can: its profile carried a valid PQ key certificate,
 * which only builds that know the upgrade send. The introduction does the
 * rest (dm-introduction-stream.ts) and lands in ensureDmRoomForPeer with the
 * agreed state. Once per device per ten minutes, so a device that keeps
 * failing it is not introduced on every profile it sends.
 */
const _pqUpgradeTriedAt = new Map<string, number>();
const PQ_UPGRADE_RETRY_MS = 10 * 60_000;
export async function offerDmUpgrade(peerId: string, peerDid: string): Promise<void> {
  if (!looksLikePeerId(peerId) || !looksLikeDid(peerDid) || peerDid === identityStore.did) return;
  const now = Date.now();
  if (now - (_pqUpgradeTriedAt.get(peerId) ?? -Infinity) < PQ_UPGRADE_RETRY_MS) return;
  // Marked before the lookup too: profiles are frequent, and a DM that is
  // already upgraded (or absent - a new DM is upgraded by its first
  // introduction anyway) should not cost a database read on every one.
  if (_pqUpgradeTriedAt.size >= 256) _pqUpgradeTriedAt.clear();
  _pqUpgradeTriedAt.set(peerId, now);
  const roomCode = await dmConversationCodeAsync(peerDid);
  if (!roomCode) return;
  const room = (await getRoom(roomCode)) as DMRoom | undefined;
  if (!room || room.type !== "dm" || room.pq) return;
  await _transport.introduceDm(peerId, peerDid);
}

export async function addToPhonebook(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid);
  if (!resolvedPeerId) return;
  // Storing the peerId in the did field poisons the contact permanently: every
  // room code derived from it afterwards points at a conversation nobody else
  // is in.
  const did = dmPeerDid(resolvedPeerId);
  if (!did) return;
  const roomCode = await ensureDmRoomForPeer(did);
  if (!roomCode) return;
  // A contact is never a request.
  await acceptIfDmRequest(roomCode, did);
  const profile = await getPeerProfile(did);
  // The store is keyed by whatever form `peerId` held at add time, so the
  // same human can exist under a DID-keyed row and a peerId-keyed row.
  // Merge by DID: reuse the stored row (keeping favorite/addedAt) and drop
  // any duplicate keyed under another form.
  const entries = await getPhonebookEntries();
  const existing = entries.filter(
    (e) =>
      e.did === did ||
      e.peerId === did ||
      e.peerId === resolvedPeerId ||
      (!!e.did && e.did === resolvedPeerId)
  );
  const keeper = existing[0];
  for (const dup of existing) {
    if (dup.peerId !== resolvedPeerId) await deletePhonebookEntry(dup.peerId);
  }
  await putPhonebookEntry({
    peerId: resolvedPeerId,
    did,
    nickname:
      profile?.nickname ||
      keeper?.nickname ||
      resolveDmDisplayName(resolvedPeerId),
    addedAt: keeper?.addedAt ?? Date.now(),
    favorite: keeper?.favorite,
  });
  _admissionChanged();
  await ensureDmRoomForPeer(did);
}

/** Whether that person is in the phonebook, under any key an entry may carry. */
export function isInPhonebook(peerId: string): boolean {
  // An entry may be keyed by peerId or DID; compare every form.
  const did = peerIdToDid(peerId);
  return roomsStore.phonebook.some(
    (entry) =>
      entry.peerId === peerId ||
      entry.did === peerId ||
      (!!did && (entry.peerId === did || entry.did === did))
  );
}

export async function removeFromPhonebook(peerIdOrDid: string): Promise<void> {
  // The stored key may be a peerId or a DID depending on whether the contact
  // was online when added; deleting by only today's resolution left the row
  // behind and the contact reappeared on the next refresh.
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  const did = dmPeerDid(peerIdOrDid);
  for (const e of await getPhonebookEntries()) {
    if (
      e.peerId === resolvedPeerId ||
      e.peerId === peerIdOrDid ||
      (!!did && (e.peerId === did || e.did === did)) ||
      e.did === peerIdOrDid ||
      e.did === resolvedPeerId
    ) {
      await deletePhonebookEntry(e.peerId);
    }
  }
  _admissionChanged();
}

export async function removeDmConversation(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  const allDmRooms = await getDMRooms();

  // Get the canonical room code for this peer
  const canonicalRoomCode = await dmConversationCodeAsync(resolvedPeerId);
  const candidates = new Set<string>(
    canonicalRoomCode ? [canonicalRoomCode] : []
  );

  // Also check rooms by participantDid match
  for (const room of allDmRooms) {
    if (
      room.participantDid === resolvedPeerId ||
      room.participantDid === peerIdOrDid
    ) {
      candidates.add(room.roomCode);
    }
  }

  // The queue is keyed by DID; filtering by peerId left the messages behind to
  // be delivered later into a conversation that had been deleted.
  const queuedDid = dmPeerDid(resolvedPeerId);
  // Opening a request marked them as someone we reached out to; deleting it
  // takes that back, or their next introduction would skip the requests.
  for (const id of [peerIdOrDid, resolvedPeerId, queuedDid]) if (id) _solicited.delete(id);
  await mutateDmQueue((queue) =>
    queue.filter((q) => q.to !== resolvedPeerId && q.to !== queuedDid)
  );

  // Delete messages for all matching rooms, then delete the rooms. Also stop
  // listening on their topics and hang up a call held in one of them -
  // deleting the conversation used to leave both running.
  // forgetConversation, not leaveRoom: leaving kept the conversation's
  // binding for the session, and bindings are capped (512), so deleted
  // conversations - junk message requests above all - used them up.
  for (const roomCode of candidates) {
    if (transportState.callRoomCode === roomCode) leaveCall();
    _forgetJoin(roomCode);
  }
  await Promise.all(
    [...candidates].map(async (roomCode) => {
      dropRoomCorpus(roomCode);
      // Their side of it, as far as we had it, stays deleted: see
      // setDeletedFloor. Read before the rows (watermarks included) go.
      const peerDid = allDmRooms.find((r) => r.roomCode === roomCode)?.participantDid;
      if (peerDid) {
        const floor = await getWatermark(roomCode, peerDid).catch(() => 0);
        if (floor > 0) await setDeletedFloor(roomCode, peerDid, floor);
      }
      await deleteMessagesForRoom(roomCode);
      await deleteRoom(roomCode);
    })
  );
  _admissionChanged();

  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === resolvedPeerId
  ) {
    transportState.activeDmPeerId = null;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.messages = [];
    transportState.chatMode = "room";
    transportState.connected = false;
  }

  transportState.dmVersion += 1;
}
