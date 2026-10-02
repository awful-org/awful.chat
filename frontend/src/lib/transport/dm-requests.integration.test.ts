import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// DMs and message requests end to end: the real transport, DM and storage
// modules (fake-indexeddb, real at-rest crypto); only the libp2p class, the
// media stack, the notification sink and the relay mailbox are stand-ins.
const s = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null, isUnlocked: true },
  handlers: new Map<string, Function>(),
  hooks: {} as { verified?: Function; upgraded?: Function },
  joined: new Set<string>(),
  bound: new Set<string>(),
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
vi.mock("$lib/storage", async (original) => {
  const real = await original<typeof import("$lib/storage")>();
  return { ...real, markOwnMessagesReadUpTo: vi.fn(real.markOwnMessagesReadUpTo) };
});
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
  deliverMailboxBatch,
  deliverMailboxDm,
  disconnectTransport,
  markSeen,
  transportState,
} from "./transport.svelte";
import {
  MAX_DM_REQUESTS,
  MAX_DMS_JOINED_FOR_THEM,
  MAX_UNSOLICITED_DMS,
  SAVED_DMS_JOINED_AT_CONNECT,
  acceptDmRequest,
  ensureDmRoomForPeer,
  isDmRequestRoom,
  openDmConversation,
  openDmPanel,
  closeDmPanel,
  sendDirectMessage,
} from "./dm.svelte";
import {
  getDB,
  getDMRooms,
  getLastMessage,
  getMessage,
  getRoom,
  getRoomParticipants,
  markOwnMessagesReadUpTo,
  putMessage,
  putPhonebookEntry,
  putRoom,
  wipeLocalDatabase,
  type DMRoom,
} from "$lib/storage";
import { notifyIdentityLock } from "$lib/identity/lock-events";
import { encode, decode } from "$lib/utils";
import { MessageType, messageToWire, type Message, type WireChatMessage } from "$lib/types/message";
import { canonicalContentV3 } from "$lib/messaging";
import { dmPqEncapsulate, dmPqRole } from "$lib/room-security/pq-dm";
import { derivePqKemKeypair } from "$lib/identity/pq-identity";
import { roomsStore } from "$lib/rooms.svelte";
import {
  encodeDmChatEnvelope,
  encodeDmReadEnvelope,
  hashDmRoomCode,
  parseDmEnvelope,
  type DmPayload,
} from "./dm-codec";
import { newMessageId } from "$lib/message-id";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A chat row signed by `as` for `room`, the way its own client would. */
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

beforeEach(async () => {
  await wipeLocalDatabase();
  vi.clearAllMocks();
  s.session = identity();
  s.identity.did = s.session.did;
  s.joined.clear(); s.bound.clear(); s.roomPeers.clear();
  s.connected = []; s.sent = []; s.deposits = [];
  roomsStore.dmRooms = [];
  _peerIdToDid.clear();
  Object.assign(transportState, {
    roomCode: null, chatMode: "room", activeDmPeerId: null, roomUsers: [], messages: [],
    inCall: false, callRoomCode: null, callPeerIds: new Set(), callPeerRooms: new Map(),
    transmissionViewers: new Map(),
  });
});

/** A frame from `peer` over `room`'s channel, as the transport hands it up. */
function receive(peer: string, frame: unknown, room: string | null): void {
  s.handlers.get("message")!(peer, frame instanceof Uint8Array ? frame : encode(frame), room);
}

/** Long enough for every storage round trip a frame sets off to finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A peer device bound to a fresh identity, in the DM with us on its channel. */
async function dmPeer(device = "12D3-peer") {
  const who = identity();
  _peerIdToDid.set(device, who.did);
  const code = await hashDmRoomCode(s.session!.did, who.did);
  s.roomPeers.set(code, new Set([device]));
  return { who, device, code };
}

/** Every receipt that left: deposited in a mailbox or sent over a channel. */
function receipts() {
  const out: { to: string; type: string; ids: string[] }[] = [];
  for (const d of s.deposits) {
    const e = parseDmEnvelope(d.envelope);
    if (e?.type === "ack") out.push({ to: d.to, type: "ack", ids: [e.messageId] });
    if (e?.type === "read") out.push({ to: d.to, type: "read", ids: e.messageIds });
  }
  for (const f of s.sent) {
    const e = parseDmEnvelope(f.data);
    if (e?.type === "ack") out.push({ to: f.peer, type: "ack", ids: [e.messageId] });
    if (e?.type === "read") out.push({ to: f.peer, type: "read", ids: e.messageIds });
  }
  return out;
}

/** Roster frames that left; DM envelopes are binary and are not one. */
const rosters = () =>
  s.sent.filter((f) => {
    try {
      return (decode(f.data) as { type?: string })?.type === MessageType.RoomUsersSync;
    } catch {
      return false;
    }
  });

it("files a stranger's mailbox DM as a request holding that message", async () => {
  const stranger = identity().did;
  await deliverMailboxDm(stranger, chat(stranger));
  const code = await hashDmRoomCode(s.session!.did, stranger);
  expect((await getRoom(code)) as { request?: boolean }).toMatchObject({ request: true });
  expect((await getLastMessage(code))?.content).toBe("hello");
});

describe("a DM never hands out a room's member list (G01.1)", () => {
  const roomMates = () => [identity().did, identity().did, identity().did];

  it("opening a DM leaves no room's roster on screen", async () => {
    const { who } = await dmPeer();
    Object.assign(transportState, { roomCode: "rd2_room", chatMode: "room", roomUsers: roomMates() });
    expect(await openDmConversation(who.did)).toBe(true);
    expect(transportState.chatMode).toBe("dm");
    expect(transportState.roomUsers).toEqual([]);
  });

  it("answers a join over a DM with nothing, whatever roster is on screen", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    Object.assign(transportState, { roomCode: code, chatMode: "dm", roomUsers: roomMates() });
    receive(device, { type: MessageType.JoinRoom, peerId: who.did }, code);
    s.handlers.get("roomPeers")!(code, [device]);
    await settled();
    expect(rosters()).toEqual([]);
  });

  it("takes no roster from a DM peer", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    Object.assign(transportState, { roomCode: code, chatMode: "dm", roomUsers: [] });
    const strangers = roomMates();
    receive(device, { type: MessageType.RoomUsersSync, participants: strangers, roomCode: code }, code);
    receive(device, { type: MessageType.JoinRoom, peerId: strangers[0] }, code);
    await settled();
    expect(transportState.roomUsers).toEqual([]);
    expect(await getRoomParticipants(code)).toEqual([who.did]);
  });

  it("still hands a room member that room's roster", async () => {
    const members = roomMates();
    s.joined.add("rd2_room");
    s.roomPeers.set("rd2_room", new Set(["12D3-member"]));
    Object.assign(transportState, { roomCode: "rd2_room", chatMode: "room", roomUsers: members });
    receive("12D3-member", { type: MessageType.JoinRoom, peerId: members[0] }, "rd2_room");
    await vi.waitFor(() => expect(rosters()).toHaveLength(1));
    const roster = decode(rosters()[0].data) as { participants: string[] };
    expect(roster.participants).toEqual(expect.arrayContaining(members));
  });
});

describe("only someone in our call is listed as watching it (G01.2)", () => {
  const SELF = "12D3-self";
  const viewersOf = (sharer: string) => [...(transportState.transmissionViewers.get(sharer) ?? [])];
  const presence = (peer: string, room: string, inCall = true) =>
    receive(peer, { type: MessageType.CallPresence, inCall, roomCode: room }, room);
  const watch = (peer: string, room: string, shares: string[]) =>
    receive(peer, { type: MessageType.WatchPresence, watching: shares.at(-1) ?? null, watchingAll: shares }, room);

  beforeEach(() => {
    s.joined.add("rd2_call");
    s.roomPeers.set("rd2_call", new Set(["12D3-member", "12D3-sharer"]));
    Object.assign(transportState, { inCall: true, callRoomCode: "rd2_call" });
  });

  it("refuses a DM peer whose call presence names the DM", async () => {
    const { who, device, code } = await dmPeer("12D3-stranger");
    await ensureDmRoomForPeer(who.did);
    presence(device, code);
    expect(transportState.callPeerRooms.get(device)).toBe(code);
    watch(device, code, [SELF, "12D3-sharer"]);
    expect(viewersOf(SELF)).toEqual([]);
    expect(viewersOf("12D3-sharer")).toEqual([]);
  });

  it("lists a member of our call, for shares in that call only", () => {
    presence("12D3-member", "rd2_call");
    presence("12D3-sharer", "rd2_call");
    watch("12D3-member", "rd2_call", [SELF, "12D3-sharer", "12D3-outsider"]);
    expect(viewersOf(SELF)).toEqual(["12D3-member"]);
    expect(viewersOf("12D3-sharer")).toEqual(["12D3-member"]);
    expect(viewersOf("12D3-outsider")).toEqual([]);
  });

  it("drops a viewer whose call presence ends or moves to another room", () => {
    s.joined.add("rd2_other");
    s.roomPeers.set("rd2_other", new Set(["12D3-member"]));
    presence("12D3-member", "rd2_call");
    watch("12D3-member", "rd2_call", [SELF]);
    expect(viewersOf(SELF)).toEqual(["12D3-member"]);
    presence("12D3-member", "rd2_call", false);
    expect(viewersOf(SELF)).toEqual([]);

    presence("12D3-member", "rd2_call");
    watch("12D3-member", "rd2_call", [SELF]);
    presence("12D3-member", "rd2_other");
    expect(viewersOf(SELF)).toEqual([]);
  });
});

describe("a message request makes no sound until accepted (S08.2)", () => {
  it("is known as a request from the moment it is stored", async () => {
    const { who, code } = await dmPeer("12D3-stranger");
    await ensureDmRoomForPeer(who.did, undefined, { unsolicited: true });
    expect(isDmRequestRoom(code)).toBe(true);
  });

  it("does not announce a stranger's bare message in a request just made", async () => {
    const { who, device, code } = await dmPeer("12D3-stranger");
    await ensureDmRoomForPeer(who.did, undefined, { unsolicited: true });
    roomsStore.dmRooms = [];
    const wire = signedWire(who, code);
    receive(device, wire, code);
    await vi.waitFor(async () => expect(await getMessage(wire.id)).toBeDefined());
    await settled();
    expect(s.announce).not.toHaveBeenCalled();
  });

  it("does not announce a live batch into a request either", async () => {
    const { who, device, code } = await dmPeer("12D3-stranger");
    await ensureDmRoomForPeer(who.did, undefined, { unsolicited: true });
    roomsStore.dmRooms = [];
    const wire = signedWire(who, code);
    receive(device, { type: MessageType.SyncBatch, roomCode: code, messages: [wire],
      batchIndex: 0, totalBatches: 1, live: true }, code);
    await vi.waitFor(async () => expect(await getMessage(wire.id)).toBeDefined());
    await settled();
    expect(s.announce).not.toHaveBeenCalled();
  });

  it("titles a DM by the name its sender's profile proved, never the frame's", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    transportState.peerNames = new Map([[who.did, "Bob"]]);
    receive(device, signedWire(who, code, { senderName: "Your Bank" }), code);
    await vi.waitFor(() => expect(s.announce).toHaveBeenCalledOnce());
    expect(s.announce.mock.calls[0][0]).toMatchObject({ senderName: "Bob", senderId: who.did });
  });

  it("titles a DM whose sender's name it does not know plainly, not by a DID's first letters", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    transportState.peerNames = new Map();
    receive(device, signedWire(who, code, { senderName: "Your Bank" }), code);
    await vi.waitFor(() => expect(s.announce).toHaveBeenCalledOnce());
    expect(s.announce.mock.calls[0][0]).toMatchObject({ senderName: "New message", senderId: who.did });
  });
});

describe("a message request sends no receipts until accepted (S08.5)", () => {
  beforeEach(() => closeDmPanel());

  it("acks no mailbox DM that files a request", async () => {
    const stranger = identity().did;
    await deliverMailboxDm(stranger, chat(stranger));
    await settled();
    expect(receipts()).toEqual([]);
  });

  it("acks no live DM in a request, and still acks an accepted DM's", async () => {
    const stranger = await dmPeer("12D3-stranger");
    receive(stranger.device, encodeDmChatEnvelope(chat(stranger.who.did)), stranger.code);
    await vi.waitFor(async () => expect(await getLastMessage(stranger.code)).toBeDefined());
    await settled();
    expect(receipts()).toEqual([]);

    const friend = await dmPeer("12D3-friend");
    await ensureDmRoomForPeer(friend.who.did);
    const payload = chat(friend.who.did);
    receive(friend.device, encodeDmChatEnvelope(payload), friend.code);
    await vi.waitFor(() => expect(receipts()).toEqual([{ to: "12D3-friend", type: "ack", ids: [payload.id] }]));
  });

  it("sends no read receipt for a request opened in the pane or the panel", async () => {
    const stranger = identity().did;
    await deliverMailboxDm(stranger, chat(stranger));
    expect(await openDmConversation(stranger)).toBe(true);
    await markSeen();
    expect(await openDmPanel(stranger)).toBe(true);
    await deliverMailboxDm(stranger, chat(stranger, "still there?", { lamport: 2 }));
    await settled();
    expect(receipts()).toEqual([]);
  });

  it("sends the held read receipt for what is on screen once accepted", async () => {
    const stranger = identity().did;
    const first = chat(stranger);
    await deliverMailboxDm(stranger, first);
    await openDmConversation(stranger);
    await settled();
    expect(receipts()).toEqual([]);
    await acceptDmRequest(stranger);
    await vi.waitFor(() => expect(receipts()).toEqual([{ to: stranger, type: "read", ids: [first.id] }]));
  });

  it("answering a request sends the read receipt it held", async () => {
    const stranger = identity().did;
    const first = chat(stranger);
    await deliverMailboxDm(stranger, first);
    await openDmConversation(stranger);
    await sendDirectMessage("hi back", { peerId: stranger });
    await vi.waitFor(() =>
      expect(receipts().filter((r) => r.type === "read")).toEqual([{ to: stranger, type: "read", ids: [first.id] }])
    );
  });
});

describe("a request is made by a message, never an empty room (S08.3)", () => {
  const code = (did: string) => hashDmRoomCode(s.session!.did, did);
  const batch = (room: string, messages: unknown[]) =>
    encode({ type: MessageType.SyncBatch, roomCode: room, messages, batchIndex: 0, totalBatches: 1 });

  /** A request an older build left behind: stored, with nothing in it. */
  async function emptyRequest(): Promise<string> {
    const did = identity().did;
    const roomCode = await code(did);
    const room: DMRoom = {
      roomCode, type: "dm", name: "", lastSeenLamport: 0, createdAt: Date.now() - 3_600_000,
      participants: [did], participantLastSeen: {}, participantDid: did, request: true,
    };
    await putRoom(room);
    return roomCode;
  }

  it("leaves no room for a first message it refuses", async () => {
    const stranger = identity().did;
    await deliverMailboxDm(stranger, chat(stranger, "x", { lamport: 2 ** 49 }));
    expect(await getRoom(await code(stranger))).toBeUndefined();
  });

  it("leaves no room for a first message whose id we already hold", async () => {
    const first = identity().did, squatter = identity().did;
    await deliverMailboxDm(first, chat(first, "mine", { id: "legacy-id-1" }));
    await deliverMailboxDm(squatter, chat(squatter, "not yours", { id: "legacy-id-1" }));
    expect(await getRoom(await code(squatter))).toBeUndefined();
  });

  it("leaves no room for a batch whose every row is refused, live or from the mailbox", async () => {
    const mailed = identity().did;
    await deliverMailboxBatch(mailed, batch(await code(mailed), [{}]));
    await deliverMailboxBatch(mailed, batch(await code(mailed), [null]));
    expect(await getRoom(await code(mailed))).toBeUndefined();

    const live = await dmPeer("12D3-stranger");
    receive(live.device, batch(live.code, [{ type: MessageType.PluginCard, id: "x", senderId: live.who.did }]), live.code);
    await settled();
    expect(await getRoom(live.code)).toBeUndefined();
    expect(await getDMRooms()).toEqual([]);
  });

  it("counts only requests somebody wrote in", async () => {
    for (let i = 0; i < MAX_DM_REQUESTS; i++) await emptyRequest();
    const stranger = identity().did;
    await deliverMailboxDm(stranger, chat(stranger));
    expect((await getLastMessage(await code(stranger)))?.content).toBe("hello");
  });

  it("keeps a DM the full requests cannot take in the mailbox, instead of acking it away", async () => {
    for (let i = 0; i < MAX_DM_REQUESTS; i++) {
      const sender = identity().did;
      await deliverMailboxDm(sender, chat(sender));
    }
    const late = identity();
    const lateRoom = await code(late.did);
    await expect(deliverMailboxDm(late.did, chat(late.did))).rejects.toThrow();
    await expect(deliverMailboxBatch(late.did, batch(lateRoom, [signedWire(late, lateRoom)]))).rejects.toThrow();
    // Junk is still answered as junk: acked away, never kept for a slot.
    await expect(deliverMailboxBatch(late.did, batch(lateRoom, [{}]))).resolves.toBeUndefined();
    expect(await getRoom(lateRoom)).toBeUndefined();
  });

  it("deletes the empty requests an older build left, on connecting", async () => {
    const empty = await emptyRequest();
    const stranger = identity().did;
    await deliverMailboxDm(stranger, chat(stranger));
    await connect();
    await vi.waitFor(async () => expect(await getRoom(empty)).toBeUndefined());
    expect(await getRoom(await code(stranger))).toMatchObject({ request: true });
    disconnectTransport();
  });

  it("does not take a request whose only message will not open for an empty one", async () => {
    const empty = await emptyRequest();
    const unreadable = await emptyRequest();
    await putMessage({ id: "sealed-elsewhere", roomCode: unreadable, senderId: identity().did, senderName: "",
      timestamp: 1, lamport: 1, type: MessageType.Text, content: "x", attachments: [], status: "delivered" });
    // A clear field rewritten around the seal: the row no longer opens.
    const db = await getDB();
    await db.put("messages", { ...(await db.get("messages", "sealed-elsewhere")), status: "read" } as never);
    await connect();
    await vi.waitFor(async () => expect(await getRoom(empty)).toBeUndefined());
    expect(await getRoom(unreadable)).toMatchObject({ request: true });
    disconnectTransport();
  });
});

describe("an introduction alone makes no DM (S08.1)", () => {
  const code = (did: string) => hashDmRoomCode(s.session!.did, did);
  const introduce = (device: string, did: string, pqPending = false) =>
    s.hooks.verified!(device, did, "r2_unused", pqPending);

  /** A room we share whose member list holds these identities - which any member can arrange. */
  async function sharedRoom(dids: string[]) {
    await putRoom({ roomCode: "SHAREDROOM1", type: "text", name: "shared", lastSeenLamport: 0,
      createdAt: Date.now(), participants: dids, participantLastSeen: {} });
  }

  /** The post-quantum state an introduction with `peer` would agree on. */
  function pqStateWith(peer: UnlockedSession) {
    const me = s.session!;
    const mine = dmPqRole(me.privateKey, peer.publicKey) === "encapsulator";
    const [enc, dec] = mine ? [me, peer] : [peer, me];
    return dmPqEncapsulate(enc.privateKey, dec.publicKey, derivePqKemKeypair(dec.privateKey).publicKey);
  }

  it("joins for the first message to arrive by, and stores the DM with that message", async () => {
    const mate = identity();
    await sharedRoom([mate.did]);
    const room = await code(mate.did);
    await introduce("12D3-mate", mate.did);
    expect(s.bound.has(room)).toBe(true);
    expect(await getRoom(room)).toBeUndefined();

    s.roomPeers.set(room, new Set(["12D3-mate"]));
    receive("12D3-mate", encodeDmChatEnvelope(chat(mate.did)), room);
    await vi.waitFor(async () => expect(await getRoom(room)).toMatchObject({ request: false }));
    expect((await getLastMessage(room))?.content).toBe("hello");
  });

  it("stores the DM under the post-quantum key its introduction agreed", async () => {
    const peer = identity();
    const state = pqStateWith(peer);
    const room = await code(peer.did);
    await introduce("12D3-pq", peer.did, true);
    await s.hooks.upgraded!("12D3-pq", peer.did, state);
    expect(await getRoom(room)).toBeUndefined();
    s.roomPeers.set(room, new Set(["12D3-pq"]));
    receive("12D3-pq", encodeDmChatEnvelope(chat(peer.did)), room);
    await vi.waitFor(async () => expect(await getRoom(room)).toMatchObject({ pq: state, request: true }));
  });

  it("files no bare message in a DM nobody stored, and leaves it to the batch that follows", async () => {
    const mate = identity();
    await sharedRoom([mate.did]);
    const room = await code(mate.did);
    await introduce("12D3-mate", mate.did);
    s.roomPeers.set(room, new Set(["12D3-mate"]));
    const wire = signedWire(mate, room, { type: MessageType.PluginCard,
      content: JSON.stringify({ pluginId: "poll", cardId: "c1", data: {} }) });
    receive("12D3-mate", wire, room);
    await settled();
    expect(await getMessage(wire.id)).toBeUndefined();
    receive("12D3-mate", { type: MessageType.SyncBatch, roomCode: room, messages: [wire],
      batchIndex: 0, totalBatches: 1, live: true }, room);
    await vi.waitFor(async () => expect(await getMessage(wire.id)).toBeDefined());
    expect(await getRoom(room)).toMatchObject({ request: false });
  });

  it("cannot run the conversation bindings out with identities a room member mints", async () => {
    const minted = Array.from({ length: 100 }, () => identity().did);
    await sharedRoom(minted);
    for (const [i, did] of minted.entries()) await introduce(`12D3-minted-${i}`, did);
    expect(s.bound.size).toBeLessThanOrEqual(32);
    expect(await getDMRooms()).toEqual([]);
  });

  it("binds an empty DM an older build stored no more than a new one", async () => {
    const minted = Array.from({ length: 100 }, () => identity().did);
    for (const did of minted) {
      const room: DMRoom = { roomCode: await code(did), type: "dm", name: "", lastSeenLamport: 0,
        createdAt: 1, participants: [did], participantLastSeen: {}, participantDid: did, request: false };
      await putRoom(room);
    }
    for (const [i, did] of minted.entries()) await introduce(`12D3-minted-${i}`, did);
    expect(s.bound.size).toBeLessThanOrEqual(32);
    // One already joined - a contact's, say - stays joined.
    const contact = identity().did;
    await ensureDmRoomForPeer(contact);
    for (const [i, did] of minted.entries()) await introduce(`12D3-again-${i}`, did);
    expect(s.bound.has(await code(contact))).toBe(true);
  });

  it("keeps an empty DM an older build stored in the bound through a post-quantum upgrade", async () => {
    const minted = Array.from({ length: 40 }, () => identity());
    for (const peer of minted) {
      await putRoom({ roomCode: await code(peer.did), type: "dm", name: "", lastSeenLamport: 0, createdAt: 1,
        participants: [peer.did], participantLastSeen: {}, participantDid: peer.did, request: false } as DMRoom);
    }
    for (const [i, peer] of minted.entries()) {
      await introduce(`12D3-minted-${i}`, peer.did);
      const state = pqStateWith(peer);
      await s.hooks.upgraded!(`12D3-minted-${i}`, peer.did, state);
      // The record follows the key the two devices agreed, joined or not.
      expect(await getRoom(await code(peer.did))).toMatchObject({ pq: state });
    }
    expect(s.bound.size).toBeLessThanOrEqual(32);
  });

  it("takes only so many new conversations a session from people it does not know for sure", async () => {
    const minted = Array.from({ length: MAX_UNSOLICITED_DMS + 1 }, () => identity().did);
    await sharedRoom(minted);
    for (const did of minted.slice(0, -1)) await deliverMailboxDm(did, chat(did));
    const last = minted.at(-1)!;
    await expect(deliverMailboxDm(last, chat(last))).rejects.toThrow();
    expect(await getRoom(await code(last))).toBeUndefined();
    // Somebody we reached out to is never held back.
    const friend = identity().did;
    await ensureDmRoomForPeer(friend);
    await deliverMailboxDm(friend, chat(friend));
    expect((await getLastMessage(await code(friend)))?.content).toBe("hello");
  });

  it("joins at connect only the saved DMs somebody wrote in", async () => {
    const spoken = identity().did, silent = identity().did;
    await ensureDmRoomForPeer(spoken);
    await deliverMailboxDm(spoken, chat(spoken));
    await ensureDmRoomForPeer(silent);
    s.bound.clear(); s.joined.clear();
    await connect();
    await vi.waitFor(async () => expect(s.bound.has(await code(spoken))).toBe(true));
    await settled();
    expect(s.bound.has(await code(silent))).toBe(false);
    disconnectTransport();
  });

  /** A DM stored earlier, accepted, with one message from them in it. */
  async function savedDm(did: string, extra: Partial<DMRoom> = {}): Promise<string> {
    const roomCode = await code(did);
    await putRoom({ roomCode, type: "dm", name: "", lastSeenLamport: 0, createdAt: 1, participants: [did],
      participantLastSeen: {}, participantDid: did, request: false, ...extra } as DMRoom);
    await putMessage({ id: newMessageId(did), roomCode, senderId: did, senderName: "", timestamp: 1, lamport: 1,
      type: MessageType.Text, content: "earlier", attachments: [], status: "delivered" });
    return roomCode;
  }

  it("joins at connect a contact's DM, and of the rest the ones read last, a bounded few", async () => {
    const contact = identity().did;
    await savedDm(contact);
    await putPhonebookEntry({ peerId: contact, did: contact, nickname: "Carol", addedAt: 1 });
    const others = Array.from({ length: SAVED_DMS_JOINED_AT_CONNECT + 10 }, () => identity().did);
    // Newest stored first, unless the user read it: the oldest one, read.
    for (const [i, did] of others.entries()) {
      await savedDm(did, { createdAt: 100 + i, lastSeenLamport: i === 0 ? 1 : 0 });
    }
    s.bound.clear(); s.joined.clear();
    await connect();
    await vi.waitFor(() => expect(s.bound.size).toBe(SAVED_DMS_JOINED_AT_CONNECT + 1));
    await settled();
    expect(s.bound.size).toBe(SAVED_DMS_JOINED_AT_CONNECT + 1);
    expect(s.bound.has(await code(contact))).toBe(true);
    expect(s.bound.has(await code(others[0]))).toBe(true);
    expect(s.bound.has(await code(others.at(-1)!))).toBe(true);
    expect(s.bound.has(await code(others[1]))).toBe(false);
    disconnectTransport();
  });

  it("joins no more for others in a session than its bound, however many saved DMs they hold", async () => {
    const peers = Array.from({ length: MAX_DMS_JOINED_FOR_THEM + 8 }, () => identity().did);
    for (const [i, did] of peers.entries()) {
      await savedDm(did);
      await introduce(`12D3-saved-${i}`, did);
    }
    expect(s.bound.size).toBe(MAX_DMS_JOINED_FOR_THEM);
    // Past it a DM still takes their messages: it only is not joined.
    const late = peers.at(-1)!;
    await deliverMailboxDm(late, chat(late, "still here", { lamport: 2 }));
    expect((await getLastMessage(await code(late)))?.content).toBe("still here");
    expect(s.bound.has(await code(late))).toBe(false);
    // Whoever the user writes to is joined whatever the others hold.
    const friend = identity().did;
    await ensureDmRoomForPeer(friend);
    expect(s.bound.has(await code(friend))).toBe(true);
    await ensureDmRoomForPeer(late);
    expect(s.bound.has(await code(late))).toBe(true);
  });

  it("keeps a mailbox batch for a DM it could not join in the mailbox, and takes it once joined", async () => {
    for (let i = 0; i < MAX_DMS_JOINED_FOR_THEM; i++) {
      const did = identity().did;
      await savedDm(did);
      await introduce(`12D3-saved-${i}`, did);
    }
    const late = identity();
    const room = await savedDm(late.did);
    const card = signedWire(late, room, { lamport: 2 });
    const blob = encode({ type: MessageType.SyncBatch, roomCode: room, messages: [card], batchIndex: 0, totalBatches: 1 });
    await expect(deliverMailboxBatch(late.did, blob)).rejects.toThrow();
    expect(await getMessage(card.id)).toBeUndefined();
    await openDmConversation(late.did);
    await deliverMailboxBatch(late.did, blob);
    expect(await getMessage(card.id)).toBeDefined();
  });

  it("joins a DM the user opened again after another tab held the node, whatever others hold", async () => {
    for (let i = 0; i < MAX_DMS_JOINED_FOR_THEM; i++) {
      const did = identity().did;
      await savedDm(did);
      await introduce(`12D3-saved-${i}`, did);
    }
    const mine = identity().did;
    const room = await savedDm(mine);
    expect(await openDmConversation(mine)).toBe(true);
    // Another tab takes the node: every conversation is left, the session
    // goes on, and the node comes back.
    s.joined.clear();
    transportState.relayConnected = false;
    await connect();
    await vi.waitFor(() => expect(s.joined.has(room)).toBe(true));
    disconnectTransport();
  });

  it("lets go of every conversation it joined for others when it locks", async () => {
    const friend = identity().did;
    await ensureDmRoomForPeer(friend);
    const saved = identity().did;
    await savedDm(saved);
    await introduce("12D3-saved", saved);
    await introduce("12D3-new", identity().did);
    expect(s.bound.size).toBe(3);
    notifyIdentityLock();
    expect([...s.bound]).toEqual([await code(friend)]);
  });
});

describe("a read receipt walks only what it has not walked before (P03.9)", () => {
  const walks = () => vi.mocked(markOwnMessagesReadUpTo).mock.calls.map(([, , upTo, after]) => [upTo, after]);

  /** One of our own messages in the DM, delivered but not yet read. */
  async function ours(room: string, lamport: number): Promise<string> {
    const id = newMessageId(s.session!.did);
    await putMessage({ id, roomCode: room, senderId: s.session!.did, senderName: "You", timestamp: lamport,
      lamport, type: MessageType.Text, content: `#${lamport}`, attachments: [], status: "delivered" });
    return id;
  }

  it("cascades each stretch of the conversation once", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    const [first, second, third] = [await ours(code, 10), await ours(code, 20), await ours(code, 30)];
    const read = async (id: string) => {
      receive(device, encodeDmReadEnvelope([id]), code);
      await settled();
    };
    await read(second);
    await read(third);
    await read(first);
    expect(walks()).toEqual([[20, -1], [30, 20]]);
    expect((await getMessage(first))?.status).toBe("read");
  });

  it("walks back down for one of ours stored below that point unread", async () => {
    const { who, device, code } = await dmPeer();
    await ensureDmRoomForPeer(who.did);
    const top = await ours(code, 30);
    receive(device, encodeDmReadEnvelope([top]), code);
    await settled();
    const late = await ours(code, 25);
    const newest = await ours(code, 40);
    receive(device, encodeDmReadEnvelope([newest]), code);
    await settled();
    expect(walks()).toEqual([[30, -1], [40, 24]]);
    expect((await getMessage(late))?.status).toBe("read");
  });
});
