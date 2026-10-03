import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// What a stranger, or a member of a room we share, can make us spend: the
// cases the review of the message-request work found still open. The
// harness is dm-requests.integration.test.ts's (real transport, DM and
// storage modules on fake-indexeddb), plus counters on the transport's
// join/forget and on signature verification.
const s = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null, isUnlocked: true },
  handlers: new Map<string, Function>(),
  hooks: {} as { verified?: Function; upgraded?: Function },
  joined: new Set<string>(),
  bound: new Set<string>(),
  joins: 0,
  forgets: 0,
  roomPeers: new Map<string, Set<string>>(),
  connected: [] as string[],
  sent: [] as { peer: string; room: string; data: Uint8Array }[],
  deposits: [] as { to: string; envelope: Uint8Array; kind?: string }[],
  announce: vi.fn(),
  introduce: vi.fn(async (_peer: string, _did?: string) => true),
  verifyTimes: [] as number[],
}));

vi.mock("$lib/identity/identity", async (original) => ({
  ...(await original<typeof import("$lib/identity/identity")>()),
  requireSession: () => {
    if (!s.session) throw new Error("Locked");
    return s.session;
  },
  isUnlocked: () => !!s.session,
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: s.identity }));
vi.mock("$lib/messaging", async (original) => {
  const real = await original<typeof import("$lib/messaging")>();
  return {
    ...real,
    verifySignature: (...args: Parameters<typeof real.verifySignature>) => {
      s.verifyTimes.push(performance.now());
      return real.verifySignature(...args);
    },
  };
});
vi.mock("./libp2p/transport", () => ({
  LibP2PTransport: class {
    on(event: string, fn: Function) { s.handlers.set(event, fn); }
    setDmIntroduction(_identity: unknown, verified: Function, upgraded?: Function) {
      s.hooks.verified = verified;
      s.hooks.upgraded = upgraded;
    }
    selfId() { return "12D3-self"; }
    rooms() { return [...s.joined]; }
    peers() { return [...s.connected]; }
    peersInRoom(room: string) { return [...(s.roomPeers.get(room) ?? [])]; }
    isRoomPeer(room: string, peer: string) { return !!s.roomPeers.get(room)?.has(peer); }
    isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
    joinSecureConversation(localId: string) {
      if (!s.bound.has(localId) && s.bound.size >= 512) throw new Error("Conversation binding limit");
      s.joins += 1;
      s.bound.add(localId);
      s.joined.add(localId);
      return "rd2_disc";
    }
    joinSecureRoom() { return "rd2_disc"; }
    joinRoom(room: string) { s.joined.add(room); }
    holdDmLobby() {}
    forgetConversation(localId: string) {
      s.forgets += 1;
      s.bound.delete(localId);
      s.joined.delete(localId);
    }
    leaveRoom(room: string) { s.joined.delete(room); }
    introduceDm(peer: string, did?: string) { return s.introduce(peer, did); }
    async sendRoom(peer: string, room: string, data: Uint8Array) {
      s.sent.push({ peer, room, data });
      return true;
    }
    async send() { return true; }
    async broadcast() {}
    async disconnect() {}
    async connect() {}
    dialNow() {}
  },
}));
vi.mock("./ice-server-list", () => ({ refreshTurnCredentials: async () => {} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class { setCallPeers() {} activePeers() { return []; } } }));
vi.mock("./mediasoup", () => ({
  MediasoupVideo: class {
    setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {} retryDeferredProducers() {}
  },
}));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {}, _sendWatchPresence() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn(), _sendCallPresence() {}, _sendCallState() {} }));
vi.mock("./file/webtorrent", () => ({
  WebTorrentFileTransport: class {
    on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers() {} onPeerDisconnect() {}
    onPeerConnect() {} registerSeeder() {} ensureDownload() {}
  },
}));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn(), acquireNodeLock: async () => {} }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null, getManifest: () => undefined }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));
vi.mock("../announce", () => ({ announceMessage: s.announce }));
vi.mock("$lib/sounds", () => ({ playPeerJoinSound() {}, playPeerLeaveSound() {} }));
vi.mock("./mailbox.svelte", () => ({
  mailboxPrefs: { enabled: true },
  collectMailbox: async () => {},
  depositDmToMailbox: async (to: string, envelope: Uint8Array, kind?: string) => {
    s.deposits.push({ to, envelope, kind });
    return "sent";
  },
}));

import {
  _peerIdToDid,
  connect,
  deliverMailboxDm,
  disconnectTransport,
  transportState,
} from "./transport.svelte";
import {
  INTRODUCTION_JOINS_PER_MINUTE,
  MAX_UNSOLICITED_DMS,
  SAVED_DMS_JOINED_AT_CONNECT,
  ensureDmRoomForPeer,
} from "./dm.svelte";
import { getDMRooms, getMessage, getRoom, putRoom, wipeLocalDatabase } from "$lib/storage";
import { encode } from "$lib/utils";
import { MessageType, messageToWire, type Message, type WireChatMessage } from "$lib/types/message";
import { canonicalContentV3 } from "$lib/messaging";
import { roomsStore } from "$lib/rooms.svelte";
import { hashDmRoomCode, type DmPayload } from "./dm-codec";
import { newMessageId } from "$lib/message-id";
import { notifyIdentityLock } from "$lib/identity/lock-events";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function signedWire(as: UnlockedSession, room: string, extra: Partial<Message> = {}): WireChatMessage {
  const msg: Message = {
    id: newMessageId(as.did), roomCode: room, senderId: as.did, senderName: "Them",
    timestamp: Date.now(), lamport: 1, type: MessageType.Text, content: "hi", attachments: [],
    ...extra,
  };
  const sig = ed25519.sign(new TextEncoder().encode(canonicalContentV3(msg)), as.privateKey);
  return messageToWire({ ...msg, senderDid: as.did, sig: hex(sig), sigV: 3 });
}

function chat(from: string, text = "hello", extra: Partial<DmPayload> = {}): DmPayload {
  return { id: newMessageId(from), text, ts: Date.now(), lamport: 1, ...extra };
}

const code = (did: string) => hashDmRoomCode(s.session!.did, did);
const introduce = (device: string, did: string, pqPending = false) =>
  s.hooks.verified!(device, did, "r2_unused", pqPending);
const receive = (peer: string, frame: unknown, room: string | null) =>
  s.handlers.get("message")!(peer, frame instanceof Uint8Array ? frame : encode(frame), room);
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
  // Each test is a session of its own, and a session ends with a lock: what
  // the last one joined for others is let go of, as in the app.
  notifyIdentityLock();
  await wipeLocalDatabase();
  vi.clearAllMocks();
  s.session = identity();
  s.identity.did = s.session.did;
  s.joined.clear(); s.bound.clear(); s.roomPeers.clear();
  s.joins = 0; s.forgets = 0; s.verifyTimes = [];
  s.connected = []; s.sent = []; s.deposits = [];
  roomsStore.dmRooms = [];
  _peerIdToDid.clear();
  Object.assign(transportState, {
    roomCode: null, chatMode: "room", activeDmPeerId: null, roomUsers: [], messages: [],
  });
});

// _handleSyncBatch refuses a batch of more than BATCH_SIZE * 4 = 80 rows
// before verifying anything (one 4 MB frame of ~10k rows froze the tab for
// ~19 s). The first-contact check in front of it has to keep the same cap.
describe("a first-contact live batch is held to the batch row cap", () => {
  const ROWS = 2000;
  const CAP = 80;
  const batchOf = (room: string, rows: WireChatMessage[]) => ({
    type: MessageType.SyncBatch, roomCode: room, messages: rows, batchIndex: 0, totalBatches: 1, live: true,
  });

  it("control: an existing DM's oversized live batch is refused before any signature check", async () => {
    const peer = identity();
    const room = await code(peer.did);
    _peerIdToDid.set("12D3-peer", peer.did);
    await ensureDmRoomForPeer(peer.did);
    s.roomPeers.set(room, new Set(["12D3-peer"]));
    const row = signedWire(peer, room);
    s.verifyTimes = [];
    receive("12D3-peer", batchOf(room, Array.from({ length: ROWS }, () => row)), room);
    await settled();
    expect(s.verifyTimes.length).toBe(0);
  });

  it("a stranger known only by peerId cannot make us verify more than the cap", async () => {
    const stranger = identity();
    const room = await code(stranger.did);
    // The introduction alone joins the DM (provisionally).
    await introduce("12D3-stranger", stranger.did);
    s.roomPeers.set(room, new Set(["12D3-stranger"]));
    // One signature, repeated: free for the sender, a full verify each for us.
    const row = signedWire(stranger, room);
    s.verifyTimes = [];
    receive("12D3-stranger", batchOf(room, Array.from({ length: ROWS }, () => row)), room);
    // Wait for the batch handler to reach verification, if it ever does (a
    // fixed build may refuse the frame before verifying anything at all).
    await vi.waitFor(() => expect(s.verifyTimes.length).toBeGreaterThan(0), { timeout: 3_000 }).catch(() => {});
    await settled();
    expect(s.verifyTimes.length).toBeLessThanOrEqual(CAP);
    expect(await getRoom(room)).toBeUndefined();
  }, 60_000);

  it("an honest first contact costs one check more than its rows, not twice as many", async () => {
    const stranger = identity();
    const room = await code(stranger.did);
    await introduce("12D3-stranger", stranger.did);
    s.roomPeers.set(room, new Set(["12D3-stranger"]));
    const rows = [1, 2, 3].map((lamport) => signedWire(stranger, room, { lamport }));
    s.verifyTimes = [];
    receive("12D3-stranger", batchOf(room, rows), room);
    await vi.waitFor(async () => expect(await getMessage(rows[2].id)).toBeDefined());
    expect(await getRoom(room)).toMatchObject({ request: true });
    expect(s.verifyTimes.length).toBe(rows.length + 1);
  });
});

// An empty DM an older build stored is joined the same bounded way as a new
// one (at most 32, oldest out). The bound used to hold only while the DM was
// not joined: a second introduction found it joined, went the ordinary way,
// and the join became permanent.
describe("an empty DM an older build stored stays in the bounded join", () => {
  it("however many times its identity introduces itself", async () => {
    const minted = Array.from({ length: 100 }, () => identity().did);
    for (const did of minted) {
      await putRoom({ roomCode: await code(did), type: "dm", name: "", lastSeenLamport: 0, createdAt: 1,
        participants: [did], participantLastSeen: {}, participantDid: did, request: false } as never);
    }
    for (const [i, did] of minted.entries()) {
      await introduce(`12D3-m-${i}`, did);
      await introduce(`12D3-m-${i}`, did);
    }
    expect(s.bound.size).toBeLessThanOrEqual(32);
  }, 60_000);
});

// MAX_UNSOLICITED_DMS resets with every unlock, and the DMs it admits for
// identities a room member attested are stored as accepted DMs holding a
// message. Every one of them was joined at each connect, so eight unlocks
// gave a room member's minted identities the transport's 512 bindings.
describe("what others have stored with us is not all joined at connect", () => {
  it("a room member's minted identities pile up across unlocks, but connecting joins a bounded few", async () => {
    const minted = Array.from({ length: 2 * MAX_UNSOLICITED_DMS }, () => identity().did);
    // A room we share whose member list holds them - which any member of a
    // protected room can arrange with a profile per identity.
    await putRoom({ roomCode: "SHAREDROOM1", type: "text", name: "shared", lastSeenLamport: 0,
      createdAt: Date.now(), participants: minted, participantLastSeen: {} });
    for (const did of minted.slice(0, MAX_UNSOLICITED_DMS)) await deliverMailboxDm(did, chat(did));
    // The next unlock of the same identity: a new session object.
    s.session = { ...s.session! };
    for (const did of minted.slice(MAX_UNSOLICITED_DMS)) await deliverMailboxDm(did, chat(did));
    const stored = await getDMRooms();
    expect(stored.length).toBe(2 * MAX_UNSOLICITED_DMS);
    expect(stored.every((r) => r.request !== true)).toBe(true);

    s.bound.clear(); s.joined.clear();
    await connect();
    await vi.waitFor(() => expect(s.bound.size).toBe(SAVED_DMS_JOINED_AT_CONNECT), { timeout: 20_000 });
    await settled();
    expect(s.bound.size).toBe(SAVED_DMS_JOINED_AT_CONNECT);
    disconnectTransport();
  }, 120_000);
});

// An introduction alone stores nothing and takes no request slot, so it was
// charged nothing: a stranger who knew our peerId made us join (a relay
// registration) and, past the 32 provisional joins, send one away (an
// unregistration, and the close of every room handshake in progress) per
// introduction, one minted identity each. Before introductions stopped
// making DMs, the request cap stopped strangers at 20 joins.
describe("joins for introductions from strangers are budgeted", () => {
  it("a burst from fresh identities joins only so many a minute, and sends nothing away", async () => {
    const N = 300;
    for (let i = 0; i < N; i++) await introduce(`12D3-s-${i}`, identity().did);
    expect(s.joins).toBe(INTRODUCTION_JOINS_PER_MINUTE);
    expect(s.forgets).toBe(0);
    expect(await getDMRooms()).toEqual([]);
    // A minute on, the budget is back - and only that much of it.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      for (let i = 0; i < N; i++) await introduce(`12D3-t-${i}`, identity().did);
    } finally {
      now.mockRestore();
    }
    expect(s.joins).toBe(2 * INTRODUCTION_JOINS_PER_MINUTE);
    expect(s.forgets).toBe(0);
  }, 60_000);
});
