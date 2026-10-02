import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// The message-request paths end to end: the real transport, DM and storage
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
  forget: vi.fn(),
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
      s.forget(localId);
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
    dialNow() {}
  },
}));
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

import { deliverMailboxDm, transportState, _peerIdToDid } from "./transport.svelte";
import { openDmConversation, ensureDmRoomForPeer, isDmRequestRoom } from "./dm.svelte";
import { getRoom, wipeLocalDatabase, getLastMessage, getRoomParticipants, getMessage } from "$lib/storage";
import { encode, decode } from "$lib/utils";
import { MessageType, messageToWire, type Message, type WireChatMessage } from "$lib/types/message";
import { canonicalContentV3 } from "$lib/messaging";
import { roomsStore } from "$lib/rooms.svelte";
import { hashDmRoomCode, type DmPayload } from "./dm-codec";
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

const rosters = () =>
  s.sent.filter((f) => (decode(f.data) as { type?: string })?.type === MessageType.RoomUsersSync);

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
});
