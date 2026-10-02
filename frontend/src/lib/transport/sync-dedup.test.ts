import { beforeEach, expect, it, vi } from "vitest";
import { MessageType, type WireChatMessage } from "$lib/types/message";

// History sync through the real transport.svelte message handler, with the
// network and storage replaced by in-memory stand-ins that keep storage.ts's
// rules (rows by id, watermarks that never regress).
const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rows: new Map<string, any>(),
  watermarks: new Map<string, number>(),
  verify: vi.fn(async (_w: any, _opts?: any) => ({ ok: true }) as const),
  roomSend: vi.fn(async (_peer: string, _room: string, _frame: Uint8Array) => true),
  broadcast: vi.fn(async (_frame: Uint8Array, _room: string) => {}),
  peers: ["peer1"] as string[],
  roomPeers: ["peer1"] as string[],
  attachmentRepairs: [] as string[],
}));
vi.mock("$lib/identity/identity", () => {
  const session = { did: "did:key:me" };
  return { requireSession: () => session, onIdentityLock: () => () => {} };
});
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:key:me" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  p2pNode = {};
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room"]; }
  peers() { return s.peers; } peersInRoom() { return s.roomPeers; }
  isRoomPeer(_room: string, peer: string) { return s.roomPeers.includes(peer); }
  isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
  sendRoom = s.roomSend; broadcast = s.broadcast;
  send = vi.fn(); leaveRoom = vi.fn(); disconnect = vi.fn();
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
  getOwnProfile: async () => ({ nickname: "Me" }),
  nextMessageLamport: async () => 100,
  getRoom: async (room: string) => ({ roomCode: room, type: "text", createdAt: 1 }),
  markRoomSeen: async () => {},
  addRoomParticipants: async () => {},
  updateParticipantLastSeen: async () => {},
  getDeletedFloor: async () => 0,
  MAX_ROOM_PARTICIPANTS: 512,
  getMessage: async (id: string) => s.rows.get(id),
  putMessage: async (m: any, guard?: () => void) => { guard?.(); s.rows.set(m.id, m); },
  bulkPutMessages: async (rows: any[], guard?: () => void) => { guard?.(); rows.forEach((m) => s.rows.set(m.id, m)); },
  messageClearFieldsByIds: async (ids: string[]) => new Map(ids.filter((id) => s.rows.has(id)).map((id) => {
    const m = s.rows.get(id);
    return [id, { roomCode: m.roomCode, senderId: m.senderId, lamport: m.lamport }];
  })),
  setWatermark: async (room: string, sender: string, lamport: number, guard?: () => void) => {
    guard?.();
    const key = `${room}|${sender}`;
    if ((s.watermarks.get(key) ?? -1) < lamport) s.watermarks.set(key, lamport);
  },
  getAttachmentsByMessage: async () => [],
  putAttachment: async () => {},
  updateMessageStatus: async () => {},
  getWatermarksForRoom: async () => ({}),
  holdWatermarks: () => {},
  releaseWatermarks: async () => {},
  commitWatermark: async () => {},
}));
vi.mock("./attachment-ownership", () => ({
  ensureMessageAttachmentOwnership: async (id: string) => { s.attachmentRepairs.push(id); },
}));
vi.mock("$lib/messaging", () => ({ signMessage: (m: any) => ({ ...m, sig: "sig", sigV: 3, senderDid: m.senderId }) }));
vi.mock("$lib/rooms.svelte", () => ({
  noteRoomActivity: vi.fn(), noteUnreadArrivals: vi.fn(), noteRoomRead: vi.fn(), refreshDmRooms: async () => {},
  roomsStore: { rooms: [], dmRooms: [] },
}));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ isDmRequestRoom: () => false, flushQueuedDmForPeer: async () => {} }));
vi.mock("./verify-incoming", async (original) => ({
  ...await original<typeof import("./verify-incoming")>(), verifyIncoming: s.verify,
}));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v, hashRef: (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { _peerIdToDid, sendMessage, transportState } from "./transport.svelte";
import { noteUnreadArrivals } from "$lib/rooms.svelte";
import { decode, encode } from "$lib/utils";

const ROOM = "rd2_room";
const AUTHOR = "did:key:author";

function row(lamport: number, over: Partial<WireChatMessage> = {}): WireChatMessage {
  return {
    id: `row-${lamport}`, senderId: AUTHOR, senderDid: AUTHOR, senderName: "Author",
    timestamp: lamport, lamport, type: MessageType.Text, content: `m${lamport}`,
    sig: "sig", sigV: 3, ...over,
  } as WireChatMessage;
}

function batch(rows: WireChatMessage[], extra: Record<string, unknown> = {}): Uint8Array {
  return encode({
    type: MessageType.SyncBatch, roomCode: ROOM, messages: rows,
    batchIndex: 0, totalBatches: 1, ...extra,
  });
}

function hold(lamport: number): void {
  const w = row(lamport);
  s.rows.set(w.id, { ...w, roomCode: ROOM, attachments: [] });
}

beforeEach(() => {
  s.rows.clear();
  s.watermarks.clear();
  s.attachmentRepairs = [];
  s.verify.mockClear();
  s.roomSend.mockClear();
  s.broadcast.mockClear();
  s.peers = ["peer1"];
  s.roomPeers = ["peer1"];
  transportState.roomCode = "rd2_elsewhere";
  transportState.chatMode = "room";
  transportState.messages = [];
});

it("verifies only the rows of a sync batch it does not already hold", async () => {
  const onMessage = s.handlers.get("message")!;
  hold(1);
  hold(2);
  onMessage("peer1", batch([row(1), row(2), row(3)], { live: true }), ROOM);
  await vi.waitFor(() => expect(s.rows.has("row-3")).toBe(true));
  expect(s.verify).toHaveBeenCalledTimes(1);
  expect((s.verify.mock.calls[0][0] as WireChatMessage).id).toBe("row-3");
});

it("verifies nothing for a repeated backlog it already holds", async () => {
  const onMessage = s.handlers.get("message")!;
  for (let l = 1; l <= 20; l++) hold(l);
  const before = new Map(s.rows);
  onMessage("peer1", batch(Array.from({ length: 20 }, (_, i) => row(i + 1)), { live: true }), ROOM);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(s.verify).not.toHaveBeenCalled();
  // Held rows stay exactly as stored: re-delivery is a no-op.
  for (const [id, m] of before) expect(s.rows.get(id)).toBe(m);
});

it("still refuses a held id arriving from another sender, without verifying it", async () => {
  const onMessage = s.handlers.get("message")!;
  hold(1);
  const original = s.rows.get("row-1");
  onMessage("peer1", batch([row(1, { senderId: "did:key:other", senderDid: "did:key:other", content: "x" })], { live: true }), ROOM);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(s.verify).not.toHaveBeenCalled();
  expect(s.rows.get("row-1")).toBe(original);
});

it("repairs a held file's attachment rows from the held copy, and only for files", async () => {
  const onMessage = s.handlers.get("message")!;
  hold(1);
  const file = row(2, { type: MessageType.File, content: "" });
  s.rows.set(file.id, { ...file, roomCode: ROOM, attachments: [] });
  onMessage("peer1", batch([row(1), file], { live: true }), ROOM);
  await vi.waitFor(() => expect(s.attachmentRepairs).toEqual(["row-2"]));
  expect(s.verify).not.toHaveBeenCalled();
});

it("loses one malformed row, not the whole batch", async () => {
  const onMessage = s.handlers.get("message")!;
  s.verify.mockImplementationOnce(async () => { throw new Error("bad descriptor"); });
  onMessage("peer1", batch([row(1), row(2)], { live: true }), ROOM);
  await vi.waitFor(() => expect(s.rows.has("row-2")).toBe(true));
  expect(s.rows.has("row-1")).toBe(false);
});

it("sends a live message once to a member the room broadcast already reached", async () => {
  transportState.roomCode = ROOM;
  transportState.roomUsers = ["did:key:reached", "did:key:pending"];
  _peerIdToDid.set("peer1", "did:key:reached");
  _peerIdToDid.set("peer2", "did:key:pending");
  s.peers = ["peer1", "peer2"];
  // peer2 is on the roster and connected, but its room channel is not
  // verified yet, so the broadcast cannot reach it.
  s.roomPeers = ["peer1"];
  await sendMessage("hello");
  expect(s.broadcast).toHaveBeenCalledTimes(1);
  const copies = s.roomSend.mock.calls.filter(([, , frame]) =>
    (decode(frame) as { type?: string }).type === MessageType.SyncBatch);
  expect(copies.map(([peer]) => peer)).toEqual(["peer2"]);
});

it("counts a live message as unread once, and a copy of one already held not at all", async () => {
  const onMessage = s.handlers.get("message")!;
  const counted = vi.mocked(noteUnreadArrivals);
  counted.mockClear();
  onMessage("peer1", encode(row(7)), ROOM);
  await vi.waitFor(() => expect(s.rows.has("row-7")).toBe(true));
  await vi.waitFor(() => expect(counted).toHaveBeenCalledTimes(1));
  expect(counted.mock.calls[0][0]).toBe(ROOM);
  onMessage("peer1", encode(row(7)), ROOM);
  onMessage("peer1", batch([row(7)], { live: true }), ROOM);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(counted).toHaveBeenCalledTimes(1);
});
