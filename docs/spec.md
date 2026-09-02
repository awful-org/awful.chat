# Technical Specsheet

## Data Layer Split

```txt
message log (append-only)  → lamport + watermark sync + IndexedDB
identity                   → BIP39 + ed25519, encrypted at rest in IndexedDB

FUTURE (designed, not wired): Yjs per-channel CRDT for edits/deletes/pins.
Reactions currently ship as ordinary persisted messages (type "reaction"
with reactionTo/reactionEmoji/reactionOp), resolved at render time.
```

---

## IndexedDB Schema (idb)

```typescript
// Current schema is v6 - v2 added savedGifs, v3 re-keyed profiles by did,
// v4 added phonebook, v5 and v6 added the searchIndex and diagnostics stores
// and the blinded indexes below. This listing is the v1 shape for
// orientation; storage.ts is the authoritative upgrade path.
export async function getDB(): Promise<AppDB> {
  // singleton - one connection for app lifetime
  // NOTE: rows in messages/attachments/profiles/rooms are SEALED at rest -
  // see "At-Rest Encryption" below. The keyPath and indexed fields shown
  // here stay in clear; everything else lives inside an AES-GCM blob.
  return openDB("awful-chat", 6, {
    upgrade(db) {
      // messages
      const msg = db.createObjectStore("messages", { keyPath: "id" })
      msg.createIndex("byRoom",        "roomCode")
      msg.createIndex("byRoomLamport", ["roomCode", "lamport"])
      msg.createIndex("bySender",      "senderId")

      // attachments
      const att = db.createObjectStore("attachments", { keyPath: "id" })
      att.createIndex("byMessage",  "messageId")
      att.createIndex("byInfoHash", "infoHash")
      att.createIndex("byStatus",   "status")

      // pending DM messages
      const pen = db.createObjectStore("pending", { keyPath: "id" })
      pen.createIndex("byRecipient", "to")

      // identity - keyed by "mnemonic" | "keypair"
      db.createObjectStore("identity", { keyPath: "id" })

      // watermarks - keyed by "roomCode:senderId"
      const wm = db.createObjectStore("watermarks", { keyPath: "id" })
      wm.createIndex("byRoom", "roomCode")

      // Yjs snapshots - keyed by "channel:{roomCode}"
      db.createObjectStore("yjsDocs", { keyPath: "id" })

      // rooms - keyed by roomCode
      const room = db.createObjectStore("rooms", { keyPath: "roomCode" })
      room.createIndex("byType", "type")

      // profiles - "own" + peer did:keys
      db.createObjectStore("profiles", { keyPath: "id" })
    }
  })
}
```

---

## At-Rest Encryption

```txt
Why: IndexedDB deletion is not erasure (LevelDB keeps old values until a
compaction the page cannot trigger), so the disk only ever holds AES-GCM
ciphertext - crypto-shredding by never yielding the key.

Key:    HKDF from the identity's ed25519 private key with a purpose label.
        Exists only while unlocked, never stored; every device of the same
        identity derives the same key (device sync round-trips).
Layout: per row, keyPath + indexed/query fields stay in clear ("clear
        fields"); everything else is one AES-GCM blob (_enc, fresh IV per
        write); ArrayBuffer fields (file bytes, avatars) sealed as raw
        buffers beside it (_encBytes). Each blob is bound to its row with
        AAD: v: 3 blobs bind "<store> <primaryKey> [field]" plus every
        clear field of the row (type, status, lamport), so a blob moved to
        another row or store, or a row whose clear fields were edited on
        disk, fails to open. v: 2 blobs (store and key only) and unmarked
        blobs still open until the unlock sweep rewrites them as v: 3. A
        row with no blob at all in a sealed store is refused unless a
        sweep is pending, so plaintext cannot be planted and laundered.
Clear fields: messages(id, lamport, type, status). roomCode, senderId,
        messageId, infoHash, did and peerId are not clear but BLINDED: an
        HMAC under a separate HKDF index key replaces the value in the
        row and its indexes, so queries still hit without the disk ever
        holding a room code or an identity (per identity, so two accounts
        on one device cannot be correlated). profiles/rooms keep byte
        fields sealed (pfpData/bannerData).
Query doctrine: bulk index getAll of raw sealed rows, filter on clear
        fields in memory, decrypt only survivors. Cursors only for stores
        with multi-MB byte rows (attachments); openRow supports skipBytes
        to leave large buffers sealed when the caller only needs metadata.
        (see frontend/src/lib/storage-crypto.ts)
```

---

## Types

### Message

```typescript
interface Message {
  id: string             // UUIDv7
  roomCode: string
  senderId: string
  senderName: string
  senderDid?: string
  sig?: string           // ed25519 over the canonical form (see below)
  sigV?: number          // 3 = the only version accepted on the wire
  timestamp: number      // wall clock, display only
  lamport: number        // ordering source of truth
  type: ChatMessageType  // only chat types stored in IDB
  content: string
  meta?: FileMeta
  attachments: string[]  // Attachment.id refs
  replyTo?: ReplyTo
  status?: MessageStatus // DMs only
}

enum MessageType {
  // chat - persisted to IDB, sent over wire
  Text            = "text",
  Reply           = "reply",
  Reaction        = "reaction",
  File            = "file",
  PluginCard      = "plugin_card",      // plugin surface, see docs/plugin-surface.md
  PluginUpdate    = "plugin_update",
  // presence - wire only, never persisted
  Profile         = "profile",
  CallPresence    = "call_presence",
  CallState       = "call_state",
  WatchPresence   = "watch_presence",
  VoiceRedial     = "voice_redial",
  RoomName        = "room_name",
  PluginEphemeral = "plugin_ephemeral",
  JoinRoom        = "join_room",
  LeaveRoom       = "leave_room",
  RoomUsersSync   = "room_users_sync",
  // sync - wire only, never persisted
  SyncDigest      = "sync_digest",
  SyncBatch       = "sync_batch",
  SyncComplete    = "sync_complete",
}

// NOTE: DM delivery/read receipts are implemented, but NOT via these wire
// types - DMs use tagged binary envelopes over the direct libp2p stream:
//   0x01 chat  { id, text, ts }
//   0x02 ack   → recipient got it        → status "delivered"
//   0x03 read  string[] of messageIds    → conversation on screen → "read"
// (see frontend/src/lib/transport/dm-codec.ts)
// Status ladder: sending (queued offline) → sent → delivered → read.
// Statuses never regress; queued DMs retry when the peer's profile arrives.

// only chat types are persisted to IDB
type ChatMessageType = MessageType.Text | MessageType.Reply | MessageType.Reaction
  | MessageType.File | MessageType.PluginCard | MessageType.PluginUpdate

type MessageStatus = "sending" | "sent" | "delivered" | "read"

interface ReplyTo {
  id: string
  senderName: string
  content: string        // snapshot at send time
}

interface FileMeta {
  files: FileEntry[]
}

interface FileEntry {
  filename: string
  mimeType: string
  size: number
  infoHash: string
}
```

### Attachment

```typescript
interface Attachment {
  id: string             // UUIDv7
  roomCode: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  infoHash: string       // permanent WebTorrent reference
  data?: ArrayBuffer     // only if size < 5MB, raw binary
  blobURL?: string       // runtime only, never persisted
  status: AttachmentStatus
  createdAt: number
}

type AttachmentStatus = "seeding" | "pending" | "downloading" | "complete" | "failed"
```

### Room

```typescript
type RoomType = "text" | "dm"

interface Room {
  roomCode: string
  type: RoomType
  name: string
  lastSeenLamport: number  // unread count derived from this
  createdAt: number
  pfpData?: ArrayBuffer    // local upload - blobURL generated at runtime
  pfpURL?: string          // external URL (tenor, giphy, etc) - stored as-is
  // pfpData and pfpURL mutually exclusive
}

interface DMRoom extends Room {
  type: "dm"
  participantDid: string
}
```

### Profiles

```typescript
interface OwnProfile {
  id: "own"
  did: string
  nickname: string
  pfpData?: ArrayBuffer
  pfpURL?: string          // stored as-is if external URL
  updatedAt: number
}

interface PeerProfile {
  did: string              // PK
  nickname: string
  pfpData?: ArrayBuffer
  pfpURL?: string
  updatedAt: number
}

// pfp rendering:
//   pfpData present → URL.createObjectURL(new Blob([pfpData])) at runtime
//   pfpURL present  → use directly as <img src>
//   setting one clears the other
```

### Identity struct

```typescript
interface MnemonicRecord {
  id: "mnemonic"
  salt: Uint8Array
  iv: Uint8Array
  encrypted: ArrayBuffer   // AES-GCM encrypted mnemonic
}

interface KeypairRecord {
  id: "keypair"
  did: string
  publicKey: Uint8Array    // ed25519, cached
  // privateKey NEVER stored - derived at unlock, held in memory only
}
```

### Watermark

```typescript
interface WatermarkRecord {
  id: string               // "roomCode:senderId"
  roomCode: string
  senderId: string
  maxLamport: number
}
```

### Pending Message

```typescript
interface PendingMessage {
  id: string               // same id as WireMessage
  to: string               // recipient did:key
  message: WireMessage     // already encrypted
  createdAt: number
  attempts: number
}
```

### Wire Types

```typescript
// chat message - sent over wire and persisted on receipt
interface WireChatMessage {
  type: ChatMessageType
  id: string
  senderId: string
  senderName: string
  senderDid?: string
  sig?: string
  timestamp: number
  lamport: number
  content: string
  meta?: FileMeta
  replyTo?: ReplyTo
  reactionTo?: string
  reactionEmoji?: string
  reactionOp?: "add" | "remove"
}

// presence - wire only
interface WireProfile      { type: MessageType.Profile;      name: string; did: string | null; avatarUrl: string | null
                             // proof that `did` owns the sending peerId, see Peer Identity Binding
                             peerId?: string; bindingSig?: string }
interface WireCallPresence { type: MessageType.CallPresence; inCall: boolean }
interface WireRoomName     { type: MessageType.RoomName;     name: string }

// sync - wire only
interface WireSyncDigest   { type: MessageType.SyncDigest;   watermarks: Record<string, number> }
interface WireSyncBatch    { type: MessageType.SyncBatch;    messages: WireChatMessage[]; batchIndex: number; totalBatches: number }
interface WireSyncComplete { type: MessageType.SyncComplete }

type AnyWireMessage =
  | WireChatMessage | WireProfile | WireCallPresence | WireRoomName
  | WireSyncDigest | WireSyncBatch | WireSyncComplete

// helpers
function wireToMessage(wire: WireChatMessage, roomCode: string): Message  // adds roomCode + attachments: []
function messageToWire(msg: Message): WireChatMessage                      // strips storage-only fields
function isChatMessage(msg: AnyWireMessage): msg is WireChatMessage        // type guard
```

### Sync Protocol

```typescript
// all messages share a single type discriminant - no kind/wire wrapper
// { type: MessageType.SyncDigest, watermarks: { ... } }

// watermarks are a vector clock: senderId → maxLamport seen from that sender
type Watermarks = Record<string, number>
```

```txt
on connect (both peers):
  → send SyncDigest { watermarks }

on receive SyncDigest:
  → compare their watermarks against mine
  → push everything they're missing as SyncBatch[] + SyncComplete
  → they do the same - one round trip, bidirectional, no host election

on receive SyncBatch:
  → bulkPut to IDB (idempotent - put by id)
  → update watermarks (max semantics)
  → merge into in-memory message list

on receive SyncComplete:
  → re-sort in-memory list
  → send SyncDigest to all OTHER connected peers (gossip propagation)
    so data spreads through partial meshes without requiring direct connections

SyncRequest removed - push-on-digest replaces it, saving one round trip
```

---

## Future: Yjs Channel Doc

*Designed, not wired - the yjs dependency is not installed. The `yjsDocs`
IndexedDB store exists (and is carried through device sync) so adding this
later needs no schema migration. Reactions are persisted messages today.*

```typescript
// per channel - edits, deletes, pins, topic
// keyed in IndexedDB as "channel:{roomCode}"

channelDoc.getArray<string>('pins')
channelDoc.getText('topic')
```

### Resolved Message (UI)

```typescript
interface ResolvedMessage extends Message {
  content: string
  edited: boolean
  deleted: boolean
  reactions: Record<string, string[]>  // emoji → senderId[]
}

function resolveMessage(msg: Message, channelDoc: Y.Doc): ResolvedMessage {
  const edit = channelDoc.getMap('edits').get(msg.id)   as { content: string } | undefined
  const del  = channelDoc.getMap('deletes').get(msg.id) as { deletedAt: number } | undefined
  const rxns = channelDoc.getMap('reactions').get(msg.id)
  return {
    ...msg,
    content:   del ? "" : (edit?.content ?? msg.content),
    edited:    !!edit && !del,
    deleted:   !!del,
    reactions: rxns ? yReactionsToRecord(rxns) : {},
  }
}
```

---

## Lamport Clock

```typescript
// send:    clock++
// receive: clock = max(local, received) + 1

function sortMessages(a: Message, b: Message): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.senderId.localeCompare(b.senderId)  // deterministic tiebreaker
}
```

---

## Sync Flow

```txt
peer joins room → rendezvous on the Go relay (/awful/rendezvous/1.0.0,
length-prefixed JSON: REGISTER/UNREGISTER → PEERS/PEER_JOINED/PEER_LEFT)
→ dials peers via libp2p (WebRTC direct, circuit-relay fallback, 3 dial
attempts with backoff) → gossipsub topic app:room:{roomCode} per room

on each connection (both sides independently):
  → send SyncDigest { watermarks }          // vector clock of what I have

on receive SyncDigest:
  → compute what they're missing            // their watermarks < mine
  → push SyncBatch[] + SyncComplete         // they do the same symmetrically

result:
  → one round trip per peer pair
  → no host election, no single point of failure
  → each SyncComplete triggers gossip to other peers
    (spreads data through partial meshes without direct connections)

signature policy on receive (MANDATORY since 2026-08):
  → sigV 3 ONLY, verified against the canonical rebuilt with the
    AUTHENTICATED topic room (the wire carries no roomCode). sigV 2 was
    retired on 2026-08-28: it signed neither the type nor the room, so a
    valid v2 signature was still a working cross-room replay - and since
    storage puts by the globally unique id, the replay MOVED the receiver's
    original rather than copying it
  → sigV 1 and 2, and unsigned messages, are REJECTED, with one exception:
    unsigned rows inside a DM sync batch from the authenticated DM
    counterparty (or the own identity's paired device) are accepted -
    receiver-stored DM history predates signing
  → deterministic rejects (no sig, sigV outside {2,3}) CLAIM watermarks
    so the sender stops re-pushing the same dead backlog every digest;
    only signed-but-failing rows keep the floor open for retry
```

---

## Identity

### Key Derivation

```txt
password → PBKDF2(salt, 600_000, SHA-256) → AES-256-GCM key → decrypt mnemonic
          (records written at the old 100_000 carry their count and are
          re-sealed at 600_000 on their next successful unlock)
mnemonic (BIP39, 12 words) → BIP39 seed, first 32 bytes = ed25519 scalar
did:key = "did:key:" + base58btc(0xed01 + publicKey)

NOTE: deliberately NOT SLIP-0010 - changing derivation would break every
existing identity. Seed and mnemonic buffers are zeroed after derivation.
```

### Unlock Flow

```txt
app open → prompt password → PBKDF2 → AES-GCM decrypt → derive keypair → hold in memory
lock     → zero out private key bytes → null session
```

### Message Signature

```typescript
// v1 (legacy): `${id}:${senderId}:${lamport}:${content}` - kept only so old
// local rows can be re-verified; REJECTED on the wire.
// v2 (RETIRED 2026-08-28, rejected on the wire) - covered reaction fields,
// replyTo.id and file meta, but neither the type nor the room, so a valid v2
// signature was still a working cross-room replay:
const canonicalV2 = JSON.stringify([id, senderId, lamport, content,
  reactionTo, reactionEmoji, reactionOp, replyTo?.id, metaFileStrings])
// v3 (current, msg.sigV === 3) - additionally binds type and roomCode, so a
// message can't be replayed into another room or retyped:
const canonicalV3 = JSON.stringify([3, type, roomCode, id, senderId, lamport,
  content, reactionTo, reactionEmoji, reactionOp, replyTo?.id, metaFileStrings])
// sign with private key in memory
// verify with pubkey decoded from senderDid (did:key); senderDid must ALWAYS
// equal senderId (a peerId-form senderId once skipped this check, so any key
// could sign as anyone); ed25519 verification runs with zip215:false, which
// rejects small-order keys that would otherwise verify any signature; and the
// verifier reconstructs roomCode from the authenticated gossipsub topic,
// never from the wire
```

### Peer Identity Binding

A device's libp2p key is NOT its identity key. Devices signed into the same
account share one did:key, and deriving the peerId from it gave them all the
same peerId: a relay reservation is per peerId and a node refuses to dial its
own, so only one device could ever connect.

```txt
identity key  ed25519 from the BIP39 mnemonic. Same on every device. Signs
              messages, owns the did:key.
device key    32 random bytes, generated once per device and kept in
              localStorage (NOT IndexedDB - device sync copies IDB sections
              across, which would hand the key to the other device and put
              the peerId collision back). Seeds the libp2p peerId.
```

Because the DID can no longer be computed from a peerId, the link is proven:

```typescript
// signed by the identity key, sent on the Profile message
content = `awful:peer-binding:v1:${did}:${peerId}`
bindingSig = hex(ed25519.sign(utf8(content), identityPrivateKey))
```

The receiver binds `peerId -> did` only when ALL of these hold:

```txt
1. msg.peerId equals the peerId of the connection it arrived on
2. bindingSig verifies against the pubkey decoded from msg.did
3. both fields are present
```

Otherwise the profile is dropped, name and avatar included. Noise has already
proven the sender holds the private key for that peerId, so a signature over
that same peerId ties the two identities together: replaying somebody else's
binding fails check 1, and forging one fails check 2. A peerId is never turned
into a DID by guesswork - an unbound peer keeps showing as its peerId rather
than being attributed to an identity that may not be theirs.

---

## DM Encryption

```txt
DMs travel over direct libp2p streams - noise-encrypted end-to-end between
the two peers (the relay only forwards ciphertext, even on circuit relay).

App-layer primitives exist for future double encryption (messaging.ts):
  ed25519 → curve25519 ECDH, shared secret = SHA-256("awful-dm-v1" || raw)
  → AES-256-GCM. Implemented and tested, not yet wired into the DM
  STREAM path. The offline mailbox (below) has its own sealed-box crypto.
```

---

## Offline DM Mailbox

```txt
Problem: DMs need both peers online at once; the mailbox lets the relay
hold an encrypted envelope for an offline recipient. Default ON, with a
quirks disclosure.

Crypto (frontend/src/lib/mailbox-crypto.ts, "awful-mailbox-v1"):
  sealed box - ephemeral-static X25519 ECDH against the recipient's
  identity key (ed25519 converted to Montgomery form), no prior handshake.
  The sealed PLAINTEXT carries the sender's did + an ed25519 signature
  binding the envelope to the recipient (a blob has no transport to
  authenticate it). Plaintext pads to fixed buckets (1 KiB / 4 KiB /
  15 KiB) so blob sizes leak almost nothing; larger content stays p2p-only.

Relay side (relay/mailbox.go):
  blobs keyed by a hash of the recipient DID; 16 KiB blob cap; unclaimed
  blobs expire after 48 h; deposits rate-limited and a global byte quota
  caps total mailbox disk. Collection authenticates with an ed25519
  signature over "awful-mailbox:<unix-ts>" by the recipient DID (accepted
  with or without the multibase z prefix).
  Devices: collect and ack carry the device's libp2p peerId. An ack hides
  the blob from THAT device only; the blob leaves at TTL or quota
  eviction, so a phone and a desktop on one identity each collect it
  (the client dedups by message id against storage). A client that sends
  no device gets the old delete-on-ack.
  Kinds: the sealed plaintext carries a kind - a chat envelope, a DM
  sync batch (files, plugin cards, without inline bytes), or a delivery
  or read receipt - so receipts and attachments reach a sleeping phone
  too, not only text. Blobs without a kind are chat.

Client collect: on unlock/startup, fetch + unseal + ack. Undecryptable
  blobs are poison-acked (deleted) so they cannot wedge the box; transient
  failures keep the blob for the next poll. Message-id dedup against
  storage stops replays.

What the relay learns: THAT a DID has mail and roughly when - never
  content, never which identity sent it (ephemeral key, no sender field
  outside the sealed plaintext). It does see the depositor's IP address at
  the HTTP layer like any request, and the same process holds every peer's
  libp2p connection, so an operator could tie a deposit to a connected
  peer by address and time. Anonymity here is against the recipient and
  the wire, not against the operator.
```

---

## File Transfer

```txt
send:
  1. wtClient.seed(file, { announce: [] }) → infoHash
  2. store Attachment { infoHash, status: "seeding" }
  3. if size < 5MB: store data: ArrayBuffer
  4. broadcast WireMessage with FileMeta

receive:
  1. store Attachment { status: "pending" }
  2. wtClient.add(infoHash) → status: "downloading"
  3. torrent.on("done") → blobURL → status: "complete"
  4. if size < 5MB: store ArrayBuffer

startup:
  re-seed all complete attachments that have data

blobURL:
  created: torrent done
  revoked: message scrolls out of virtual list OR beforeunload
```

---

## DataChannel Limits

```txt
max per message:   64 KB
SyncBatch:         max 20 messages per batch
direct streams:    4-byte big-endian length-prefixed frames
                   (chat DM envelopes, file signaling, rendezvous)
```

---

## Voice/Video

```txt
Voice:
  - p2p WebRTC over libp2p signaling (mic only, audio stays peer-to-peer always)
  - Web Audio input gain + output volume + device selection
  - input chain:  mic → GainNode → MediaStreamDestination → peers
  - output chain: remoteStream → GainNode → AudioContext.destination (per peer)
  - gain supports boost above 1.0 via Web Audio

Video:
  - mediasoup SFU over dedicated /sfu WebSocket signaling
  - camera and screen published as separate sources ("camera" | "screen")
  - recv/send transports created after router capabilities exchange
  - sfu/ is a Node process (mediasoup is not Bun-compatible); the client
    talks to its WebSocket directly (VITE_SFU_URL)
  - unexpected WS drop mid-call → client emits error + one full automatic
    rejoin (device + transports + republish of live local tracks)

Screen share audio (share-audio.ts):
  - problem: whole-system audio re-captures awful.chat's own playback of
    every remote participant, so everyone hears themselves echoed back
  - buildShareOptions() requests windowAudio:"window" + restrictOwnAudio
    (inside the audio constraint, never at the top level) plus the
    Chromium picker-shaping options (systemAudio, selfBrowserSurface,
    surfaceSwitching, monitorTypeSurfaces, audioSelection). One options
    object, no user-agent sniffing - unsupported members are silently
    ignored per the WebIDL dictionary spec
  - classifyShareAudio() checks what was ACTUALLY captured
    (videoTrack.getSettings().displaySurface,
    audioTrack.getSettings().restrictOwnAudio) rather than trusting the
    request: windowAudio degrades to system audio silently, and
    getSupportedConstraints().restrictOwnAudio reports "supported" even on
    platforms (Linux) that can never honour it
  - verdict kinds: "application-scoped" (tab audio, or a window share with
    own-audio removal confirmed), "system-audio-own-audio-stripped" (whole
    screen, own-audio removal confirmed), "echo-risk" (own-audio removal
    NOT confirmed on a non-tab surface), "no-audio" (no audio track at all)
  - default is fail-closed: an "echo-risk" audio track is stopped and
    removed before it reaches the SFU, and the sharer is told why in one
    sentence. Settings > Audio has a device-local, room-invisible opt-in
    ("send audio despite echo risk") to publish it anyway
  - real per-application audio (not just own-audio filtering) exists only
    on Windows 11 with Chrome 146+ and macOS 14.2+ with Chrome 150+; it
    never exists on Linux, ChromeOS, Firefox, or Safari - those either get
    a fail-closed silent share or the sharer's explicit opt-in
  - audioTrack.onmute/onunmute are wired so a share whose audio goes silent
    mid-call (own-audio suppression leaving nothing to send, or an
    output-device change) is reported instead of silently dead

Screen share transmissions:
  - remote screen producers emit transmissionAvailable(peerId, producerId)
  - UI shows pending "Click to watch" tile (not auto-consumed)
  - watchTransmission(peerId, producerId) consumes screen producers for that peer
  - stopWatchingTransmission() closes consumer and restores pending tile
  - transmissionEnded(peerId) clears pending/watching state
  - delayed screen-audio producers are auto-consumed while already watching
  - SFU emits producer-closed so stopped shares remove stale pending tiles

Late join behavior:
  - SFU replays existing producers to newly joined peers
  - client queues early ms:new-producer signals until recv transport is ready
```

---

## Room Codes

```txt
text:  13 characters of Crockford base32 (65 bits), shown as
       XXXX-XXXX-XXXX-X - see frontend/src/lib/room-code.ts. Older rooms
       keep the code they were born with: 16 hex chars (64 bits) from
       2026-08-28, 6 hex chars (24 bits) before that. A room cannot be
       re-keyed without becoming a different room, and every layer treats a
       code as an opaque string. The code is the room's ONLY membership
       secret - it names the gossipsub topic, keys the relay rendezvous, and
       is the SFU join key - so no direct frame that carries it (digest, room
       name, roster, call presence) goes to a peer the relay has not listed
       in that room (see _sendDigestForRoom and peersInRoom).
DM:    "dm-" + hex(sha256(sort([didA, didB]).join("|")))[0..40]
       (deterministic - both peers derive the same room without coordination)
```

---

## Telemetry

A bounded in-memory flight recorder, always on from boot, plus three vantages
on one session and a separate analysis application. Nothing leaves the tab
unless the user exports a bundle or turns the opt-in on.

```typescript
// frontend/src/lib/telemetry/schema.ts - mirrored in dashboard/src/lib/schema.ts
interface DiagEvent {
  seq: number; // 1-based per session; a gap means the ring or throttle dropped
  t: number; // ms since the session's startedAt, integer
  kind: DiagKind; // 112 frozen literals: session.*, relay.*, rv.*, peer.*,
  // stream.*, app.*, dm.*, ice.*, voice.*, sfu.*, file.*,
  // storage.*, counters, fault.injected, meta.suppressed
  sev: "debug" | "info" | "warn" | "error";
  peer: string | null; // FULL peerId, or null
  room: string | null; // a bundle-local ordinal ("r1"), NEVER a room code
  d?: Record<string, string | number | boolean | null>; // <=12 keys, strings <=200
}

interface ClientBundle {
  schemaVersion: 1;
  bundleId: string; // 16 random bytes, minted at export
  sessionId: string; // 16 random bytes, minted in LibP2PTransport.connect()
  createdAt: number;
  startedAt: number;
  vantage: "client";
  app: { version: string; commit: string };
  env: { ua: string };
  config: {
    apiHost: string; // a HOST, never a URL with a path
    relayPeerId: string;
    sfuHosts: string[];
    configured: boolean;
  };
  self: { peerId: string }; // NO did, not even the uploader's own
  rooms: Array<{ ref: string; kind: "text" | "dm" | "sync"; joinedAt: number }>;
  peers: Array<{
    peerId: string;
    identityRef: string | null; // "i1" - peerIds that PROVED one DID
    firstSeen: number;
    lastSeen: number;
  }>;
  counters: Record<string, number>; // t.* transport, a.* app, f.* faults
  events: DiagEvent[];
  sfuSnapshots: SfuSnapshot[]; // the last 8; too large for a d bag
  meta: {
    ringCapacity: number;
    dropped: number; // evicted by wraparound
    suppressed: Record<string, number>; // per kind, by the throttle
    faultsActive: boolean;
    truncated: boolean; // trimmed to fit an upload
  };
  relayView?: RelayVantage; // stapled by the relay at ingest
}
```

```txt
RECORDING
  always on, in memory, from boot - a bug is over by the time anyone thinks
  to flip a switch, so the switch is on every EXIT, never on the recording
  ring:      4096 events, wraparound, per-kind budget of 20/s (60/s for an
             error kind; 5/s for app.msg.*, 2/s for peer.rtt and
             file.progress). One hot kind must not evict every rare event.
             frontend/src/lib/telemetry/ring.ts
  taps:      one edit inside each of the three buses' private emit, so every
             event is recorded - including the nine TransportStatus variants
             that reach no UI at all.
             frontend/src/lib/telemetry/taps.ts
  probes:    ~60 hand-placed rec(ev(...)) lines at the sites where the
             information exists nowhere else: a silent catch, a console.warn,
             a bare return.

EXITS (each gated, all off by default)
  disk:      diagPrefs.persist - sealed chunks in the `diagnostics` store,
             3 sessions and 8 MB, never synced and never backed up.
             frontend/src/lib/telemetry/store.ts
  file:      the Diagnostics settings pane exports awful-diag-<id>.json.
             frontend/src/lib/telemetry/bundle.ts
  network:   diagPrefs.upload - POST <apiUrl>/telemetry, signed with the
             DEVICE libp2p key. Without TELEMETRY_ENABLED=1 the relay answers
             204 and the button hides.
             frontend/src/lib/telemetry/upload.ts

THREE VANTAGES ON ONE SESSION
  client:    the bundle above
  relay:     stapled at ingest - registry counts, per-stream open/close with
             the REAL close reason, and a per-peer event ring.
             relay/telemetry.go
  sfu:       ms:diag returns a live snapshot (transports, producers,
             consumers, room siblings); SFU_TELEMETRY=1 also prints one
             [sfu-telemetry] JSON line per room per 10s sweep.
             sfu/telemetry.ts
  joined by peerId: no shared secret and no new wire message. Clock skew is
  solved from peer.clock samples by least squares.
  dashboard/src/lib/analysis/merge.ts

REDACTION (enforced by tests, not by convention)
  room code:      NEVER. A client bundle uses an ordinal ("r1"); a relay
                  bundle uses "h:"+HMAC(bootSecret, code)[0..12], and the
                  boot secret is never persisted.
  did:key:        NEVER, not even the uploader's own. Devices that proved one
                  DID share an ordinal ("i1") instead.
  content:        NEVER. No content, no meta.files, no infoHash, no
                  attachment bytes, no nickname, no avatar. A message becomes
                  a byte length; a file becomes an ordinal ("f1").
  peerId:         allowed in full - the relay and the SFU already have it.
  ICE:            candidate TYPES and the selected tuple's protocol and LOCAL
                  port only. Never a candidate address.
  errors:         name and message only. Never a stack: a stack carries local
                  filesystem paths.
  upload auth:    the DEVICE libp2p key. An Ed25519 peerId is an identity
                  multihash, so the public key is inside it and the relay can
                  check a signature against the claimed peerId. Signing with
                  the identity key would disclose a did:key -> peerId binding.
  frontend/src/lib/telemetry/redact.ts, bundle.test.ts

ANALYSIS
  the frontend runs NONE. It records, persists, exports and uploads. A
  separate operator console ingests bundles and raw container logs,
  reconstructs the topology over time, runs 29 deterministic rules that name
  what went wrong and where, and builds a prompt pack that asks an AI why.
  dashboard/ - not deployed, run locally against a relay admin token.
```

---

## Server Privacy

```txt
relay knows:   libp2p peerId + which roomCodes it registered (rendezvous);
               with the offline mailbox, THAT a DID has pending mail
               (sealed blobs, padded sizes, no sender attribution);
               with Web Push (on by default, per-device switch in Settings),
               one push endpoint per device - a stable identifier issued by
               the phone's push vendor (Apple, Google, Mozilla) - and it
               sends that vendor a content-free "check your box" at most
               once a minute per identity when mail arrives. The vendor
               learns the timing of those wake-ups, never what they are
               about; the relay learns how many devices an identity has
               subscribed
never knows:   message content, file content, who sent a mailbox blob -
               all traffic it forwards is noise-encrypted end-to-end
               between peers, mailbox blobs are sealed to the recipient
SFU knows:     video/screen streams it routes (see landing page disclosure);
               voice never touches it
all p2p:       messages, files, voice - direct between peers
```

```txt
with telemetry (TELEMETRY_ENABLED=1, and the user opted in) the relay
additionally knows: that peerId's own connection diagnostics - dial and
reservation outcomes, ICE candidate TYPES, transport states, timings,
counters and error codes. Never message or file content, never a did:key,
never a room code (a bundle carries opaque room refs), never an ICE
candidate address. Bundles expire after 7 days.
with SFU telemetry (SFU_TELEMETRY=1) the SFU additionally LOGS, to its own
container log, the room codes and peerIds it already routes for, plus its
transport states and producer/consumer scores. Never a remote candidate
address.
```

---

## WebAuthn

```txt
Purpose: Biometric/hardware key authentication as alternative to password
Flow:
  1. Register credential with authenticator during setup
  2. Authenticate using biometric/hardware key instead of password
  3. Same key derivation path: PBKDF2 → AES-GCM → mnemonic decryption
Storage: Credential ID and public key in IndexedDB "webauthn" store
```

---

## Future: Roles + Permissions (Hash Chain Model)

*Deferred - implement after core is stable*

When roles are needed, the model is:

```txt
room creation:
  roomCode embeds commitment to creatorDid
  genesis entry signed by creator → stored in Yjs
  genesis is the trust anchor - verifiable from roomCode alone

role changes:
  each mutation is a SignedMutation { update, signer, sig, lamport }
  signer's role at mutation time determines if it is accepted
  replayed in lamport order - post-revocation mutations rejected

hash chain:
  each entry references prevHash = sha256(previous entry)
  omitting an entry breaks the chain → detectable
  peer serving truncated chain exposed when longer valid chain exists
  owner coming online with full chain → rollback of invalid optimistic state

known limitation:
  if only malicious peers are reachable, role state may be stale
  mitigated by syncing from multiple peers + longest valid chain wins
  the relay can optionally store and serve the chain
```

---

## PWA

```txt
Manifest: /manifest.webmanifest (vite-plugin-pwa), id "/", scope "/",
  start_url /app, theme and background #09090b, maskable icon, wide and
  narrow screenshots, launch_handler navigate-existing, two shortcuts
  (?new=1 new room, ?sync=1 device sync)
Service Worker: /sw.js. Precaches the shell and hashed assets (not the
  DTLN worklet or shiki grammars, cached on first use); every in-scope
  navigation is answered from the precached index.html, revalidated in the
  background; /config.json is never cached. registerType "prompt": a new
  build waits until the user accepts the reload.
Install: the deferred beforeinstallprompt is captured at boot and offered
  once the app is usable; iOS gets Share > Add to Home Screen guidance.
Share Target: POST /share-target (multipart: title, text, url, files),
  intercepted by the service worker, sealed under the device key in the
  awful-share-target database, consumed at unlock into the open room or a
  room picker. nginx also serves the shell at that path for the case where
  no worker controls the page yet.
File handler: .awfulbackup opens the app with the file parked for restore.
Protocol handler: web+awfl://<code> maps to /r/<encoded url>; the router
  strips the scheme and joins the room.
```

---

## Open Graph (OG) Proxy

```txt
Purpose: Prevent client IP leaks to third-party sites when fetching link previews
Endpoint: /og/preview?url=<encoded_url> on the Go relay's API port
         (/og is an alias; /klipy/* proxies GIF search the same way)
Response: JSON { title, description, image, siteName, url, video, mediaType }
Caching: Server-side caching with TTL
Security: URL allowlist/blocklist, size limits, timeout protection
```

---

## Backup Files

```txt
Settings > Data > Download my data writes an encrypted envelope:
  { format: "awful.chat/backup-encrypted", version: 2,
    kdf: { salt, iterations: 600_000 }, iv, ciphertext }
  ciphertext = AES-256-GCM over the JSON export (every store, opened),
  key = PBKDF2(passphrase chosen at export time). The passphrase is never
  stored; a lost passphrase is a lost file.
Restore accepts this envelope and the older plaintext .json/.awfulbackup
  exports unchanged. Replace-mode restore asks for the account password
  first so rows are sealed on write (see Device Sync > Security).
```

---

## Password Persistence

```txt
Storage: password AES-256-GCM encrypted under a NON-EXTRACTABLE CryptoKey,
         both stored in a dedicated IndexedDB ("awful-auth") - never in a
         cookie, never sent over the network, not readable via document.cookie
Expiry: user-configurable duration (default 15 days), optional sliding reset
Migration: a legacy plaintext "awful_password" cookie is read once,
           migrated into the encrypted store, then deleted
Fallback: manual password entry (or WebAuthn/biometric unlock) when absent
Clearing: disabling "remember" or logout deletes the record
Limit: code running in the origin can still USE the key (client-only
       storage ceiling) - WebAuthn PRF unlock is the hardware-backed path
```

---

## Future: Sequential Sync Queue

*Deferred - only worth implementing if rooms grow large with many simultaneous joins*

**Problem:** When a peer joins and connects to N peers at once, all N digest exchanges happen in parallel. Each peer responds independently with what the joiner is missing - so the same messages can arrive from multiple peers before any response has been processed, wasting bandwidth.

```txt
A connects to B and C simultaneously:
  A → B: digest             A → C: digest
  B → A: pushes missing     C → A: pushes same missing  ← duplicate on air
```

**Solution:** Queue digest sends and process them sequentially - wait for SyncComplete from peer N before sending digest to peer N+1. By the time you reach C, your watermarks reflect what B already sent, so C only pushes the delta.

```typescript
const _syncQueue: string[] = []
let _syncRunning = false

async function _queueSync(peerId: string): Promise<void> {
  _syncQueue.push(peerId)
  if (_syncRunning) return
  _syncRunning = true
  while (_syncQueue.length > 0) {
    const next = _syncQueue.shift()!
    await _sendDigest(next).catch(() => {})
    await _
    waitForSyncComplete(next).catch(() => {})  // resolves on SyncComplete or timeout
  }
  _syncRunning = false
}
```

**Tradeoff:** Adds latency on join - you wait for the first peer's full push before starting with the second. For small rooms (2 to 5 peers) with modest history, parallel is faster and the duplicate data is negligible. Sequential only pays off with larger rooms or large histories where duplicate transmission is significant.

**Current behavior:** Parallel. Each peer connection runs an independent digest/push cycle. Duplicate data in flight is bounded to messages missing at join time, sent once per already-connected peer.

---

## Device Sync

### Overview

Implemented bidirectional device sync with two modes:

1. **Replace** - Wipes target device and imports everything from source
2. **Addition/Merge** - Keeps target's identity and merges data from both devices

### UI Flow

#### IdentitySetup (New Device Flow)

- Always uses **Replace** mode
- Shows QR code immediately
- Target enters code → password prompt → sync
- Complete database replacement

#### Settings - Sync Section

Two buttons added:

##### 1. "Sync new device" (Replace mode)

- Shows QR code
- Target device replaces all data
- Includes identity sync with password

##### 2. "Merge devices" (Addition mode)

- Shows QR code on primary device
- Target scans and selects "Addition (Merge)"
- Target keeps its identity
- Messages, rooms, attachments merged from both

### Key Behaviors

**Replace Mode:**

- Source exports identity + all data
- Target wipes database
- Target imports everything
- Password required for identity

**Addition Mode:**

- Source skips identity export
- Target keeps existing identity
- Target doesn't wipe database
- Data merged (deduplication by ID)

### Security

- QR codes expire after 5 minutes - enforced by the SOURCE tearing down its
  sync server (the code's own expires field is untrusted input)
- 128-bit token in the QR (truncated to 8 chars in the manual short code);
  the source verifies it on every ExportRequest before exporting anything
- The QR carries the source's libp2p peerId (the short code carries chars
  8-16 of it, after the constant `12D3KooW` prefix: `room8-token8-peer8`).
  The target only talks to a peer whose Noise-authenticated peerId matches,
  so a stranger who registers into the ephemeral room first - the relay
  operator can - is never handed the token and never trusted as the source.
  Codes from older builds (two parts, or no peerId) are rejected.
- Imported records are shape-checked (types, sizes, known message types)
  before they touch IndexedDB; malformed ones are dropped and counted.
  Signatures are NOT re-verified on import: pre-v3 history could not pass
- "Merge devices" never touches the target's identity: an identity section
  in the payload is dropped, so a hostile source cannot swap the account
  out from under the device
- The target asks for the account password BEFORE importing, unlocks the
  incoming mnemonic, arms the at-rest key, and only then writes: imported
  rows are sealed on first write, never parked in plaintext for a later
  sweep. Cancelling the prompt leaves the device untouched
- The typed short code is shown only on request; until then the source
  accepts nothing but the full 128-bit token from the QR
- P2P connection via ephemeral rooms
- Password required for identity sync
- Data transferred over encrypted WebRTC
- WebAuthn records are never synced (credential is bound to the source
  device's authenticator and would be unusable on the target)

### Future Enhancements

- Check saved password before prompting
- Better merge conflict resolution (thinking in having a events table and merge based on timestamps, latest always wins)
- Progress indicators for large databases
