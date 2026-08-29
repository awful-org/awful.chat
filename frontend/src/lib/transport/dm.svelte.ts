import { identityStore } from "$lib/identity/identity.svelte";
import { refreshDmRooms } from "$lib/rooms.svelte";
import {
  deleteMessagesForRoom,
  deletePhonebookEntry,
  deleteRoom,
  getDMRooms,
  getPeerProfile,
  getPhonebookEntries,
  getRoom,
  putMessage,
  markRoomSeen,
  setWatermark,
  getLastMessageFrom,
  nextDmLamport,
  putPhonebookEntry,
  putRoom,
  type DMRoom,
  getMessages,
} from "$lib/storage";
import { roomsStore } from "$lib/rooms.svelte";
import {
  appendToDmPanel,
  defaultPanelPosition,
  dmPanel,
} from "$lib/dm-panel.svelte";
import { MessageType, type Message } from "$lib/types/message";
import { signMessage } from "$lib/messaging";
import { base64ToBytes, bytesToBase64 } from "$lib/utils";
import { leaveCall } from "./call.svelte";
import {
  _hydrateAndSeedAttachments,
} from "./files.svelte";
import {
  appendSorted,
  beginConversationOpen,
  _loadHistory,
  _peerIdToDid,
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
} from "./dm-codec";
import {
  openRow,
  sealRow,
  storageCryptoReady,
  type StoreCryptoSpec,
} from "$lib/storage-crypto";

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
    return;
  }
  try {
    const sealed = await sealRow({ q: queue }, DM_QUEUE_SPEC);
    localStorage.setItem(
      DM_QUEUE_KEY,
      JSON.stringify({
        iv: bytesToBase64(sealed._enc.iv),
        ct: bytesToBase64(new Uint8Array(sealed._enc.ct)),
      })
    );
  } catch {
    // Storage full or blocked: the message still sent or sits in memory;
    // a quota error must not blow up out of sendDirectMessage.
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
  const run = _queueChain.then(async () => {
    await saveQueuedDmMessages(mutate(await loadQueuedDmMessages()));
  });
  // One failed mutation must not wedge the chain for every later one.
  _queueChain = run.catch(() => {});
  return run;
}

function queueDmMessage(
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
  const stillCurrent = beginConversationOpen();
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
  _transport.joinRoom(roomCode);
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
export async function openDmPanel(peerIdOrDid: string): Promise<boolean> {
  if (!_transport.selfId()) return false;
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  if (!resolvedPeerId) return false;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  if (!roomCode) {
    transportState.error =
      "Cannot open this conversation yet: waiting to verify who this peer is.";
    return false;
  }
  // Files and plugin cards in a DM ride the room topic, so the panel has to be
  // subscribed for the same reasons the pane is. Text arrives over a direct
  // stream either way.
  _transport.joinRoom(roomCode);

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
  if (dmPanel.roomCode !== roomCode) return false;
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
  const peerId = options.peerId ?? transportState.activeDmPeerId;
  if (!peerId) return;
  const body = text.trim();
  // Reactions travel as empty-bodied envelopes; everything else needs text.
  if (!body && !options.reaction) return;

  const roomCode = await ensureDmRoomForPeer(peerId);
  if (!roomCode) {
    // Sending into a peerId-derived room would file the message in a thread
    // the other side never reads.
    transportState.error = "Cannot send yet: still verifying who this peer is.";
    return;
  }
  _transport.joinRoom(roomCode);

  const id = crypto.randomUUID();
  const ts = Date.now();
  // Monotonic per room: a behind-running clock must not file this message
  // below the peer's seen watermark. Shipped in the envelope so both sides
  // store the same value and watermarks stay comparable.
  const lamport = await nextDmLamport(roomCode, ts);
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
    delivered = await _transport.send(resolvedPeerId!, envelope);
  }
  // STARTED here, awaited after the local echo. The queue write is now a
  // sealed read-modify-write of the whole queue (AES-GCM both ways), and
  // awaiting it here put all of that in front of the user's own bubble - the
  // exact send lag the echo below was reordered to remove.
  let queued: Promise<void> | null = null;
  if (!delivered) {
    queued = queueDmMessage(peerDid, envelope, id);
    // Opt-in relay mailbox: a sealed copy waits for the offline peer so
    // delivery does not require both of you online at once. Best-effort -
    // the queue keeps retrying P2P either way.
    if (peerDid.startsWith("did:")) {
      const { depositDmToMailbox } = await import("./mailbox.svelte");
      void depositDmToMailbox(peerDid, envelope);
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

  await putMessage(msg);
  await setWatermark(roomCode, mySenderId, msg.lamport);
  // Sending is reading: your own message must not count as unread, and the
  // watermark - not a sender-id comparison - is what the badge trusts.
  await markRoomSeen(roomCode, msg.lamport);
  await refreshDmRooms();
  transportState.dmVersion += 1;
}

/**
 * Send read acks to a peer for messages we just displayed.
 * Fire-and-forget: if the peer is offline the acks are simply dropped -
 * they'll be re-sent the next time the conversation is opened while
 * both peers are online (idempotent on the receiving side).
 */
export function sendDmReadAcks(peerId: string, messageIds: string[]): void {
  if (!messageIds.length) return;
  let resolved = resolveDmPeerId(peerId);
  if (resolved && looksLikeDid(resolved)) {
    resolved = didToPeerId(resolved, _peerIdToDid) ?? resolved;
  }
  if (!resolved || looksLikeDid(resolved)) return;
  if (!_transport.peers().includes(resolved)) return;
  _transport.send(resolved, encodeDmReadEnvelope(messageIds)).catch(() => {});
}

// Flushes are serialized and sent entries are removed against a FRESH read
// of the queue: a snapshot write-back would clobber messages queued (for any
// peer) while the awaited sends were in flight.
let _flushChain: Promise<void> = Promise.resolve();

export function flushQueuedDmForPeer(peerId: string): Promise<void> {
  _flushChain = _flushChain.then(() => _flushQueuedDmForPeer(peerId));
  return _flushChain;
}

function queueEntryKey(e: QueuedMessage): string {
  return `${e.to}|${e.queuedAt}|${e.messageId ?? ""}`;
}

async function _flushQueuedDmForPeer(peerId: string): Promise<void> {
  const peerDid =
    _peerIdToDid.get(peerId) ?? resolveToDid(peerId, _peerIdToDid);
  if (!peerDid) return; // Can't flush if we don't know their DID yet

  const sent = new Set<string>();
  for (const entry of await loadQueuedDmMessages()) {
    // Match entries keyed by the DID *or* by the raw peerId - older entries
    // queued before the DID was known were stored under the peerId.
    if (entry.to !== peerDid && entry.to !== peerId) continue;
    const ok = await _transport.send(peerId, new Uint8Array(entry.data));
    if (ok) {
      sent.add(queueEntryKey(entry));
      if (entry.messageId) applyMessageStatus(entry.messageId, "sent");
    }
  }
  if (sent.size === 0) return;
  // The fresh read and the write-back have to be one uninterrupted step, or a
  // message queued (for any peer) while the sends above were in flight is
  // clobbered by this write - which is exactly what the comment above promises.
  await mutateDmQueue((queue) =>
    queue.filter((e) => !sent.has(queueEntryKey(e)))
  );
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
  const did = _peerIdToDid.get(peerId);
  const names = transportState.peerNames;
  const named = (did ? names.get(did) : undefined) ?? names.get(peerId);
  if (named) return named;
  // The phonebook nickname survives a reload even when no profile was ever
  // cached, which is exactly the case a mailbox DM from a stranger hits.
  const entry = roomsStore.phonebook.find(
    (e) => e.peerId === peerId || e.did === peerId || (!!did && e.did === did)
  );
  if (entry?.nickname) return entry.nickname;
  return peerId.slice(0, 12);
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
    const roomCode = await hashDmRoomCode(selfDid, peerDid);
    _transport.joinRoom(roomCode);
  }
}

export async function ensureDmRoomForPeer(
  peerIdOrDid: string
): Promise<string | null> {
  const peerDid = dmPeerDid(peerIdOrDid);
  const roomCode = peerDid ? await dmConversationCodeAsync(peerIdOrDid) : null;
  if (!roomCode || !peerDid) return null;
  const existing = await getRoom(roomCode);
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
  };
  await putRoom(room);
  return roomCode;
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
  _transport.joinRoom(roomCode);
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
  await mutateDmQueue((queue) =>
    queue.filter((q) => q.to !== resolvedPeerId && q.to !== queuedDid)
  );

  // Delete messages for all matching rooms, then delete the rooms. Also stop
  // listening on their topics and hang up a call held in one of them -
  // deleting the conversation used to leave both running.
  for (const roomCode of candidates) {
    if (transportState.callRoomCode === roomCode) leaveCall();
    _transport.leaveRoom(roomCode);
  }
  await Promise.all(
    [...candidates].map(async (roomCode) => {
      await deleteMessagesForRoom(roomCode);
      await deleteRoom(roomCode);
    })
  );

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
