# Awful Chat — Roadmap

## Stack Overview

```txt
Bun             → signaling server (WebSocket, relay only)
SimplePeer      → p2p mesh (full mesh rooms, DMs, 1-on-1 calls)
WebTorrent v1   → file transfer (always p2p)
mediasoup       → voice/video SFU (group calls)
Yjs             → channel mutations (reactions, edits, deletes, pins, topic)
BIP39 + ed25519 → identity (did:key, message signing)
idb             → local persistence (messages, attachments, state)
```

---

## Phase 1 — Core Mesh Chat ✓ (current)

- [x] Bun WebSocket signaling server
- [x] SimplePeer full mesh
- [x] Room creation and peer joining
- [x] Text messaging over data channel
- [x] File transfer via WebTorrent v1
- [x] Basic Svelte UI

---

## Phase 2 — Message Reliability + Offline Sync (partially implemented)

**Goal:** messages never lost, offline peers catch up on reconnect

### 2.1 Data Layer Split

```txt
message log (append-only)
  → manual lamport + watermark sync
  → IndexedDB as source of truth
  → pagination friendly, unbounded history

channel mutations (concurrent writes)
  → planned Yjs per-channel doc
  → current implementation uses wire messages for replies/reactions
  → edits/deletes/pins/topic remain pending
```

### 2.2 Room Code

```txt
format:  "general-4f2a"  (slug + 4 char hex suffix)
         hex suffix = first 4 chars of sha256(creatorDid + random salt)
         unique, collision-resistant, human-readable
DM:      sha256(sort([didA, didB]).join(':'))[0..24] hex — deterministic
```

### 2.3 Message Types

```typescript
enum MessageType {
  Text         = "text",
  File         = "file",
  System       = "system",       // "X joined", "X left"
  Reply        = "reply",
  SyncRequest  = "sync_request",
  SyncOffer    = "sync_offer",
  SyncBatch    = "sync_batch",
  SyncComplete = "sync_complete",
  SyncAck      = "sync_ack",
  DeliveryAck  = "delivery_ack", // DMs only
  ReadAck      = "read_ack",     // DMs only
}
// edit, delete, reaction → Yjs mutations, not wire types
```

### 2.4 Core Message (IndexedDB — `storage.ts`)

```typescript
interface Message {
  id: string             // UUIDv7
  roomCode: string
  senderId: string
  senderName: string
  senderDid?: string     // optional until phase 3
  sig?: string           // ed25519 — optional until phase 3
  timestamp: number      // wall clock, display only
  lamport: number        // logical clock, ordering source of truth
  type: MessageType
  content: string
  meta?: FileMeta
  attachments: string[]  // Attachment.id refs
  replyTo?: ReplyTo
  status?: MessageStatus // DMs only
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

### 2.5 Yjs Channel Doc — Mutations (`channelStore.ts`)

```typescript
const channelDoc = new Y.Doc()

// reactions: messageId → emoji → Y.Array<senderId>
const reactions = channelDoc.getMap<Y.Map<Y.Array<string>>>('reactions')

// edits: messageId → { content, editedAt }
// only message owner can edit — verified before calling
const edits = channelDoc.getMap<{ content: string; editedAt: number }>('edits')

// deletes: messageId → tombstone — soft delete
const deletes = channelDoc.getMap<{ deletedAt: number; deletedBy: string }>('deletes')

// pins and topic
const pins  = channelDoc.getArray<string>('pins')
const topic = channelDoc.getText('topic')
```

**UI merge:**

```typescript
interface ResolvedMessage extends Message {
  content: string
  edited: boolean
  deleted: boolean
  reactions: Record<string, string[]>
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

### 2.6 Attachment (IndexedDB — `storage.ts`)

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

**File strategy:**

```txt
< 5MB  → ArrayBuffer in IndexedDB + auto re-seed on startup
> 5MB  → infoHash only, re-download on demand from peers
always → infoHash persisted — download possible while someone seeds
```

### 2.7 Wire Message (DataChannel — `useDataChannel.ts`)

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

Max DataChannel message: 64KB. SyncBatch: max 20 messages per batch.

### 2.8 Lamport Clock

```typescript
// send:    clock++
// receive: clock = max(local, received) + 1

function sortMessages(a: Message, b: Message): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.senderId.localeCompare(b.senderId)  // tiebreaker
}
```

### 2.9 Sync Protocol (`sync.ts`)

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

**Host selection:**

```typescript
// lowest peerId lexicographically — deterministic, no coordination needed
function selectSyncHost(peers: string[], myId: string): string {
  return [...peers, myId].sort()[0]
}
```

**Host failure:** no SyncComplete within 10s → recalculate host → restart → deduplicate by id.

### 2.10 Yjs Sync Transport

Yjs piggybacks on the existing SimplePeer data channel — no y-webrtc dep.

```typescript
// on peer connect — send full Yjs state
peer.on('connect', () => {
  for (const [id, doc] of yjsDocs) {
    const state = Y.encodeStateAsUpdate(doc)
    peer.send(JSON.stringify({ kind: 'yjs-sync', doc: id, data: Array.from(state) }))
  }
})

// on data
peer.on('data', raw => {
  const msg = JSON.parse(raw)
  if (msg.kind === 'yjs-update' || msg.kind === 'yjs-sync') {
    const doc = yjsDocs.get(msg.doc)
    if (!doc) return
    Y.applyUpdate(doc, new Uint8Array(msg.data))
    if (msg.kind === 'yjs-sync') {
      const state = Y.encodeStateAsUpdate(doc)
      peer.send(JSON.stringify({ kind: 'yjs-update', doc: msg.doc, data: Array.from(state) }))
    }
  }
})

// on local Yjs change — broadcast
doc.on('update', (update: Uint8Array) => {
  const msg = JSON.stringify({ kind: 'yjs-update', doc: docId, data: Array.from(update) })
  for (const peer of connectedPeers) peer.send(msg)
})
```

Yjs persistence — load before connecting peers, save on every update:

```typescript
await loadYjsDoc(db, `channel:${roomCode}`, doc)
doc.on('update', () => saveYjsDoc(db, `channel:${roomCode}`, doc))
```

### 2.11 Message Pagination

```typescript
const PAGE_SIZE = 50

async function loadMessages(roomCode: string, beforeLamport?: number): Promise<Message[]> {
  // cursor-based, returns oldest→newest
  // virtual scroll in UI — load more on scroll up
}
```

---

## Phase 3 — Identity (BIP39 + ed25519) ✓ (implemented)

**Goal:** persistent cryptographic identity, recoverable, portable

### 3.1 Key Generation

```
BIP39 mnemonic (12 words)
  → PBKDF2 seed
  → SLIP-0010 ed25519 derivation  ← not BIP32, unsafe for ed25519
  → root keypair
  → did:key = "did:key:" + base58btc(0xed01 + publicKey)
```

### 3.2 Mnemonic at Rest

```
encrypted with AES-GCM
key derived from user password via PBKDF2 (separate from identity derivation)
stored in IndexedDB — private key NEVER stored, derived at unlock only
```

### 3.3 Message Signing

```typescript
// canonical excludes timestamp — wall clock is untrusted
const canonical = `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`
const sig = hex(ed25519.sign(utf8(canonical), privateKey))

// verify — public key decoded from senderDid
const valid = ed25519.verify(unhex(sig), utf8(canonical), pubkeyFromDid(senderDid))
```

### 3.4 Account Recovery

- 12-word mnemonic on first launch — user must confirm backup
- Same mnemonic on any device → same keypair → same did:key
- Identity survives device loss

### 3.5 User Profile

```typescript
interface OwnProfile {
  id: "own"
  did: string
  nickname: string
  pfpData?: ArrayBuffer  // local file upload, < 2MB
  pfpURL?: string        // external URL (tenor, giphy, etc) — stored as-is
  updatedAt: number
  // pfpData and pfpURL are mutually exclusive
  // pfpData → blobURL generated at runtime, never stored
  // pfpURL  → rendered directly as <img src>
}
```

Profile broadcast over data channel on connect so peers can cache it.

---

## Phase 4 — DMs (in progress)

**Goal:** private 1-on-1 messages, encrypted, reliable delivery

### 4.1 DM Rooms

```txt
roomCode    = sha256(sort([didA, didB]).join(':'))[0..24]
transport   = SimplePeer direct
encryption  = X25519 ECDH (ed25519 keys converted to curve25519)
```

### 4.2 Delivery Flow

```txt
online:   encrypt → send → DeliveryAck → ReadAck
offline:  encrypt → store as PendingMessage → watch presence
          → peer online → flush → DeliveryAck → ReadAck
```

---

## Phase 5 — Voice/Video (mediasoup) ✓ (implemented)

**Goal:** voice and video calls

### 5.1 1-on-1 / voice path → SimplePeer direct, no SFU

### 5.2 Group video (≤15) → mediasoup SFU, text+files remain p2p

Implemented behavior:

```txt
- Voice remains p2p (SimplePeer) with mic/device/gain controls.
- Voice deafen/undeafen is implemented via output gain control.
- Duplex voice join race is handled (early remote streams buffered until join).
- Video (camera + screen) is SFU-backed via mediasoup signaling over /sfu WebSocket.
- Remote screen share is opt-in: peers receive a pending transmission tile and click to watch.
- "Stop watching" restores pending transmission tile while producer is still active.
- Transmission volume control while watching is implemented.
- Screen-share tab/system audio is published and consumed for watchers.
- Late joiners consume existing producers via replayed ms:new-producer events.
- Client queues early producer notifications until recv transport is ready (race-safe).
- SFU producer-closed signaling clears stale transmission tiles when shares end.
- Explicit call-presence + room-name sync messages keep call UI state consistent across peers.
- Local camera/screen preview reuses the same captured stream for publish (single permission prompt).

## Chat Interaction Milestone (current)

```txt
- Reply UX: hover action, quote preview above composer, sent quote snapshot,
  click quote to scroll/highlight original message.
- Reaction UX: hover action, emoji picker, toggle add/remove, and per-message
  reaction chips with click-to-join behavior.
```

## UX + Safety Milestone (current)

```txt
- Locked-screen account recovery now routes into the existing restore flow
  (no duplicate recovery implementation).
- Settings include a confirmed destructive action to wipe all local IndexedDB
  data (messages/media/rooms/profiles/identity) for device reset/privacy.
- Device picker labels are truncated to avoid layout breakage on long names.
```
```

---

## Future / Post-Launch

- [ ] Roles + permissions (hash chain model — see SPECSHEET.md)
- [ ] Server-side file pinning (operator opt-in)
- [ ] Integrate WebTorrent file flow into active chat UI/path
- [ ] Yjs mutation layer for edits/deletes/pins/topic reconciliation
- [ ] mediasoup horizontal scaling
- [ ] E2E encryption for rooms (MLS protocol)
- [ ] Federation (Matrix-style)
- [ ] Mobile (Capacitor or React Native)
- [ ] WebAuthn / biometrics as mnemonic unlock

---

## Dependencies Per Phase

| Phase | New Deps |
|-------|----------|
| 1 ✓   | simplepeer, webtorrent@1, bun |
| 2     | idb, uuidv7, yjs |
| 3     | @noble/curves, @noble/hashes, @scure/bip39, @scure/bip32, @scure/base |
| 4     | (no new deps) |
| 5     | mediasoup-client |
