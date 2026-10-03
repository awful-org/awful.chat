import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// Second review round: cases the fixes still left open. Same harness as
// dm-requests.review.test.ts (real transport, DM and storage modules on
// fake-indexeddb; only the libp2p class and the media stack are stand-ins).
const s = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null, isUnlocked: true },
  handlers: new Map<string, Function>(),
  hooks: {} as { verified?: Function; upgraded?: Function },
  joined: new Set<string>(),
  bound: new Set<string>(),
  joins: 0,
  roomPeers: new Map<string, Set<string>>(),
  connected: [] as string[],
  sent: [] as { peer: string; room: string; data: Uint8Array }[],
  deposits: [] as { to: string; envelope: Uint8Array; kind?: string }[],
  announce: vi.fn(),
  introduce: vi.fn(async (_peer: string, _did?: string) => true),
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
// Counted, not replaced: each call decrypts every DM record.
vi.mock("$lib/rooms.svelte", async (original) => {
  const real = await original<typeof import("$lib/rooms.svelte")>();
  return { ...real, refreshDmRooms: vi.fn(real.refreshDmRooms) };
});

import {
  _peerIdToDid,
  connect,
  deliverMailboxBatch,
  deliverMailboxDm,
  disconnectTransport,
  transportState,
} from "./transport.svelte";
import {
  MAX_DMS_JOINED_FOR_THEM,
  MAX_UNSOLICITED_DMS,
  SAVED_DMS_JOINED_AT_CONNECT,
  ensureDmRoomForPeer,
  openDmConversation,
} from "./dm.svelte";
import {
  getDMRooms,
  getLastMessage,
  getMessage,
  getRoom,
  putMessage,
  putRoom,
  wipeLocalDatabase,
  type DMRoom,
} from "$lib/storage";
import { encode } from "$lib/utils";
import { MessageType, messageToWire, type Message, type WireChatMessage } from "$lib/types/message";
import { canonicalContentV3 } from "$lib/messaging";
import { refreshDmRooms, roomsStore } from "$lib/rooms.svelte";
import { encodeDmChatEnvelope, hashDmRoomCode, type DmPayload } from "./dm-codec";
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
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
  notifyIdentityLock();
  await wipeLocalDatabase();
  vi.clearAllMocks();
  s.session = identity();
  s.identity.did = s.session.did;
  s.joined.clear(); s.bound.clear(); s.roomPeers.clear();
  s.joins = 0;
  s.connected = []; s.sent = []; s.deposits = [];
  roomsStore.dmRooms = [];
  _peerIdToDid.clear();
  Object.assign(transportState, {
    roomCode: null, chatMode: "room", activeDmPeerId: null, roomUsers: [], messages: [],
    relayConnected: false,
  });
});

// A first contact is admitted (and charged to MAX_UNSOLICITED_DMS) before
// its rows are stored. When every row is then refused, dropDmIfEmpty takes
// the conversation away again - but the charge stayed. A stranger who knows
// only our DID could therefore spend the whole session's budget with junk
// that leaves nothing behind, and from then on every first contact from
// anyone who is not a contact (strangers AND room-mates) was held back.
describe("a dropped first contact still spends the session's budget", () => {
  /** A mailbox batch from `as`, one row it signed: a plugin card whose payload is not JSON. */
  async function junkBatch(as: UnlockedSession): Promise<Uint8Array> {
    const room = await code(as.did);
    const row = signedWire(as, room, { type: MessageType.PluginCard, content: "not json" });
    return encode({ type: MessageType.SyncBatch, roomCode: room, messages: [row], batchIndex: 0, totalBatches: 1 });
  }

  it("control: one junk batch fewer than the budget leaves the honest stranger's DM through", async () => {
    const attacker = identity();
    for (let i = 0; i < MAX_UNSOLICITED_DMS - 1; i++) {
      await deliverMailboxBatch(attacker.did, await junkBatch(attacker));
    }
    expect(await getDMRooms()).toEqual([]);
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);

  it("a DID-only stranger's refused batches leave nothing, yet lock every later first contact out", async () => {
    const attacker = identity();
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      // Acked away like any junk (resolves), and leaves no conversation.
      await deliverMailboxBatch(attacker.did, await junkBatch(attacker));
    }
    expect(await getDMRooms()).toEqual([]);

    // An honest stranger's first DM, through the mailbox.
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);

  it("same for a member of a room we share", async () => {
    const attacker = identity();
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      await deliverMailboxBatch(attacker.did, await junkBatch(attacker));
    }
    const mate = identity().did;
    await putRoom({ roomCode: "SHAREDROOM1", type: "text", name: "shared", lastSeenLamport: 0,
      createdAt: Date.now(), participants: [mate], participantLastSeen: {} });
    await deliverMailboxDm(mate, chat(mate, "hey, from the room"));
    expect((await getLastMessage(await code(mate)))?.content).toBe("hey, from the room");
  }, 60_000);

  // One identity's batches are one conversation, which the budget counts
  // once; the attack mints an identity per batch.
  it("however many identities the junk comes from", async () => {
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      const attacker = identity();
      await deliverMailboxBatch(attacker.did, await junkBatch(attacker));
    }
    expect(await getDMRooms()).toEqual([]);
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);

  // The batch handler throws on a row that is not an object: with a good
  // row beside it, the conversation was made for the good one and then kept
  // empty - charged, and its blob kept in the mailbox for every collect.
  it("nor with batches whose one good row comes with one the handler cannot look at", async () => {
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      const attacker = identity();
      const room = await code(attacker.did);
      const blob = encode({ type: MessageType.SyncBatch, roomCode: room,
        messages: [signedWire(attacker, room), null], batchIndex: 0, totalBatches: 1 });
      // Junk, answered as junk: acked away, nothing made or joined for it.
      await expect(deliverMailboxBatch(attacker.did, blob)).resolves.toBeUndefined();
    }
    expect(await getDMRooms()).toEqual([]);
    expect(s.joins).toBe(0);
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);

  it("nor with first contacts that could not be joined at all", async () => {
    // Every conversation binding the transport has is taken.
    for (let i = 0; i < 512; i++) s.bound.add(`dm-taken-${i}`);
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      const stranger = identity().did;
      // Kept in the mailbox for a later collect, nothing made.
      await expect(deliverMailboxDm(stranger, chat(stranger))).rejects.toThrow();
    }
    expect(await getDMRooms()).toEqual([]);
    s.bound.clear();
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);
});

// A mailbox batch for a DM that cannot be joined - others hold every join
// they may - stays in the mailbox and comes back on every collect. Each time
// it re-read every DM record (and, for a new conversation, made it and took
// it away again) before finding it could not be joined.
describe("a mailbox batch for a DM that cannot be joined", () => {
  /** A DM stored earlier, accepted, with one message from them in it. */
  async function savedDm(did: string): Promise<string> {
    const roomCode = await code(did);
    await putRoom({ roomCode, type: "dm", name: "", lastSeenLamport: 0, createdAt: 1, participants: [did],
      participantLastSeen: {}, participantDid: did, request: false } as DMRoom);
    await putMessage({ id: newMessageId(did), roomCode, senderId: did, senderName: "", timestamp: 1, lamport: 1,
      type: MessageType.Text, content: "earlier", attachments: [], status: "delivered" });
    return roomCode;
  }
  const batchFrom = (as: UnlockedSession, room: string, lamport = 1) => {
    const card = signedWire(as, room, { lamport });
    return { card, blob: encode({ type: MessageType.SyncBatch, roomCode: room, messages: [card], batchIndex: 0, totalBatches: 1 }) };
  };

  it("is kept without re-reading the DM list or making anything", async () => {
    for (let i = 0; i < MAX_DMS_JOINED_FOR_THEM; i++) {
      const did = identity().did;
      await savedDm(did);
      await ensureDmRoomForPeer(did, undefined, { unsolicited: true });
    }
    const joins = s.joins;
    const late = identity();
    const { card, blob } = batchFrom(late, await savedDm(late.did), 2);
    vi.mocked(refreshDmRooms).mockClear();
    await expect(deliverMailboxBatch(late.did, blob)).rejects.toThrow("Conversation not joined");
    expect(await getMessage(card.id)).toBeUndefined();

    const stranger = identity();
    const strangerRoom = await code(stranger.did);
    await expect(deliverMailboxBatch(stranger.did, batchFrom(stranger, strangerRoom).blob))
      .rejects.toThrow("Conversation not joined");
    expect(await getRoom(strangerRoom)).toBeUndefined();
    expect(refreshDmRooms).not.toHaveBeenCalled();
    expect(s.joins).toBe(joins);
  }, 60_000);

  // Each collect admitted such a first contact again, charged it and took
  // it away: with no attacker at all, the session's new conversations ran
  // out one kept blob at a time.
  it("holds no first contact back, however many such blobs come back", async () => {
    for (let i = 0; i < MAX_DMS_JOINED_FOR_THEM; i++) {
      const did = identity().did;
      await savedDm(did);
      await ensureDmRoomForPeer(did, undefined, { unsolicited: true });
    }
    for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
      const sender = identity();
      await expect(deliverMailboxBatch(sender.did, batchFrom(sender, await code(sender.did)).blob))
        .rejects.toThrow("Conversation not joined");
    }
    // Stored, if not joined: it carries on through the mailbox.
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }, 60_000);

  it("and taken into one that can be, still without re-reading the DM list", async () => {
    const peer = identity();
    const room = await savedDm(peer.did);
    // Listed, as a saved DM is once the list has loaded: one the list does
    // not have yet is re-read once to put it there (dm-list-mailbox.test.ts).
    roomsStore.dmRooms = [{ roomCode: room, participantDid: peer.did } as (typeof roomsStore.dmRooms)[number]];
    const { card, blob } = batchFrom(peer, room, 2);
    vi.mocked(refreshDmRooms).mockClear();
    await deliverMailboxBatch(peer.did, blob);
    expect(await getMessage(card.id)).toBeDefined();
    expect(refreshDmRooms).not.toHaveBeenCalled();
  });
});

// 6034075: "Connecting now joins any DM the user opened or wrote in this
// session on the user's account". joinSavedDms skipped every DM with nothing
// in it before it looked at whether the user opened it.
describe("a DM the user opened comes back joined after another tab held the node", () => {
  it("also when nothing has been said in it yet", async () => {
    const friend = identity().did;
    const room = await code(friend);
    expect(await openDmConversation(friend)).toBe(true);
    expect(s.joined.has(room)).toBe(true);
    // Another tab takes the node and hands it back: every conversation is left.
    s.joined.clear();
    transportState.relayConnected = false;
    await connect();
    await settled();
    await settled();
    expect(await getRoom(room)).toBeDefined();
    expect(s.joined.has(room)).toBe(true);
    disconnectTransport();
  }, 30_000);
});

// joinSavedDms ranked by lastSeenLamport, described as "the ones the user
// read last first". lastSeenLamport is a per-conversation logical counter
// (and an epoch-millisecond value on DMs from before the logical clock), so
// across conversations it measured history length, not when anything was
// read.
describe("connecting joins the saved DMs the user read last", () => {
  async function savedDm(did: string, lastSeenLamport: number, at: number, extra: Partial<DMRoom> = {}): Promise<string> {
    const roomCode = await code(did);
    await putRoom({ roomCode, type: "dm", name: "", lastSeenLamport, createdAt: at, participants: [did],
      participantLastSeen: {}, participantDid: did, request: false, ...extra } as DMRoom);
    await putMessage({ id: newMessageId(did), roomCode, senderId: did, senderName: "", timestamp: at,
      lamport: lastSeenLamport, type: MessageType.Text, content: "earlier", attachments: [], status: "read" });
    return roomCode;
  }

  async function joinedAtConnect(expected = SAVED_DMS_JOINED_AT_CONNECT): Promise<void> {
    s.bound.clear(); s.joined.clear();
    await connect();
    await vi.waitFor(() => expect(s.bound.size).toBe(expected), { timeout: 20_000 });
    await settled();
    expect(s.bound.size).toBe(expected);
  }

  const DAY = 24 * 3600_000;

  it("a conversation read a minute ago is joined ahead of ones last read a year ago", async () => {
    const yearAgo = Date.now() - 365 * DAY;
    // Long or pre-logical-clock histories, untouched for a year.
    for (let i = 0; i < SAVED_DMS_JOINED_AT_CONNECT; i++) {
      await savedDm(identity().did, 1_700_000_000_000 + i, yearAgo + i);
    }
    // Started last week, three messages, read a minute ago.
    const recent = await savedDm(identity().did, 3, Date.now() - 7 * DAY);
    await joinedAtConnect();
    expect(s.bound.has(recent)).toBe(true);
    disconnectTransport();
  }, 60_000);

  it("by when it was read, whatever the counters or the creation dates say", async () => {
    const yearAgo = Date.now() - 365 * DAY;
    for (let i = 0; i < SAVED_DMS_JOINED_AT_CONNECT; i++) {
      await savedDm(identity().did, 1_700_000_000_000 + i, yearAgo - 30 * DAY + i, { seenAt: yearAgo + i });
    }
    // Older than all of them, three messages long, read a minute ago.
    const recent = await savedDm(identity().did, 3, yearAgo - 365 * DAY, { seenAt: Date.now() - 60_000 });
    await joinedAtConnect();
    expect(s.bound.has(recent)).toBe(true);
    disconnectTransport();
  }, 60_000);

  it("never one the user has not opened ahead of one they have", async () => {
    const yearAgo = Date.now() - 365 * DAY;
    for (let i = 0; i < SAVED_DMS_JOINED_AT_CONNECT; i++) {
      await savedDm(identity().did, 5, yearAgo + i, { seenAt: yearAgo + i });
    }
    // Somebody else's, started a minute ago: newest of all, never opened.
    const unopened = await savedDm(identity().did, 0, Date.now() - 60_000);
    await joinedAtConnect();
    expect(s.bound.has(unopened)).toBe(false);
    disconnectTransport();
  }, 60_000);

  it("and a pinned one on the user's account, whatever it holds", async () => {
    for (let i = 0; i < SAVED_DMS_JOINED_AT_CONNECT; i++) {
      await savedDm(identity().did, 5, Date.now() - DAY + i, { seenAt: Date.now() - 60_000 + i });
    }
    // Pinned long ago, never opened since, nothing said in it.
    const did = identity().did;
    const pinned = await code(did);
    await putRoom({ roomCode: pinned, type: "dm", name: "", lastSeenLamport: 0, createdAt: 1, participants: [did],
      participantLastSeen: {}, participantDid: did, request: false, pinnedAt: 1 } as DMRoom);
    await joinedAtConnect(SAVED_DMS_JOINED_AT_CONNECT + 1);
    expect(s.bound.has(pinned)).toBe(true);
    disconnectTransport();
  }, 60_000);
});

// _solicited outlived the session: whoever the page had ever reached out to
// stayed "known", and the user's own at connect, across locks.
describe("whom the user reached out to is forgotten when the identity locks", () => {
  it("a DM opened before a lock is not the user's after it", async () => {
    const friend = identity().did;
    const room = await code(friend);
    expect(await openDmConversation(friend)).toBe(true);
    // Locked, and unlocked again: a session of its own.
    notifyIdentityLock();
    s.session = { ...s.session! };
    s.joined.clear(); s.bound.clear();
    transportState.relayConnected = false;
    await connect();
    await settled();
    await settled();
    // Nothing in it, and nobody opened it this session: left out.
    expect(await getRoom(room)).toBeDefined();
    expect(s.joined.has(room)).toBe(false);
    disconnectTransport();
  }, 30_000);
});

// A first contact's text makes its conversation, then stores the message
// unless getMessage already holds its id. The check made before the
// conversation (messageClearFieldsByIds) skips the empty id, which
// getMessage reads like any other; and two copies of one legacy (unbound)
// id at once both pass it. Either way the conversation kept nothing, was
// never undone, and stayed charged to MAX_UNSOLICITED_DMS.
describe("a first-contact text that stores nothing spends nothing", () => {
  /** A clock that moves past REQUEST_SETTLE_MS between steps: empty requests stop holding a slot. */
  function steppedClock() {
    let now = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    return { step: () => { now += 61_000; }, restore: () => spy.mockRestore() };
  }

  async function honestStrangerGetsThrough(): Promise<void> {
    const honest = identity().did;
    await deliverMailboxDm(honest, chat(honest, "hi, we met at the meetup"));
    expect((await getLastMessage(await code(honest)))?.content).toBe("hi, we met at the meetup");
  }

  it("however many DID-only strangers send a text under the empty id", async () => {
    const clock = steppedClock();
    try {
      for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
        clock.step();
        const stranger = identity().did;
        await deliverMailboxDm(stranger, chat(stranger, "hi", { id: "" }));
      }
      clock.step();
      await honestStrangerGetsThrough();
    } finally {
      clock.restore();
    }
  }, 60_000);

  it("nor batches under the empty id, whose one row moved from conversation to conversation", async () => {
    const clock = steppedClock();
    try {
      for (let i = 0; i < MAX_UNSOLICITED_DMS; i++) {
        clock.step();
        const stranger = identity();
        const room = await code(stranger.did);
        await deliverMailboxBatch(stranger.did, encode({ type: MessageType.SyncBatch, roomCode: room,
          messages: [signedWire(stranger, room, { id: "" })], batchIndex: 0, totalBatches: 1 }));
      }
      // No conversation was left holding nothing.
      for (const room of await getDMRooms()) expect(await getLastMessage(room.roomCode)).toBeDefined();
      clock.step();
      await honestStrangerGetsThrough();
    } finally {
      clock.restore();
    }
  }, 60_000);

  it("nor introduced strangers sending one legacy id at once", async () => {
    const introduce = (device: string, did: string) => s.hooks.verified!(device, did, "r2_unused", false);
    const clock = steppedClock();
    try {
      // Sixteen a minute: as many introductions as strangers may join.
      for (let burst = 0; burst < 4; burst++) {
        clock.step();
        const shared = crypto.randomUUID();
        const strangers = [];
        for (let i = 0; i < 16; i++) {
          const who = identity();
          const device = `12D3-burst${burst}-${i}`;
          await introduce(device, who.did);
          const room = await code(who.did);
          s.roomPeers.set(room, new Set([device]));
          strangers.push({ who, device, room });
        }
        for (const { who, device, room } of strangers) {
          s.handlers.get("message")!(device, encodeDmChatEnvelope(chat(who.did, "hi", { id: shared })), room);
        }
        for (let k = 0; k < 20; k++) await settled();
      }
      clock.step();
      await honestStrangerGetsThrough();
    } finally {
      clock.restore();
    }
  }, 60_000);
});
