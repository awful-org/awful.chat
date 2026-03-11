# Discord Alternative — Roadmap

## Stack Overview

```txt
Bun                → signaling server + message fan-out (SFU rooms)
SimplePeer         → p2p mesh (full mesh rooms, DMs, 1-on-1 calls)
WebTorrent v1      → file transfer (always p2p, no server involvement)
mediasoup          → voice/video SFU (always for group, p2p for 1-on-1)
Yjs + y-webrtc     → server state + channel mutations (reactions, edits, deletes)
UCAN               → authorization + capability delegation (non-expiring + revocation)
BIP39 + ed25519    → identity recovery + device sync
IndexedDB (idb)     → local persistence (messages, attachments, state)
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

## Phase 2 — Message Reliability + Offline Sync

**Goal:** messages never lost, offline peers catch up on reconnect

### 2.1 Data Layer Split

```txt
message log (append-only)
  → manual lamport + watermark sync
  → IndexedDB as source of truth
  → pagination friendly, unbounded history

channel mutations (concurrent writes)
  → Yjs per-channel doc
  → reactions, edits, deletes, pins, topic
  → CRDT handles concurrent writes automatically
  → no pending patch maps, no conflict logic
```

### 2.2 Room Code

```txt
format:   "general-4f2a"  (slug + 4 char hex suffix)
globally unique per server, chosen by channel creator
stored in Yjs channels map (phase 4)
DM roomCode = hash of sorted [didA, didB] — deterministic, no collision
```

### 2.3 Message Types

```typescript
enum MessageType {
  Text = "text",
  File = "file",
  System = "system", // "X joined", "X left"
  Reply = "reply",
  SyncRequest = "sync_request",
  SyncOffer = "sync_offer",
  SyncBatch = "sync_batch",
  SyncComplete = "sync_complete",
  SyncAck = "sync_ack",
  DeliveryAck = "delivery_ack", // DMs only
  ReadAck = "read_ack", // DMs only
}

// edit, delete, reaction are Yjs mutations — not wire message types
```

### 2.4 Core Message (IndexedDB — `storage.ts`)

```typescript
interface Message {
  id: string; // UUIDv7 — lexicographically sortable by time
  roomCode: string;
  senderId: string;
  senderName: string;
  senderDid?: string; // optional until phase 3
  sig?: string; // ed25519 signature — optional until phase 3
  timestamp: number; // wall clock, display only — never used for ordering
  lamport: number; // logical clock, causal ordering
  type: MessageType;
  content: string;
  meta?: FileMeta;
  attachments: string[]; // attachment IDs → refs to Attachment store
  replyTo?: ReplyTo;
  status?: MessageStatus; // DMs only
}

interface ReplyTo {
  id: string;
  senderName: string;
  content: string; // denormalized snapshot at send time, avoids joins
}

interface FileMeta {
  files: FileEntry[];
}

interface FileEntry {
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string; // WebTorrent handle
}

type MessageStatus =
  | "sending" // not yet confirmed sent
  | "sent" // delivered to data channel
  | "delivered" // recipient ACKd (DMs only)
  | "read"; // recipient read ACKd (DMs only)
```

### 2.5 Yjs Channel Doc — Mutations (`channelStore.ts`)

```typescript
// per channel — reactions, edits, deletes, pins, topic
// syncs p2p via y-webrtc, persisted via idb (Y.encodeStateAsUpdate)

const channelDoc = new Y.Doc();

// reactions: messageId → emoji → Y.Array<senderId>
// concurrent adds from multiple peers merge automatically (union)
const reactions = channelDoc.getMap<Y.Map<Y.Array<string>>>("reactions");

// edits: messageId → { content, editedAt }
// only the message owner can edit — enforced by UCAN message/edit capability
// last write wins via Yjs (owner editing their own message twice = fine)
const edits = channelDoc.getMap<{ content: string; editedAt: number }>("edits");

// deletes: messageId → { deletedAt, deletedBy } — tombstone
// soft delete, content replaced with "" in UI
const deletes = channelDoc.getMap<{ deletedAt: number; deletedBy: string }>(
  "deletes",
);

// pins: Y.Array<messageId>
const pins = channelDoc.getArray<string>("pins");

// topic: editable channel description
const topic = channelDoc.getText("topic");
```

**Reaction add/remove:**

```typescript
function addReaction(messageId: string, emoji: string, senderId: string) {
  const msgReactions = reactions.get(messageId) ?? new Y.Map();
  const emojiList = msgReactions.get(emoji) ?? new Y.Array();
  if (!emojiList.toArray().includes(senderId)) {
    emojiList.push([senderId]);
  }
  msgReactions.set(emoji, emojiList);
  reactions.set(messageId, msgReactions);
}

function removeReaction(messageId: string, emoji: string, senderId: string) {
  const emojiList = reactions.get(messageId)?.get(emoji);
  if (!emojiList) return;
  const idx = emojiList.toArray().indexOf(senderId);
  if (idx !== -1) emojiList.delete(idx, 1);
}
```

**Edit + Delete:**

```typescript
function editMessage(messageId: string, content: string) {
  // UCAN message/edit capability scoped to own messages only — verified before
  // calling
  // editedBy not stored — editor is always msg.senderId by definition
  edits.set(messageId, { content, editedAt: Date.now() });
}

function deleteMessage(messageId: string, deleterDid: string) {
  // UCAN verified before calling (phase 3)
  deletes.set(messageId, { deletedAt: Date.now(), deletedBy: deleterDid });
}
```

**UI rendering — merge IndexedDB message with Yjs mutations:**

```typescript
function resolveMessage(msg: Message): ResolvedMessage {
  const edit = edits.get(msg.id);
  const del = deletes.get(msg.id);
  const rxns = reactions.get(msg.id);
  return {
    ...msg,
    content: del ? "" : (edit?.content ?? msg.content),
    edited: !!edit && !del,
    deleted: !!del,
    reactions: rxns ? yMapToReactions(rxns) : {},
  };
}
```

### 2.6 Attachment (IndexedDB — `storage.ts`)

```typescript
interface Attachment {
  id: string; // UUIDv7
  roomCode: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string; // always present — permanent WebTorrent reference
  data?: ArrayBuffer; // only if size < 5MB, raw binary never base64
  blobURL?: string; // runtime only, never persisted
  status: AttachmentStatus;
  createdAt: number;
}

type AttachmentStatus =
  | "seeding" // we uploaded, we are the seeder
  | "pending" // infoHash received, not yet started
  | "downloading" // in progress
  | "complete" // done, blobURL available in memory
  | "failed";
```

**File storage strategy:**

```txt
< 5MB    → ArrayBuffer in IndexedDB + auto re-seed on app open
> 5MB    → infoHash only, re-download on demand
always   → infoHash persisted, re-download possible while someone seeds
browser closed → seeding stops (unavoidable)
server pinning → future, operator opt-in
```

**Auto re-seed on startup:**

```typescript
const cached = await db.attachments
  .where("status")
  .equals("complete")
  .and((a) => !!a.data)
  .toArray();
for (const a of cached) {
  wtClient.seed(new File([a.data!], a.filename), { announce: [] });
}
```

**blobURL cleanup:**

```typescript
// revoke when message scrolls out of virtual list
// or on beforeunload
URL.revokeObjectURL(attachment.blobURL);
attachment.blobURL = undefined;
```

### 2.7 Wire Message (DataChannel — `useDataChannel.ts`)

```typescript
// append-only messages over data channel
// reactions/edits/deletes handled by Yjs, not wire messages
interface WireMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderDid?: string;
  sig?: string; // ed25519 over canonical fields
  timestamp: number;
  lamport: number;
  type: MessageType;
  content: string;
  meta?: FileMeta;
  replyTo?: ReplyTo;
}

// DM receipts
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

**Max DataChannel message size:** 64KB.
`SyncBatch` max ~20 messages per batch.

### 2.8 Lamport Clock + Ordering

```typescript
// on send:    clock = clock + 1
// on receive: clock = max(local, received) + 1

function sortMessages(a: Message, b: Message): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.senderId.localeCompare(b.senderId); // deterministic tiebreaker
}
```

Wall clock (`timestamp`) display only, never for ordering.

### 2.9 Sync Protocol (DataChannel — `sync.ts`)

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
  messages: Message[]; // max 20 per batch
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

**Host selection (who will send the message history to the new peer):**

```typescript
// deterministic — lowest peerId wins, no coordination needed
function selectSyncHost(peers: string[], myId: string): string {
  return [...peers, myId].sort()[0];
}
```

**Host failure during sync:**

```txt
no SyncComplete within 10s timeout
  → recalculate host from remaining connected peers
  → restart SyncRequest to new host
  → deduplicate received messages by id
```

**Per-sender watermarks:**

```txt
prevents gaps when peers have different clock speeds
watermarks: { "peerA": 42, "peerB": 17 }
host sends only messages where msg.lamport > watermarks[msg.senderId]
```

### 2.10 Message Pagination

```typescript
const PAGE_SIZE = 50;

async function loadMessages(roomCode: string, beforeLamport?: number) {
  let query = db.messages.where("roomCode").equals(roomCode);
  if (beforeLamport !== undefined) {
    query = query.and((m) => m.lamport < beforeLamport);
  }
  return query
    .reverse()
    .sortBy("lamport")
    .then((r) => r.slice(0, PAGE_SIZE));
}
// virtual scrolling in UI — only render visible window
// load more on scroll up
```

---

## Phase 3 — Identity (BIP39 + UCAN)

**Goal:** persistent cryptographic identity, recoverable, portable

### 3.1 Key Generation

```txt
BIP39 mnemonic (12 words)
  → PBKDF2 seed (512 bits)
  → SLIP-0010 ed25519 derivation  ← not BIP32, unsafe for ed25519
  → root keypair

did:key = base58btc(ed25519 public key)
→ permanent identity, same across all devices
```

### 3.2 Mnemonic Storage (at rest)

```typescript
// encrypted with user password, AES-GCM
// key derived via PBKDF2 — separate from identity derivation

async function storeMnemonic(mnemonic: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAESKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(mnemonic),
  );
  await db.identity.put({ id: "mnemonic", salt, iv, encrypted });
}
// unlock: password → PBKDF2 → AES-GCM decrypt → SLIP-0010 → keypair
```

### 3.3 Message Signing

```typescript
// canonical = id + senderId + lamport + content (not timestamp)
const canonical = `${msg.id}:${msg.senderId}:${msg.lamport}:${msg.content}`;
const sig = await ed25519.sign(encode(canonical), privateKey);

// verify: extract pubkey from did:key, verify sig
const valid = await ed25519.verify(
  sig,
  encode(canonical),
  pubkeyFromDid(msg.senderDid),
);
```

### 3.4 Account Recovery

- 12-word mnemonic shown on first launch, confirmation required
- Entering mnemonic on any device → same keypair, same did:key
- Identity survives device loss

### 3.5 Device Sync (WhatsApp-style)

```txt
device A (existing)         device B (new)
      |                           |
      |  B shows QR code          |
      |  or user enters mnemonic  |
      |                           |
      | ←── SimplePeer p2p ─────→ |
      |     via signaling server  |
      |                           |
      | ←── Yjs doc sync ───────→ |
      |     contacts, servers,    |
      |     joined rooms          |
      |                           |
both stay online during sync
server never sees content
```

### 3.6 UCAN Authorization — Non-expiring + Revocation

```typescript
// no expiration field — tokens valid until explicitly revoked
const cap = await ucan.delegate({
  issuer: ownerDid,
  audience: adminDid,
  capabilities: [{ can: "roles/write", with: `server:${serverId}` }],
});

// verify: check revocations map first, then cryptographic verification
async function verifyUCAN(token: string): Promise<boolean> {
  const cid = await tokenToCID(token);
  if (serverDoc.getMap("revocations").has(cid)) return false;
  return ucan.verify(token);
}

// revoke: stored in Yjs, syncs to all peers automatically
function revokeUCAN(tokenCID: string, revokerDid: string) {
  serverDoc.getMap("revocations").set(tokenCID, {
    revokedAt: Date.now(),
    revokedBy: revokerDid,
  });
}
```

### 3.7 Server Privacy

```txt
server knows:       ephemeral session ID + room assignment only
server never knows: did:key, UCAN tokens, message content (full mesh)
UCAN verified:      peer-to-peer over SimplePeer data channel
```

---

## Phase 4 — Server State (Yjs)

**Goal:** roles, channels, members synced across all peers

### 4.1 Yjs Document Structure

```typescript
// per server
const serverDoc = new Y.Doc();
serverDoc.getMap("members"); // did:key → { name, avatar, joinedAt }
serverDoc.getMap("roles"); // did:key → roleId
serverDoc.getMap("rolesDef"); // roleId → { name, color, permissions[] }
serverDoc.getMap("channels"); // channelId → { name, type, roomCode, topic }
serverDoc.getMap("presence"); // did:key → { online, typing, lastSeen }
serverDoc.getMap("settings"); // name, icon, description
serverDoc.getMap("revocations"); // tokenCID → { revokedAt, revokedBy }

// per channel (see 2.5)
const channelDoc = new Y.Doc();
channelDoc.getMap("reactions");
channelDoc.getMap("edits");
channelDoc.getMap("deletes");
channelDoc.getArray("pins");
channelDoc.getText("topic");
```

### 4.2 Presence

```typescript
// presence map: did:key → { online, typing, lastSeen }
// syncs p2p via y-webrtc — server never sees it

// on app open / reconnect
presence.set(myDid, { online: true, typing: false, lastSeen: Date.now() });

// on app close / disconnect (best effort — may not fire if tab is killed)
presence.set(myDid, { online: false, lastSeen: Date.now() });

// typing indicator — set on keypress, auto-clear after 3s of inactivity
presence.set(myDid, { ...presence.get(myDid), typing: true });
typingTimer = setTimeout(() => {
  presence.set(myDid, { ...presence.get(myDid), typing: false });
}, 3000);

// other peers observe changes
presence.observe(() => {
  const p = presence.get(someDid);
  // p.online, p.typing, p.lastSeen available reactively
});
```

### 4.3 Yjs Sync Transport

Yjs is synced over the existing SimplePeer data channel — no `y-webrtc` dep needed.
Each peer connection already exists for chat; Yjs updates piggyback on the same
channel.

```typescript
// message kinds added to the data channel
// { kind: "yjs-update", doc: string, data: number[] }
// { kind: "yjs-sync",   doc: string, data: number[] }
// doc = "server:{serverId}" | "channel:{roomCode}"

// on peer connect — send our full state for each tracked doc
peer.on("connect", () => {
  for (const [id, doc] of yjsDocs) {
    const state = Y.encodeStateAsUpdate(doc);
    peer.send(
      JSON.stringify({ kind: "yjs-sync", doc: id, data: Array.from(state) }),
    );
  }
});

// on peer data
peer.on("data", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.kind === "yjs-update" || msg.kind === "yjs-sync") {
    const doc = yjsDocs.get(msg.doc);
    if (!doc) return;
    Y.applyUpdate(doc, new Uint8Array(msg.data));
    // if sync request, send back our state so they can merge
    if (msg.kind === "yjs-sync") {
      const state = Y.encodeStateAsUpdate(doc);
      peer.send(
        JSON.stringify({
          kind: "yjs-update",
          doc: msg.doc,
          data: Array.from(state),
        }),
      );
    }
  }
});

// on local Yjs change — broadcast to all connected peers
doc.on("update", (update: Uint8Array) => {
  const msg = JSON.stringify({
    kind: "yjs-update",
    doc: docId,
    data: Array.from(update),
  });
  for (const peer of connectedPeers) peer.send(msg);
});
```

idb persistence unchanged — load before connecting peers, save on every update:

```typescript
await loadYjsDoc(db, docId, doc); // restore local snapshot first
doc.on("update", () => saveYjsDoc(db, docId, doc)); // persist every change
```

### 4.4 UCAN-gated Writes

- All mutations wrapped with UCAN proof
- Peers verify capability + revocation before applying
- Invalid/revoked writes silently dropped
- `revocations` map writable by token issuer or higher authority only

---

## Phase 5 — DMs + Pending Messages

**Goal:** private 1-on-1 messages, always encrypted, reliable delivery even when
recipient is offline

### 5.1 DM Rooms

```txt
roomCode  = first 24 chars of sha256(sort([didA, didB]).join(':'))
            deterministic — both peers independently compute same roomCode
            unique per pair, no collision risk

transport = SimplePeer direct (full mesh, 2 peers)
encryption = X25519 ECDH
            ed25519 keys converted to curve25519 for key exchange
            each message encrypted with recipient's public key
            server never sees plaintext

Yjs presence (phase 4) is used to detect when recipient comes online
```

### 5.2 Opening a DM

```txt
both peers online:
  A opens DM with B
  → signaling server creates room for roomCode
  → SimplePeer connection established
  → messages flow directly peer-to-peer, encrypted

recipient offline:
  A opens DM with B (B is offline)
  → UI opens normally — A can type and send
  → messages saved to IndexedDB as PendingMessage { status: "pending" }
  → A sees outgoing messages immediately in UI (optimistic)
  → when B comes online → pending messages flushed → B ACKs → status updates
```

### 5.3 Message Delivery Flow

```txt
SEND (recipient online):
  1. encrypt message with B's public key
  2. send over SimplePeer data channel
  3. save to IndexedDB with status: "sent"
  4. B receives → saves to IndexedDB → sends DeliveryAck
  5. A receives DeliveryAck → updates status: "delivered"
  6. B scrolls past message → sends ReadAck
  7. A receives ReadAck → updates status: "read"

SEND (recipient offline):
  1. encrypt message with B's public key
  2. save to IndexedDB as PendingMessage + Message { status: "pending" }
  3. watch Yjs presence map for B coming online
  4. B comes online → SimplePeer connection established
  5. flush all pending messages for B in order
  6. B receives → DeliveryAck → A clears from pending, updates status: "delivered"
  7. same ReadAck flow as above

RECEIVE (coming back online):
  1. connect → send SyncRequest with watermarks to A
  2. A detects gaps → delivers any pending messages
  3. DeliveryAck sent for each received message
```

### 5.4 Pending Message Store

```typescript
interface PendingMessage {
  id: string; // same id as the WireMessage
  to: string; // recipient did:key
  message: WireMessage; // already encrypted
  createdAt: number;
  attempts: number; // increment on each flush attempt
}

// watch presence for recipient
presence.observe(() => {
  const p = presence.get(recipientDid);
  if (p?.online) flushPendingMessages(recipientDid);
});

async function flushPendingMessages(recipientDid: string) {
  const pending = await db.getAll("pending", recipientDid); // index: byRecipient
  for (const p of pending) {
    try {
      sendToPeer(recipientDid, p.message);
      // remove from pending on ACK, not here
    } catch {
      await db.put("pending", { ...p, attempts: p.attempts + 1 });
    }
  }
}
```

---

## Phase 6 — Voice/Video (mediasoup)

**Goal:** voice and video calls

### 6.1

1-on-1 Calls → always SimplePeer direct, no SFU

### 6.2 Group Calls

(≤15) → mediasoup SFU, text+files remain p2p

### 6.3 UI Contract

```typescript
interface Participant {
  id: string;
  stream: MediaStream; // same interface regardless of transport
  audioEnabled: boolean;
  videoEnabled: boolean;
}
```

### 6.4 Transport

```typescript
// reuse SimplePeer for mediasoup signaling via custom handler
const device = new mediasoupClient.Device({
  handlerFactory: SimplePeerHandler,
});
```

---

## Phase 7 — Room Types + Permissions

**Goal:** full Discord-equivalent room model

### 7.1 Room Types

```txt
full mesh  → ≤30 members, p2p chat+files, SFU group voice
SFU room   → unlimited members, server fan-out chat, SFU group voice
DM         → 2 members, p2p, encrypted
```

### 7.2 Permission Model (UCAN)

```txt
server owner → admin → moderator → member → guest
all non-expiring, all revocable by issuer or higher

capabilities:
  message/send    message/delete  message/edit
  message/pin     member/kick     member/ban
  member/invite   channel/create  channel/delete
  channel/edit    roles/assign    server/edit
  voice/speak     voice/deafen    voice/kick
```

---

## Future / Post-Launch

- [ ] Server-side file pinning (operator opt-in, configurable quota)
- [ ] WebTorrent v2 when Vite compatibility fixed upstream
- [ ] mediasoup horizontal scaling
- [ ] E2E encryption for full mesh rooms (MLS protocol)
- [ ] Federation (Matrix-style)
- [ ] Mobile (Capacitor or React Native)
- [ ] libp2p if gossipsub needed for very large servers
- [ ] WebAuthn / biometrics as mnemonic unlock

---

## Dependencies Per Phase

| Phase | New Deps                                                         |
| ----- | ---------------------------------------------------------------- |
| 1 ✓   | simplepeer, webtorrent@1, bun                                    |
| 2     | idb, uuidv7, yjs, y-webrtc                                       |
| 3     | @noble/ed25519, @noble/hashes, @scure/bip39, @scure/bip32, ucans |
| 4     | (no new deps, extends phase 2 Yjs)                               |
| 5     | (no new deps)                                                    |
| 6     | mediasoup-client                                                 |
| 7     | (no new deps)                                                    |
