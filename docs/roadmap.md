# Awful Chat — Roadmap

## Stack Overview

```txt
Bun             → signaling server (WebSocket, relay only) + Klipy GIF proxy
SimplePeer      → p2p mesh (full mesh rooms, DMs, 1-on-1 voice)
WebTorrent v1   → file transfer (always p2p)
mediasoup       → video SFU (group calls — audio stays p2p always)
Yjs             → channel mutations (pins, topic, room settings) [planned]
BIP39 + ed25519 → identity (did:key, message signing)
idb             → local persistence (messages, attachments, state)
```

---

## Phase 1 — Core Mesh Chat ✓

- [x] Bun WebSocket signaling server
- [x] SimplePeer full mesh
- [x] Room creation and peer joining
- [x] Text messaging over data channel
- [x] Basic Svelte UI
- [x] WebTorrent v1 client wired (seeding/leeching infrastructure ready)

---

## Phase 2 — Message Reliability + Offline Sync ✓

**Goal:** messages never lost, offline peers catch up on reconnect

### 2.1 Data Layer Split

```txt
message log (append-only)
  → lamport clock + watermark vector clock
  → IndexedDB as source of truth
  → pagination-friendly, unbounded history

channel mutations (concurrent writes)
  → Yjs per-channel doc [planned]
  → current: replies and reactions stored as Message rows
  → edits/deletes/pins/topic remain pending
```

### 2.2 Room Code

```txt
text/voice:  slugify(name) + "-" + sha256(creatorDid + salt)[0..4]
DM:          sha256(sort([didA, didB]).join(':'))[0..24]
```

### 2.3 Message Types

```typescript
enum MessageType {
  // chat — persisted to IDB
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

type ChatMessageType = MessageType.Text | MessageType.Reply | MessageType.Reaction | MessageType.File
```

### 2.4 Core Message (IndexedDB)

```typescript
interface Message {
  id: string             // UUIDv7
  roomCode: string
  senderId: string
  senderName: string
  senderDid?: string
  sig?: string           // ed25519 over canonical(id, senderId, lamport, content)
  timestamp: number      // wall clock, display only
  lamport: number        // logical clock, ordering source of truth
  type: ChatMessageType  // only chat types persisted
  content: string
  meta?: FileMeta
  attachments: string[]  // Attachment.id refs
  replyTo?: ReplyTo
  reactionTo?: string
  reactionEmoji?: string
  reactionOp?: "add" | "remove"
  status?: MessageStatus // DMs only
}

type MessageStatus = "sending" | "sent" | "delivered" | "read"
```

### 2.5 Wire Types

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

// presence
interface WireProfile      { type: MessageType.Profile;      name: string; did: string | null; avatarUrl: string | null }
interface WireCallPresence { type: MessageType.CallPresence; inCall: boolean }
interface WireRoomName     { type: MessageType.RoomName;     name: string }

// sync
interface WireSyncDigest   { type: MessageType.SyncDigest;   watermarks: Record<string, number> }
interface WireSyncBatch    { type: MessageType.SyncBatch;    messages: WireChatMessage[]; batchIndex: number; totalBatches: number }
interface WireSyncComplete { type: MessageType.SyncComplete }

type AnyWireMessage = WireChatMessage | WireProfile | WireCallPresence | WireRoomName
                    | WireSyncDigest | WireSyncBatch | WireSyncComplete | ...
```

All messages share a single `type` discriminant — no `kind`/`wire` wrapper. Message handler is a flat `switch (msg.type)`. Helpers: `wireToMessage(wire, roomCode)`, `messageToWire(msg)`, `isChatMessage(msg)`.

Max DataChannel message: 64 KB. SyncBatch: max 20 messages per batch.

### 2.6 Lamport Clock

```typescript
// send:    clock++
// receive: clock = max(local, received) + 1

function sortMessages(a: Message, b: Message): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.senderId.localeCompare(b.senderId)  // deterministic tiebreaker
}
```

### 2.7 Sync Protocol — Push-on-Digest

```txt
on connect (both peers independently):
  → send SyncDigest { watermarks }   // vector clock: senderId → maxLamport

on receive SyncDigest:
  → compute what they're missing (their watermarks < mine per sender)
  → push SyncBatch[] + SyncComplete
  → they do the same symmetrically

result:
  → one round trip per peer pair, bidirectional, no host election
  → on SyncComplete: gossip digest to all other connected peers
    (redundant in full mesh, required for future partial mesh / libp2p)

SyncRequest removed — push-on-digest saves one round trip vs request/response
```

Watermarks are `Record<senderId, maxLamport>` — a vector clock. IDB `put` is idempotent by id so duplicate batch delivery is safe.

### 2.8 Attachment

```typescript
interface Attachment {
  id: string             // UUIDv7
  roomCode: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  infoHash: string       // permanent WebTorrent reference
  data?: ArrayBuffer     // only if size < 5MB
  blobURL?: string       // runtime only, never persisted
  status: AttachmentStatus
  createdAt: number
}

type AttachmentStatus = "seeding" | "pending" | "downloading" | "complete" | "failed"
```

```txt
< 5MB  → ArrayBuffer in IndexedDB + auto re-seed on startup
> 5MB  → infoHash only, re-download on demand
```

### 2.9 Yjs Channel Doc (planned)

```typescript
channelDoc.getMap<Y.Map<Y.Array<string>>>('reactions') // messageId → emoji → senderIds
channelDoc.getMap<{ content: string; editedAt: number }>('edits')
channelDoc.getMap<{ deletedAt: number; deletedBy: string }>('deletes')
channelDoc.getArray<string>('pins')
channelDoc.getText('topic')
```

Yjs piggybacks on SimplePeer data channel (`type: "yjs-sync"` / `"yjs-update"`). Load from IDB before connecting peers, save on every update.

---

## Phase 3 — Identity ✓

**Goal:** persistent cryptographic identity, recoverable, portable

### 3.1 Key Derivation

```
password → PBKDF2(salt, 100_000, SHA-256) → AES-256-GCM key → decrypt mnemonic
mnemonic (BIP39, 12 words) → SLIP-0010 → ed25519 keypair
did:key = "did:key:" + base58btc(0xed01 + publicKey)
private key NEVER stored — derived at unlock, held in memory only
```

### 3.2 Message Signing

```typescript
const canonical = `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`
// timestamp excluded — wall clock is untrusted
```

### 3.3 Profile

```typescript
interface OwnProfile {
  id: "own"
  did: string
  nickname: string
  pfpData?: ArrayBuffer  // local upload — blobURL generated at runtime
  pfpURL?: string        // external URL (tenor, giphy, etc)
  updatedAt: number
  // pfpData and pfpURL mutually exclusive
}
```

Profile broadcast on connect (`WireProfile`) so peers cache name/avatar.

---

## Phase 4 — DMs (in progress)

**Goal:** private 1-on-1 messages, encrypted, reliable delivery

### 4.1 DM Rooms

```txt
roomCode  = sha256(sort([didA, didB]).join(':'))[0..24]
transport = SimplePeer direct
encrypt   = X25519 ECDH (ed25519 → curve25519 key conversion)
```

### 4.2 Delivery Flow

```txt
online:   encrypt → send → DeliveryAck → ReadAck
offline:  encrypt → PendingMessage in IDB → watch presence
          → peer online → flush pending → DeliveryAck → ReadAck
```

---

## Phase 5 — Voice/Video ✓

**Goal:** voice and video calls

### 5.1 Voice — SimplePeer p2p (audio never goes through SFU)

```txt
input chain:  mic → GainNode → MediaStreamDestination → peers
output chain: remoteStream → GainNode → AudioContext.destination (per peer)

controls: mute, input device, input gain (0–2.0), output device, output volume (0–2.0)
deafen:   output gain → 0, restores saved volume on undeafen
```

### 5.2 Video — mediasoup SFU

```txt
signaling: dedicated /sfu WebSocket (separate from p2p signaling)
server:    Node.js worker required (mediasoup not compatible with Bun)
           Bun handles all client-facing traffic, proxies ms: messages to Node internally

sources:   "camera" | "screen" published as separate producers
screen:    opt-in — pending "Click to watch" tile, not auto-consumed
           watchTransmission(peerId, producerId) → consume video + optional audio
           stopWatchingTransmission() → close consumer, restore pending tile
           transmissionEnded(peerId) → clear state

late join: SFU replays existing producers; client queues early signals
           until recv transport is ready (race-safe)
```

---

## Phase 6 — File Transfer (next)

**Goal:** p2p file sharing wired into the active chat UI

```txt
send:
  1. wtClient.seed(file, { announce: [] }) → infoHash
  2. store Attachment { infoHash, status: "seeding" }
  3. if size < 5MB: store data: ArrayBuffer
  4. broadcast WireChatMessage { type: File, meta: FileMeta }

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

## Future / Post-Launch

- [ ] Roles + permissions (hash chain model — see SPECSHEET.md)
- [ ] Server-side file pinning (operator opt-in)
- [ ] Yjs mutation layer for edits/deletes/pins/topic
- [ ] Sequential sync queue — reduces duplicate data when N peers connect simultaneously on join (see SPECSHEET.md)
- [ ] libp2p transport — partial mesh support; gossip propagation already handled by sync design
- [ ] mediasoup horizontal scaling
- [ ] E2E encryption for rooms (MLS protocol)
- [ ] WebAuthn / biometrics as mnemonic unlock

---

## Dependencies Per Phase

| Phase | New Deps |
|-------|----------|
| 1 ✓   | simplepeer, webtorrent@1, bun |
| 2 ✓   | idb, uuidv7, yjs |
| 3 ✓   | @noble/curves, @noble/hashes, @scure/bip39, @scure/bip32, @scure/base |
| 4     | (no new deps) |
| 5 ✓   | mediasoup-client |
| 6     | (no new deps — webtorrent already in phase 1) |
