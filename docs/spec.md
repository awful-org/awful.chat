# Technical Specsheet

## Current Functionality (Implemented)

```txt
Identity and profile
  - BIP39 mnemonic identity, password-encrypted at rest (AES-GCM)
  - did:key derivation from ed25519 public key
  - unlock/lock session model (private key in memory only while unlocked)
  - locked-screen recovery entrypoint (recover from 12-word phrase)
  - local profile (nickname + avatar URL/data) and peer profile caching

Rooms and chat
  - create/join room by code
  - room sidebar with saved rooms + unread tracking
  - persistent local history (IndexedDB)
  - lamport-ordered message log + watermark sync on reconnect
  - pagination / load-more history
  - peer profile broadcast and display in chat/call UI
  - reply and reaction interactions in chat UI

Local data controls
  - destructive "erase all local data" action in settings (confirmed wipe of IndexedDB)

Collaboration data
  - Not yet implemented in current app flow (planned): Yjs per-room channel doc for edits/deletes/reactions/pins/topic

Files
  - Not yet implemented in current app flow (planned): WebTorrent-based p2p file transfer

Calls
  - p2p voice via SimplePeer + Web Audio input/output controls
  - working duplex voice (early-stream race buffered until join completes)
  - deafen/undeafen support (voice + transmission output mute/restore)
  - SFU video via mediasoup (camera + screen share)
  - opt-in screen-share transmissions (remote screen is not auto-consumed)
  - explicit "watch transmission" and "stop watching" flow
  - transmission volume slider while watching
  - screen-share tab/system audio publishing + playback for watchers
  - late-join handling for existing SFU producers
  - producer lifecycle signaling to clear stale transmission tiles
  - explicit call-presence sync so in-call peer tiles are stable
  - room-name sync message over p2p data channel
  - local camera/screen preview + remote participant tiles + active speaker ring

Chat interactions
  - message replies (quote + jump to original)
  - message reactions with toggle semantics (add/remove)
```

## Data Layer Split

```txt
message log (append-only)  → lamport + watermark sync + IndexedDB
channel mutations (CRDT)   → Yjs per-channel doc (reactions, edits, deletes)
identity                   → BIP39 + ed25519, encrypted at rest in IndexedDB
```

Note: the Yjs mutation layer and WebTorrent integration are currently design targets but not wired in the active production message flow yet.

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
  type: MessageType
  content: string
  meta?: FileMeta
  attachments: string[]  // Attachment.id refs
  replyTo?: ReplyTo
  status?: MessageStatus // DMs only
}

enum MessageType {
  Text         = "text",
  File         = "file",
  System       = "system",
  Reply        = "reply",
  SyncRequest  = "sync_request",
  SyncOffer    = "sync_offer",
  SyncBatch    = "sync_batch",
  SyncComplete = "sync_complete",
  SyncAck      = "sync_ack",
  DeliveryAck  = "delivery_ack",
  ReadAck      = "read_ack",
}

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

### Identity Types

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
interface WireMessage {
  id: string
  senderId: string
  senderName: string
  senderDid?: string
  sig?: string
  timestamp: number
  lamport: number
  type: MessageType
  content: string
  meta?: FileMeta
  replyTo?: ReplyTo
}

interface WireDeliveryAck { type: MessageType.DeliveryAck; messageId: string; senderId: string }
interface WireReadAck     { type: MessageType.ReadAck;     messageId: string; senderId: string }
```

### Sync Protocol

```typescript
interface SyncRequest {
  type: MessageType.SyncRequest
  roomCode: string
  watermarks: Record<string, number>  // senderId → maxLamport seen from them
}
interface SyncOffer    { type: MessageType.SyncOffer;    totalMessages: number; totalBatches: number }
interface SyncBatch    { type: MessageType.SyncBatch;    messages: Message[]; batchIndex: number; totalBatches: number }
interface SyncComplete { type: MessageType.SyncComplete }
interface SyncAck      { type: MessageType.SyncAck }
```

---

## Yjs Channel Doc

```typescript
// per channel — reactions, edits, deletes, pins, topic
// keyed in IndexedDB as "channel:{roomCode}"

channelDoc.getMap<Y.Map<Y.Array<string>>>('reactions') // messageId → emoji → senderIds
channelDoc.getMap<{ content: string; editedAt: number }>('edits')      // messageId → edit
channelDoc.getMap<{ deletedAt: number; deletedBy: string }>('deletes') // messageId → tombstone
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
peer joins room:
  → selectSyncHost([...connectedPeers, myId].sort()[0])
  → if not host: send SyncRequest { watermarks }
  → if host: respond with SyncOffer + SyncBatch[]

host failure (no SyncComplete within 10s):
  → recalculate from remaining peers → restart → deduplicate by id

Yjs:
  → piggybacks on SimplePeer data channel (kind: "yjs-sync" / "yjs-update")
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
  - p2p via SimplePeer (mic only)
  - Web Audio input gain + output volume + device selection

Video:
  - mediasoup SFU over dedicated /sfu WebSocket signaling
  - camera and screen published as separate sources ("camera" | "screen")
  - recv/send transports created after router capabilities exchange

Screen share transmissions:
  - remote screen producers emit transmissionAvailable(peerId, producerId)
  - UI shows pending "Click to watch" tile (not auto-consumed)
  - watchTransmission(peerId, producerId) consumes all available screen producers for that peer (video + optional audio)
  - stopWatchingTransmission() closes the screen consumer and restores pending tile
  - transmissionEnded(peerId) clears pending/watching state
  - delayed screen-audio producers are auto-consumed while already watching
  - SFU emits producer-closed so stopped shares remove stale pending tiles

Late join behavior:
  - SFU replays existing producers to newly joined peers
  - client queues early ms:new-producer signals until recv transport is ready
  - prevents missing tiles/audio-video until peers rejoin
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

## Future: Roles + Permissions (Hash Chain Model) (maybe)

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
