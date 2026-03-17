# Technical Specsheet

## Data Layer Split

```txt
message log (append-only)  → lamport + watermark sync + IndexedDB
channel mutations (CRDT)   → Yjs per-channel doc (pins, topic, room settings)
identity                   → BIP39 + ed25519, encrypted at rest in IndexedDB
```

---

## IndexedDB Schema (idb)

```typescript
export async function getDB(): Promise<AppDB> {
  // singleton — one connection for app lifetime
  return openDB("awful-chat", 1, {
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

      // identity — keyed by "mnemonic" | "keypair"
      db.createObjectStore("identity", { keyPath: "id" })

      // watermarks — keyed by "roomCode:senderId"
      const wm = db.createObjectStore("watermarks", { keyPath: "id" })
      wm.createIndex("byRoom", "roomCode")

      // Yjs snapshots — keyed by "channel:{roomCode}"
      db.createObjectStore("yjsDocs", { keyPath: "id" })

      // rooms — keyed by roomCode
      const room = db.createObjectStore("rooms", { keyPath: "roomCode" })
      room.createIndex("byType", "type")

      // profiles — "own" + peer did:keys
      db.createObjectStore("profiles", { keyPath: "id" })
    }
  })
}
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
  sig?: string           // ed25519 over canonical(id, senderId, lamport, content)
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
  // chat — persisted to IDB, sent over wire
  Text         = "text",
  Reply        = "reply",
  Reaction     = "reaction",
  File         = "file",
  // presence — wire only, never persisted
  Profile      = "profile",
  CallPresence = "call_presence",
  RoomName     = "room_name",
  // sync — wire only, never persisted
  SyncDigest   = "sync_digest",
  SyncBatch    = "sync_batch",
  SyncComplete = "sync_complete",
  // future
  SyncAck      = "sync_ack",
  DeliveryAck  = "delivery_ack",
  ReadAck      = "read_ack",
  System       = "system",
}

// only chat types are persisted to IDB
type ChatMessageType = MessageType.Text | MessageType.Reply | MessageType.Reaction | MessageType.File

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
type RoomType = "text" | "voice" | "dm"

interface Room {
  roomCode: string
  type: RoomType
  name: string
  lastSeenLamport: number  // unread count derived from this
  createdAt: number
  pfpData?: ArrayBuffer    // local upload — blobURL generated at runtime
  pfpURL?: string          // external URL (tenor, giphy, etc) — stored as-is
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
  // privateKey NEVER stored — derived at unlock, held in memory only
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
// chat message — sent over wire and persisted on receipt
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

// presence — wire only
interface WireProfile      { type: MessageType.Profile;      name: string; did: string | null; avatarUrl: string | null }
interface WireCallPresence { type: MessageType.CallPresence; inCall: boolean }
interface WireRoomName     { type: MessageType.RoomName;     name: string }

// sync — wire only
interface WireSyncDigest   { type: MessageType.SyncDigest;   watermarks: Record<string, number> }
interface WireSyncBatch    { type: MessageType.SyncBatch;    messages: WireChatMessage[]; batchIndex: number; totalBatches: number }
interface WireSyncComplete { type: MessageType.SyncComplete }

// acks — future
interface WireDeliveryAck  { type: MessageType.DeliveryAck;  messageId: string; senderId: string }
interface WireReadAck      { type: MessageType.ReadAck;      messageId: string; senderId: string }

type AnyWireMessage =
  | WireChatMessage | WireProfile | WireCallPresence | WireRoomName
  | WireSyncDigest | WireSyncBatch | WireSyncComplete
  | WireDeliveryAck | WireReadAck

// helpers
function wireToMessage(wire: WireChatMessage, roomCode: string): Message  // adds roomCode + attachments: []
function messageToWire(msg: Message): WireChatMessage                      // strips storage-only fields
function isChatMessage(msg: AnyWireMessage): msg is WireChatMessage        // type guard
```

### Sync Protocol

```typescript
// all messages share a single type discriminant — no kind/wire wrapper
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
  → they do the same — one round trip, bidirectional, no host election

on receive SyncBatch:
  → bulkPut to IDB (idempotent — put by id)
  → update watermarks (max semantics)
  → merge into in-memory message list

on receive SyncComplete:
  → re-sort in-memory list
  → send SyncDigest to all OTHER connected peers (gossip propagation)
    so data spreads through partial meshes without requiring direct connections

SyncRequest removed — push-on-digest replaces it, saving one round trip
```

---

## Yjs Channel Doc

```typescript
// per channel — reactions, edits, deletes, pins, topic
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
peer joins room → connects to all peers in full mesh (SimplePeer)

on each connection (both sides independently):
  → send SyncDigest { watermarks }          // vector clock of what I have

on receive SyncDigest:
  → compute what they're missing            // their watermarks < mine
  → push SyncBatch[] + SyncComplete         // they do the same symmetrically

result:
  → one round trip per peer pair
  → no host election, no single point of failure
  → each SyncComplete triggers gossip to other peers
    (redundant in full mesh, required for future partial mesh / libp2p)

Yjs:
  → piggybacks on SimplePeer data channel (type: "yjs-sync" / "yjs-update")
  → load from IndexedDB before connecting peers
  → save to IndexedDB on every update
```

---

## Identity

### Key Derivation

```txt
password → PBKDF2(salt, 100_000, SHA-256) → AES-256-GCM key → decrypt mnemonic
mnemonic (BIP39, 12 words) → SLIP-0010 → ed25519 keypair
did:key = "did:key:" + base58btc(0xed01 + publicKey)
```

### Unlock Flow

```txt
app open → prompt password → PBKDF2 → AES-GCM decrypt → derive keypair → hold in memory
lock     → zero out private key bytes → null session
```

### Message Signature

```typescript
const canonical = `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`
// sign with private key in memory
// verify with pubkey decoded from senderDid (did:key)
```

---

## DM Encryption

```typescript
// ed25519 → curve25519 conversion for ECDH
const sharedSecret = x25519(edwardsToMontgomeryPriv(myPrivKey), edwardsToMontgomeryPub(theirPubKey))
// then AES-GCM with sharedSecret as key
// { iv, ct } transmitted in WireMessage.content
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
Yjs updates:       { kind: "yjs-update", doc, data: number[] }
                   incremental ops typically < 1KB
                   initial yjs-sync on connect can be larger — stays under 64KB
                   for channel docs (reactions, edits, pins)
```

---

## Voice/Video

```txt
Voice:
  - p2p via SimplePeer (mic only, audio stays peer-to-peer always)
  - Web Audio input gain + output volume + device selection
  - input chain:  mic → GainNode → MediaStreamDestination → peers
  - output chain: remoteStream → GainNode → AudioContext.destination (per peer)
  - gain supports boost above 1.0 via Web Audio

Video:
  - mediasoup SFU over dedicated /sfu WebSocket signaling
  - camera and screen published as separate sources ("camera" | "screen")
  - recv/send transports created after router capabilities exchange
  - Node.js worker process required for mediasoup (not compatible with Bun)
  - Bun handles all client-facing signaling, proxies ms: messages to Node worker

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
text/voice:  slugify(name) + "-" + sha256(creatorDid + salt)[0..4]
DM:          sha256(sort([didA, didB]).join(':'))[0..24]
```

---

## Server Privacy

```txt
signaling server knows:  ephemeral session ID + roomCode only
never knows:             did:key, message content, Yjs content
all p2p:                 messages, files, Yjs — direct between peers
```

---

## Future: Roles + Permissions (Hash Chain Model)

*Deferred — implement after core is stable*

When roles are needed, the model is:

```txt
room creation:
  roomCode embeds commitment to creatorDid
  genesis entry signed by creator → stored in Yjs
  genesis is the trust anchor — verifiable from roomCode alone

role changes:
  each mutation is a SignedMutation { update, signer, sig, lamport }
  signer's role at mutation time determines if it is accepted
  replayed in lamport order — post-revocation mutations rejected

hash chain:
  each entry references prevHash = sha256(previous entry)
  omitting an entry breaks the chain → detectable
  peer serving truncated chain exposed when longer valid chain exists
  owner coming online with full chain → rollback of invalid optimistic state

known limitation:
  if only malicious peers are reachable, role state may be stale
  mitigated by syncing from multiple peers + longest valid chain wins
  signaling server can optionally store and serve the chain
```

---

## Future: Sequential Sync Queue

*Deferred — only worth implementing if rooms grow large with many simultaneous joins*

**Problem:** When a peer joins and connects to N peers at once, all N digest exchanges happen in parallel. Each peer responds independently with what the joiner is missing — so the same messages can arrive from multiple peers before any response has been processed, wasting bandwidth.

```
A connects to B and C simultaneously:
  A → B: digest             A → C: digest
  B → A: pushes missing     C → A: pushes same missing  ← duplicate on air
```

**Solution:** Queue digest sends and process them sequentially — wait for SyncComplete from peer N before sending digest to peer N+1. By the time you reach C, your watermarks reflect what B already sent, so C only pushes the delta.

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

**Tradeoff:** Adds latency on join — you wait for the first peer's full push before starting with the second. For small rooms (2–5 peers) with modest history, parallel is faster and the duplicate data is negligible. Sequential only pays off with larger rooms or large histories where duplicate transmission is significant.

**Current behavior:** Parallel. Each peer connection runs an independent digest/push cycle. Duplicate data in flight is bounded to messages missing at join time, sent once per already-connected peer.
