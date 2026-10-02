import { beforeEach, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";
import { CARD_FLOOD_LIMIT, UPDATE_FLOOD_LIMIT } from "$lib/plugins/flood-cap";

// The receive path for real (transport.svelte.ts), with the network, storage
// and signatures stubbed the way review-fixes.test.ts does: what is counted
// is what reaches storage.
const s = vi.hoisted(() => ({
  session: { did: "did:alice" },
  handlers: new Map<string, Function>(),
  rows: new Map<string, any>(),
  put: vi.fn(async (m: any, guard?: () => void) => { guard?.(); s.rows.set(m.id, m); }),
}));
vi.mock("$lib/identity/identity", () => ({
  // One session object: work started under it is checked against it.
  requireSession: () => s.session,
  onIdentityLock: () => () => {},
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room"]; }
  peers() { return []; } peersInRoom() { return ["peer1"]; }
  isRoomPeer(_room: string, peer: string) { return peer === "peer1"; }
  isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
  send = vi.fn(async () => true); sendRoom = vi.fn(async () => true);
  leaveRoom = vi.fn(); broadcast = vi.fn(); disconnect = vi.fn();
} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class { setCallPeers() {} } }));
vi.mock("./mediasoup", () => ({ MediasoupVideo: class {
  setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {}
} }));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./file/webtorrent", () => ({ WebTorrentFileTransport: class {
  on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers() {} onPeerDisconnect() {}
} }));
vi.mock("$lib/storage", () => ({
  putMessage: s.put,
  getMessage: async (id: string) => s.rows.get(id),
  setWatermark: async () => {}, markRoomSeen: async () => {},
  getRoom: async (room: string) => ({ roomCode: room, type: "text", createdAt: 1 }),
  messageClearFieldsByIds: async () =>
    new Map([...s.rows].map(([id, m]) => [id, { roomCode: m.roomCode, senderId: m.senderId }])),
  bulkPutMessages: async (rows: any[], guard: () => void) => { guard(); rows.forEach(m => s.rows.set(m.id, m)); },
  getAttachmentsByMessage: async () => [],
  getDeletedFloor: async () => 0, addRoomParticipants: async () => {}, MAX_ROOM_PARTICIPANTS: 512,
}));
vi.mock("$lib/messaging", () => ({ signMessage: (m: any) => m, signPeerBinding: () => ({ bindingSig: "sig" }), verifyPeerBinding: async () => true }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, refreshDmRooms: async () => {}, roomsStore: { rooms: [], dmRooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("./verify-incoming", async original => ({ ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }) }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v, hashRef: (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { transportState } from "./transport.svelte";
import { encode } from "$lib/utils";

const ROOM = "rd2_room";
let seq = 0;

function card(senderId: string) {
  seq += 1;
  return { type: MessageType.PluginCard, id: `card-${seq}`, senderId, senderDid: senderId,
    senderName: "M", timestamp: seq, lamport: seq, sig: "s", sigV: 3,
    content: JSON.stringify({ pluginId: "poll", data: { question: "?", options: ["a", "b"] } }) };
}

function update(senderId: string, pluginId: string) {
  seq += 1;
  return { type: MessageType.PluginUpdate, id: `update-${seq}`, senderId, senderDid: senderId,
    senderName: "M", timestamp: seq, lamport: seq, sig: "s", sigV: 3,
    content: JSON.stringify({ pluginId, cardId: "card-x", data: { v: seq } }) };
}

const live = (wire: object) => s.handlers.get("message")!("peer1", encode(wire), ROOM);
const batch = (messages: object[], isLive: boolean) =>
  s.handlers.get("message")!("peer1", encode({ type: MessageType.SyncBatch, roomCode: ROOM,
    messages, batchIndex: 0, totalBatches: 1, live: isLive }), ROOM);
const stored = (type: MessageType, senderId: string) =>
  [...s.rows.values()].filter((m) => m.type === type && m.senderId === senderId);
/** Every frame handed in has had its turn: verify and store are async. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  s.rows.clear();
  transportState.roomCode = ROOM;
  transportState.chatMode = "room";
  transportState.messages = [];
});

// Cards had no cap at all: stored for good and rendered for everyone, a
// member could post them by the thousand.
it("stores at most the card cap from one member, live", async () => {
  for (let i = 0; i < CARD_FLOOD_LIMIT + 3; i++) live(card("did:mallory-1"));
  await vi.waitFor(() => expect(stored(MessageType.PluginCard, "did:mallory-1")).toHaveLength(CARD_FLOOD_LIMIT));
  await settle();
  expect(stored(MessageType.PluginCard, "did:mallory-1")).toHaveLength(CARD_FLOOD_LIMIT);
  // Someone else in the room has a window of their own.
  live(card("did:ana"));
  await vi.waitFor(() => expect(stored(MessageType.PluginCard, "did:ana")).toHaveLength(1));
});

// M15's residual: the update cap was keyed on the pluginId too, which the
// sender writes - a made-up plugin per update was a fresh window per update.
it("caps updates per room and sender, whatever plugin each names", async () => {
  for (let i = 0; i < UPDATE_FLOOD_LIMIT + 5; i++) live(update("did:mallory-2", `made-up-${i}`));
  await vi.waitFor(() => expect(stored(MessageType.PluginUpdate, "did:mallory-2")).toHaveLength(UPDATE_FLOOD_LIMIT));
  await settle();
  expect(stored(MessageType.PluginUpdate, "did:mallory-2")).toHaveLength(UPDATE_FLOOD_LIMIT);
});

// A live send arrives twice, gossip and direct batch: one message, counted
// once - and the batch copy is no way around the cap.
it("counts a live batch with its gossip copies, once per message", async () => {
  const cards = Array.from({ length: CARD_FLOOD_LIMIT }, () => card("did:mallory-3"));
  for (const c of cards) live(c);
  await vi.waitFor(() => expect(stored(MessageType.PluginCard, "did:mallory-3")).toHaveLength(CARD_FLOOD_LIMIT));
  const extra = card("did:mallory-3");
  batch([...cards, extra], true);
  await settle();
  expect(stored(MessageType.PluginCard, "did:mallory-3")).toHaveLength(CARD_FLOOD_LIMIT);
  expect(s.rows.has(extra.id)).toBe(false);
});

// History repair hands over a room's plugin history at once, and dropping
// rows there would lose them for good: repair batches stay uncapped.
it("leaves a repair batch uncapped", async () => {
  const history = Array.from({ length: CARD_FLOOD_LIMIT + 5 }, () => card("did:old-member"));
  batch(history, false);
  await vi.waitFor(() => expect(stored(MessageType.PluginCard, "did:old-member")).toHaveLength(history.length));
});
