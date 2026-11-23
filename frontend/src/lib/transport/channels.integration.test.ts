import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// Channels end to end: the real transport and storage modules (fake-indexeddb,
// real at-rest crypto); only the libp2p class, the media stack and the
// notification sink are stand-ins. The other member is played by hand,
// frame by frame, over the room's authenticated channel.
const s = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null, isUnlocked: true },
  handlers: new Map<string, Function>(),
  joined: new Set<string>(),
  roomPeers: new Map<string, Set<string>>(),
  connected: [] as string[],
  sent: [] as { peer: string; room: string; data: Uint8Array }[],
  broadcasts: [] as { room: string; data: Uint8Array }[],
  announce: vi.fn(),
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
    setDmIntroduction() {}
    selfId() { return "12D3-self"; }
    rooms() { return [...s.joined]; }
    peers() { return [...s.connected]; }
    peersInRoom(room: string) { return [...(s.roomPeers.get(room) ?? [])]; }
    isRoomPeer(room: string, peer: string) { return !!s.roomPeers.get(room)?.has(peer); }
    isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
    joinRoom(room: string) { s.joined.add(room); }
    joinSecureRoom() { return "rd2_disc"; }
    holdDmLobby() {}
    leaveRoom(room: string) { s.joined.delete(room); }
    async sendRoom(peer: string, room: string, data: Uint8Array) {
      s.sent.push({ peer, room, data });
      return true;
    }
    async send() { return true; }
    async broadcast(data: Uint8Array, room: string) { s.broadcasts.push({ room, data }); }
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
  depositDmToMailbox: async () => "sent",
}));

import {
  _peerIdToDid,
  createChannel,
  currentChannel,
  deleteChannel,
  markSeen,
  renameChannel,
  selectChannel,
  sendMessage,
  toggleReaction,
  transportState,
} from "./transport.svelte";
import { getMessage, getMessages, getRoom, putRoom, wipeLocalDatabase, type Room } from "$lib/storage";
import { decode, encode, hex, utf8 } from "$lib/utils";
import { MessageType, messageToWire, type Message, type WireChatMessage } from "$lib/types/message";
import { canonicalContentV4 } from "$lib/messaging";
import { channelUnreadCount, roomChannels, roomsStore } from "$lib/rooms.svelte";
import { forgetCurrentChannel } from "$lib/channel-view.svelte";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";
import { newMessageId } from "$lib/message-id";
import {
  liveChannels,
  mergeChannelLists,
  parseChannelList,
  sameChannelList,
  type Channel,
} from "$lib/channels";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

const PEER = "12D3-peer";
let ROOM = "";
let them: UnlockedSession;

/** A frame from the other member over the room's channel. */
function receive(frame: unknown, peer = PEER): void {
  s.handlers.get("message")!(peer, encode(frame), ROOM);
}

/** Long enough for every storage round trip a frame sets off to finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 60));

function frames(list: { data: Uint8Array }[]): Array<Record<string, unknown>> {
  return list.map((f) => decode(f.data) as Record<string, unknown>);
}
const channelFrames = (list: { data: Uint8Array }[]) =>
  frames(list).filter((f) => f.type === MessageType.ChannelList);

/** A message the other member wrote in a channel, signed as their client would. */
function theirMessage(channel: string, over: Partial<Message> = {}): WireChatMessage {
  const msg: Message = {
    id: newMessageId(them.did), roomCode: ROOM, senderId: them.did, senderName: "Them",
    timestamp: Date.now(), lamport: 5, type: MessageType.Text, content: "hello in a channel",
    attachments: [], channel, ...over,
  };
  const sig = ed25519.sign(utf8(canonicalContentV4(msg)), them.privateKey);
  return messageToWire({ ...msg, senderDid: them.did, sig: hex(sig), sigV: 4 });
}

const entry = (id: string, over: Partial<Channel> = {}): Channel => ({
  id, kind: "text", name: id.slice(0, 6), position: 1, updatedAt: Date.now() - 1000, ...over,
});

beforeEach(async () => {
  await wipeLocalDatabase();
  vi.clearAllMocks();
  s.session = identity();
  s.identity.did = s.session.did;
  them = identity();
  const roomSecret = newRoomSecret();
  ROOM = deriveRoomKeys(roomSecret).discoveryId;
  const room: Room = {
    roomCode: ROOM, roomSecret, type: "text", name: "Room", nameAt: 1, lastSeenLamport: 0,
    createdAt: 1, participants: [], participantLastSeen: {},
  };
  await putRoom(room);
  roomsStore.rooms = [(await getRoom(ROOM))!];
  roomsStore.unreadCounts = new Map();
  roomsStore.channelUnread = new Map();
  forgetCurrentChannel();
  s.joined = new Set([ROOM]);
  s.roomPeers = new Map([[ROOM, new Set([PEER])]]);
  s.connected = [PEER];
  s.sent = [];
  s.broadcasts = [];
  _peerIdToDid.clear();
  _peerIdToDid.set(PEER, them.did);
  Object.assign(transportState, {
    roomCode: ROOM, uiRoomCode: ROOM, chatMode: "room", activeDmPeerId: null, roomUsers: [],
    messages: [], inCall: false, callRoomCode: null,
  });
});

describe("the channel list between members", () => {
  it("takes a member's list, stores it, and says nothing back when it holds no more", async () => {
    receive({ type: MessageType.ChannelList, channels: [entry("gamesgames"), { junk: true }] });
    await settled();
    expect((await getRoom(ROOM))?.channels?.map((c) => c.id)).toEqual(["gamesgames"]);
    expect(roomChannels(ROOM, "text").map((c) => c.id)).toEqual(["", "gamesgames"]);
    expect(channelFrames(s.sent)).toEqual([]);
  });

  it("announces its own edits to the room, and answers a member who is behind", async () => {
    const music = await createChannel(ROOM, "music");
    const [announced] = channelFrames(s.broadcasts);
    expect(parseChannelList(announced.channels).map((c) => c.id)).toEqual([music.id]);

    // A member back from away announces a list without it: answered, once.
    receive({ type: MessageType.ChannelList, channels: [entry("gamesgames")] });
    await settled();
    const answers = channelFrames(s.sent);
    expect(answers).toHaveLength(1);
    expect(answers[0].answer).toBe(true);
    expect(parseChannelList(answers[0].channels).map((c) => c.id).sort())
      .toEqual(["gamesgames", music.id].sort());

    // An answer that still lacks something is never answered in turn.
    s.sent = [];
    receive({ type: MessageType.ChannelList, channels: [entry("gamesgames")], answer: true });
    await settled();
    expect(channelFrames(s.sent)).toEqual([]);
  });

  it("converges with a member who made other changes while apart", async () => {
    const mine = await createChannel(ROOM, "mine");
    await renameChannel(ROOM, "", "lobby");
    // Theirs, kept by hand the way their client keeps it.
    let theirs: Channel[] = [entry("theirs000"), { ...entry("gonegone00"), deleted: true }];
    receive({ type: MessageType.ChannelList, channels: theirs });
    await settled();
    for (const frame of channelFrames(s.sent)) {
      theirs = mergeChannelLists(theirs, parseChannelList(frame.channels)).merged;
    }
    const ours = (await getRoom(ROOM))!.channels!;
    expect(sameChannelList(ours, theirs)).toBe(true);
    expect(liveChannels(ours, "text").map((c) => c.name).sort()).toEqual(["lobby", "mine", "theirs"]);
    expect(ours.some((c) => c.id === mine.id)).toBe(true);
  });

  it("ignores a list over a direct send for a room it has not joined, and in a DM", async () => {
    s.handlers.get("message")!(PEER, encode({
      type: MessageType.ChannelList, roomCode: "rd2_notjoined", channels: [entry("gamesgames")],
    }), null);
    await settled();
    expect((await getRoom(ROOM))?.channels).toBeUndefined();
  });

  it("announces nothing for a room nobody made a channel in", async () => {
    s.handlers.get("roomPeers")!(ROOM, [PEER]);
    await settled();
    expect(channelFrames(s.sent)).toEqual([]);
    await createChannel(ROOM, "now one");
    s.handlers.get("roomPeers")!(ROOM, [PEER]);
    await settled();
    expect(channelFrames(s.sent)).toHaveLength(1);
  });
});

describe("messages in channels", () => {
  it("sends into the open channel, signed with it, and shows only that channel's page", async () => {
    await sendMessage("in general");
    const games = await createChannel(ROOM, "games");
    expect(await selectChannel(ROOM, games.id)).toBe(true);
    expect(transportState.messages).toEqual([]);
    await sendMessage("in games");

    const chats = frames(s.broadcasts).filter((f) => f.type === MessageType.Text);
    expect(chats.map((f) => [f.content, f.channel, f.sigV])).toEqual([
      ["in general", undefined, 3],
      ["in games", games.id, 4],
    ]);
    expect(transportState.messages.map((m) => m.content)).toEqual(["in games"]);
    const stored = await getMessages(ROOM, undefined, undefined, games.id);
    expect(stored.map((m) => m.content)).toEqual(["in games"]);

    await selectChannel(ROOM, "");
    expect(currentChannel(ROOM)).toBe("");
    expect(transportState.messages.map((m) => m.content)).toEqual(["in general"]);
  });

  it("reacts in the channel of the message reacted to", async () => {
    const games = await createChannel(ROOM, "games");
    await selectChannel(ROOM, games.id);
    await sendMessage("react to me");
    const target = transportState.messages[0];
    await toggleReaction(target.id, "👍");
    const reaction = frames(s.broadcasts).find((f) => f.type === MessageType.Reaction)!;
    expect(reaction.channel).toBe(games.id);
    expect(reaction.sigV).toBe(4);
  });

  it("stores and counts a message from another channel without putting it on screen", async () => {
    receive({ type: MessageType.ChannelList, channels: [entry("gamesgames")] });
    await settled();
    const wire = theirMessage("gamesgames");
    receive(wire);
    await settled();
    expect((await getMessage(wire.id))?.channel).toBe("gamesgames");
    expect(transportState.messages).toEqual([]);
    expect(channelUnreadCount(ROOM, "gamesgames")).toBe(1);
    expect(s.announce).toHaveBeenCalledTimes(1);
    expect(s.announce.mock.calls[0][1]).toMatchObject({ uiRoomCode: ROOM, uiChannel: "" });

    // Opening the channel shows it; reading it there clears that channel only.
    await selectChannel(ROOM, "gamesgames");
    expect(transportState.messages.map((m) => m.id)).toEqual([wire.id]);
    await markSeen();
    expect(channelUnreadCount(ROOM, "gamesgames")).toBe(0);
    expect((await getRoom(ROOM))?.channelSeen).toEqual({ gamesgames: 5 });
    expect((await getRoom(ROOM))?.lastSeenLamport).toBe(0);
  });

  it("refuses a message moved into another channel on the way", async () => {
    receive({ type: MessageType.ChannelList, channels: [entry("gamesgames"), entry("musicmusic")] });
    await settled();
    const wire = theirMessage("gamesgames");
    receive({ ...wire, channel: "musicmusic" });
    await settled();
    expect(await getMessage(wire.id)).toBeUndefined();
  });

  it("puts the view back in the original chat when the open channel is deleted", async () => {
    const games = await createChannel(ROOM, "games");
    await selectChannel(ROOM, games.id);
    const tombstone = { ...games, deleted: true as const, updatedAt: games.updatedAt + 1 };
    receive({ type: MessageType.ChannelList, channels: [tombstone] });
    await settled();
    expect(currentChannel(ROOM)).toBe("");
    expect(roomChannels(ROOM, "text").map((c) => c.id)).toEqual([""]);
    await expect(sendMessage("nowhere", { channel: games.id })).rejects.toThrow();
    // Our own delete works the same way.
    const music = await createChannel(ROOM, "music");
    await selectChannel(ROOM, music.id);
    await deleteChannel(ROOM, music.id);
    expect(currentChannel(ROOM)).toBe("");
  });
});
