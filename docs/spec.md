# Technical Specsheet

## Data Layer Split

```txt
append-only log      → manual lamport + watermark sync + IndexedDB
concurrent mutations → Yjs CRDT per channel doc
server state         → Yjs CRDT per server doc
```

---

## IndexedDB Schema (idb)

```typescript
import { openDB, type IDBPDatabase } from "idb";

const STORES = {
  messages: "messages",
  attachments: "attachments",
  pending: "pending",
  identity: "identity",
  watermarks: "watermarks",
  yjsDocs: "yjsDocs",
} as const;

export async function openAppDB(): Promise<IDBPDatabase> {
  return openDB("app", 1, {
    upgrade(db) {
      // messages — indexed by roomCode+lamport for paginated queries
      const msg = db.createObjectStore("messages", { keyPath: "id" });
      msg.createIndex("byRoom", "roomCode");
      msg.createIndex("byRoomLamport", ["roomCode", "lamport"]);
      msg.createIndex("bySender", "senderId");

      // attachments — indexed for lookup by message and by infoHash
      const att = db.createObjectStore("attachments", { keyPath: "id" });
      att.createIndex("byMessage", "messageId");
      att.createIndex("byInfoHash", "infoHash");
      att.createIndex("byStatus", "status");

      // pending DM messages
      const pen = db.createObjectStore("pending", { keyPath: "id" });
      pen.createIndex("byRecipient", "to");

      // identity — single record, keyed by 'mnemonic'
      db.createObjectStore("identity", { keyPath: "id" });

      // watermarks — keyed by "roomCode:senderId"
      db.createObjectStore("watermarks", { keyPath: "id" });

      // Yjs doc snapshots — keyed by "server:serverId" or "channel:roomCode"
      db.createObjectStore("yjsDocs", { keyPath: "id" });
    },
  });
}
```

### Common Queries

```typescript
// paginated messages for a room (50 per page, cursor-based)
async function getMessages(
  db: IDBPDatabase,
  roomCode: string,
  beforeLamport?: number,
) {
  const index = db.transaction("messages").store.index("byRoomLamport");
  const range = beforeLamport
    ? IDBKeyRange.bound([roomCode, 0], [roomCode, beforeLamport], false, true)
    : IDBKeyRange.bound([roomCode, 0], [roomCode, Infinity]);
  const results: Message[] = [];
  let cursor = await index.openCursor(range, "prev");
  while (cursor && results.length < 50) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results.reverse();
}

// watermark lookup
function watermarkKey(roomCode: string, senderId: string) {
  return `${roomCode}:${senderId}`;
}

// Yjs persistence
async function saveYjsDoc(db: IDBPDatabase, id: string, doc: Y.Doc) {
  const update = Y.encodeStateAsUpdate(doc);
  await db.put("yjsDocs", { id, update });
}

async function loadYjsDoc(db: IDBPDatabase, id: string, doc: Y.Doc) {
  const record = await db.get("yjsDocs", id);
  if (record) Y.applyUpdate(doc, record.update);
}
```

---

## Types

### Message

```typescript
interface Message {
  id: string; // UUIDv7
  roomCode: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string; // ed25519 over canonical(id, senderId, lamport, content)
  timestamp: number; // wall clock, display only
  lamport: number; // logical clock, ordering source of truth
  type: MessageType;
  content: string;
  meta?: FileMeta;
  attachments: string[]; // Attachment.id refs
  replyTo?: ReplyTo;
  status?: MessageStatus; // DMs only
}

enum MessageType {
  Text = "text",
  File = "file",
  System = "system",
  Reply = "reply",
  SyncRequest = "sync_request",
  SyncOffer = "sync_offer",
  SyncBatch = "sync_batch",
  SyncComplete = "sync_complete",
  SyncAck = "sync_ack",
  DeliveryAck = "delivery_ack",
  ReadAck = "read_ack",
}

type MessageStatus = "sending" | "sent" | "delivered" | "read";

interface ReplyTo {
  id: string;
  senderName: string;
  content: string; // snapshot at send time
}

interface FileMeta {
  files: FileEntry[];
}

interface FileEntry {
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string;
}
```

### Attachment

```typescript
interface Attachment {
  id: string; // UUIDv7
  roomCode: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string; // permanent WebTorrent reference
  data?: ArrayBuffer; // only if size < 5MB
  blobURL?: string; // runtime only, never persisted
  status: AttachmentStatus;
  createdAt: number;
}

type AttachmentStatus =
  | "seeding"
  | "pending"
  | "downloading"
  | "complete"
  | "failed";
```

### Wire Types

```typescript
interface WireMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string;
  timestamp: number;
  lamport: number;
  type: MessageType;
  content: string;
  meta?: FileMeta;
  replyTo?: ReplyTo;
}

interface WireDeliveryAck {
  type: MessageType.DeliveryAck;
  messageId: string;
  senderId: string;
}
interface WireReadAck {
  type: MessageType.ReadAck;
  messageId: string;
  senderId: string;
}
```

### Sync Protocol

```typescript
interface SyncRequest {
  type: MessageType.SyncRequest;
  roomCode: string;
  watermarks: Record<string, number>; // senderId → maxLamport seen from them
}
interface SyncOffer {
  type: MessageType.SyncOffer;
  totalMessages: number;
  totalBatches: number;
}
interface SyncBatch {
  type: MessageType.SyncBatch;
  messages: Message[];
  batchIndex: number;
  totalBatches: number;
}
interface SyncComplete {
  type: MessageType.SyncComplete;
}
interface SyncAck {
  type: MessageType.SyncAck;
}
```

### Watermark Record

```typescript
interface WatermarkRecord {
  roomCode: string;
  senderId: string;
  maxLamport: number;
}
```

### Identity

```typescript
interface IdentityRecord {
  id: "mnemonic" | "keypair";
  salt?: Uint8Array;
  iv?: Uint8Array;
  encrypted?: ArrayBuffer; // AES-GCM encrypted mnemonic
  publicKey?: Uint8Array; // ed25519 public key (cached for perf)
}
```

### Pending Message

```typescript
interface PendingMessage {
  id: string;
  to: string; // recipient did:key
  message: WireMessage;
  createdAt: number;
  attempts: number;
}
```

---

## Yjs Documents

### Per Server (`serverDoc`)

```typescript
serverDoc.getMap("members"); // did:key → { name: string, avatar: string, joinedAt: number }
serverDoc.getMap("roles"); // did:key → roleId: string
serverDoc.getMap("rolesDef"); // roleId → { name: string, color: string, permissions: string[] }
serverDoc.getMap("channels"); // channelId → { name: string, type: ChannelType, roomCode: string }
serverDoc.getMap("presence"); // did:key → { online: boolean, typing: boolean, lastSeen: number }
serverDoc.getMap("settings"); // 'name' | 'icon' | 'description' → string
serverDoc.getMap("revocations"); // tokenCID → { revokedAt: number, revokedBy: string }

enum ChannelType {
  Text = "text",
  Voice = "voice",
  DM = "dm",
}
```

### Per Channel (`channelDoc`)

```typescript
// reactions: messageId → emoji → Y.Array<senderId>
channelDoc.getMap<Y.Map<Y.Array<string>>>("reactions");

// edits: messageId → latest edit
channelDoc.getMap<{ content: string; editedAt: number; editedBy: string }>(
  "edits",
);

// deletes: messageId → tombstone
channelDoc.getMap<{ deletedAt: number; deletedBy: string }>("deletes");

// pins: ordered list of pinned messageIds
channelDoc.getArray<string>("pins");

// topic: collaborative text
channelDoc.getText("topic");
```

### Resolved Message (UI)

```typescript
interface ResolvedMessage extends Message {
  content: string; // original | edited content | "" if deleted
  edited: boolean;
  deleted: boolean;
  reactions: Record<string, string[]>; // { emoji → senderId[] }
}

function resolveMessage(msg: Message, channelDoc: Y.Doc): ResolvedMessage {
  const edits = channelDoc.getMap("edits");
  const deletes = channelDoc.getMap("deletes");
  const rxns = channelDoc.getMap("reactions");
  const edit = edits.get(msg.id) as { content: string } | undefined;
  const del = deletes.get(msg.id) as { deletedAt: number } | undefined;
  return {
    ...msg,
    content: del ? "" : (edit?.content ?? msg.content),
    edited: !!edit && !del,
    deleted: !!del,
    reactions: yReactionsToRecord(rxns.get(msg.id)),
  };
}
```

---

## Lamport Clock

```typescript
// on send:    clock++
// on receive: clock = max(clock, received) + 1

function sortMessages(a: Message, b: Message): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.senderId.localeCompare(b.senderId); // deterministic tiebreaker
}
```

---

## Sync Flow

```txt
peer joins room
  → selectSyncHost([...connectedPeers, myId].sort()[0])
  → if not host: send SyncRequest { watermarks }
  → if host: wait for SyncRequests, respond with SyncOffer + SyncBatch[]

host failure (no SyncComplete within 10s):
  → recalculate host from remaining peers
  → restart with new host
  → deduplicate by message.id

Yjs channel doc syncs independently
  → no coordination with message sync needed
  → reactions/edits/deletes always eventually consistent
```

---

## File Transfer

```txt
send:
  1. wtClient.seed(file, { announce: [] }) → infoHash
  2. store Attachment { infoHash, status: "seeding" }
  3. if size < 5MB: store data: ArrayBuffer
  4. broadcast WireMessage with FileMeta { infoHash, filename, size, mimeType }

receive:
  1. store Attachment { infoHash, status: "pending" }
  2. wtClient.add(infoHash, { announce: [] }) → status: "downloading"
  3. torrent.on("done") → blob → blobURL → status: "complete"
  4. if size < 5MB: store data: ArrayBuffer in Attachment

startup:
  re-seed all attachments where status = "complete" and data exists

blobURL lifecycle:
  created:  torrent done
  revoked:  message scrolls out of virtual list OR beforeunload
```

---

## Identity Key

### Key Derivation

```txt
password
  → PBKDF2(password, salt, 100000, SHA-256) → AES-256-GCM key
  → decrypt mnemonic from IndexedDB

mnemonic (BIP39, 12 words)
  → PBKDF2 seed (SLIP-0010)
  → ed25519 root keypair
  → did:key = "did:key:" + base58btc(0xed01 + publicKey)
```

### Message Signature

```typescript
// canonical string — excludes timestamp (untrusted wall clock)
const canonical = [msg.id, msg.senderId, msg.lamport, msg.content].join(":");
const sig = hex(await ed25519.sign(utf8(canonical), privateKey));

// verify
const pubkey = pubkeyFromDid(msg.senderDid); // decode did:key
const valid = await ed25519.verify(unhex(msg.sig), utf8(canonical), pubkey);
```

### UCAN

```typescript
// non-expiring — no exp field
// revocation via Yjs revocations map

capabilities:
  message/send    message/delete  message/edit    message/pin
  member/kick     member/ban      member/invite
  channel/create  channel/delete  channel/edit
  roles/assign    server/edit
  voice/speak     voice/deafen    voice/kick
```

---

## Room Codes

```txt
text/voice channel:  slug + "-" + 4 char hex   e.g. "general-4f2a"
DM:                  sha256(sort([didA, didB]).join(':'))[0..12]  hex
```

---

## DataChannel Limits

```txt
max message size:    64 KB
SyncBatch:           max 20 messages per batch
WireMessage:         reactions/edits/deletes NOT included — Yjs only
```

---

## Voice/Video

```txt
1-on-1:   SimplePeer direct, no SFU
group:    mediasoup SFU, ≤15 participants
signaling: mediasoup-client with SimplePeerHandler (custom handler)
          reuses existing data channel, no extra WebSocket
UI:       Participant { id, stream: MediaStream, audioEnabled, videoEnabled }
          same interface regardless of SimplePeer or mediasoup source
```

---

## Server Privacy Model

```txt
server knows:
  ephemeral session ID per connection (rotates on every reconnect)
  which room a session is in

server never knows:
  did:key or real identity
  UCAN tokens or capabilities
  message content (full mesh rooms)
  Yjs document content

UCAN verification: peer-to-peer over SimplePeer data channel
Yjs sync:          peer-to-peer via SimplePeer
```
