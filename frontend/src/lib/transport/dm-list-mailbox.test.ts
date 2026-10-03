import { beforeEach, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";

// The DM list rebuilds on DM events, no longer on every profile frame. A DM
// file, card or plugin update collected from the relay mailbox goes through
// deliverMailboxBatch, which refreshes the DM rooms before it stores the row.
// Signalling nothing after it, the list read the conversation too early (no
// row yet) and was never told again: a stale preview and unread count, and a
// first-contact request whose only message is such a row not listed at all.
const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rows: new Map<string, any>(),
  events: [] as string[],
  dmVersionAt: [] as number[],
}));
vi.mock("$lib/identity/identity", () => {
  const session = { did: "did:alice" };
  return { requireSession: () => session, onIdentityLock: () => () => {} };
});
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["dm-peer"]; }
  peers() { return ["peer1"]; } peersInRoom() { return ["peer1"]; }
  isRoomPeer() { return true; }
  isSecureRoom() { return true; }
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
  PAGE_SIZE: 50, MAX_ROOM_PARTICIPANTS: 512,
  addRoomParticipants: async () => {}, updateParticipantLastSeen: async () => {},
  getAttachmentsByInfoHash: async () => [], getAttachmentsByMessage: async () => [],
  putAttachment: async () => {},
  getMessage: async (id: string) => s.rows.get(id),
  messageClearFieldsByIds: async (ids: string[]) => new Map(ids.filter((id) => s.rows.has(id)).map((id) => {
    const m = s.rows.get(id);
    return [id, { roomCode: m.roomCode, senderId: m.senderId, lamport: m.lamport }];
  })),
  bulkPutMessages: async (rows: any[]) => {
    rows.forEach((m) => s.rows.set(m.id, m));
    s.events.push("stored");
  },
  putMessage: async (m: any) => { s.rows.set(m.id, m); s.events.push("stored"); },
  setWatermark: async () => {}, commitWatermark: async () => {},
  holdWatermarks: () => {}, releaseWatermarks: async () => {}, heldWatermarks: () => new Map(),
  getWatermarksForRoom: async () => ({}), senderMaxLamports: async () => new Map(),
  getDeletedFloor: async () => 0,
  getRoom: async (room: string) => ({ roomCode: room, type: "dm", createdAt: 1 }),
}));
vi.mock("./attachment-ownership", () => ({ ensureMessageAttachmentOwnership: async () => {} }));
// A DM batch drops each row whose signed form cannot be built before
// anything else; these rows are all readable.
vi.mock("$lib/messaging", () => ({ canonicalContentV3: () => "" }));
const mirror = vi.hoisted(() => ({ dmRooms: [{ roomCode: "dm-peer", participantDid: "did:peer", lastSeenLamport: 0 }] as any[] }));
vi.mock("$lib/rooms.svelte", () => ({
  noteRoomActivity: vi.fn(), noteUnreadArrivals: vi.fn(), noteRoomRead: vi.fn(),
  refreshDmRooms: async () => { s.events.push("refreshDmRooms"); },
  roomsStore: { rooms: [], get dmRooms() { return mirror.dmRooms; } },
}));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({
  isDmRequestRoom: () => false,
  dmPeerDid: () => "did:peer",
  dmConversationCodeAsync: async () => "dm-peer",
  dmRoomExists: async () => true,
  dmJoinableForThem: () => true,
  dropDmIfEmpty: async () => {},
  ensureDmRoomForPeer: async () => "dm-peer",
}));
vi.mock("./verify-incoming", async (original) => ({
  ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }),
}));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v, hashRef: (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { _peerIdToDid, deliverMailboxBatch, transportState } from "./transport.svelte";
import { encode } from "$lib/utils";

const card = (id: string, lamport: number) => ({
  id, senderId: "did:peer", senderDid: "did:peer", senderName: "Peer",
  type: MessageType.Text, content: `hello ${lamport}`, lamport, timestamp: lamport,
  sig: "signed", sigV: 3,
});

beforeEach(() => {
  s.rows.clear();
  s.events = [];
  transportState.roomCode = null;
  _peerIdToDid.set("peer1", "did:peer");
});

/** Was the DM list told anything AFTER the row landed in storage? */
function toldAfterStore(before: number): boolean {
  const stored = s.events.indexOf("stored");
  expect(stored).toBeGreaterThanOrEqual(0);
  return transportState.dmVersion > before || s.events.lastIndexOf("refreshDmRooms") > stored;
}

it("a DM batch over the channel tells the DM list once its row is stored", async () => {
  const before = transportState.dmVersion;
  s.handlers.get("message")!("peer1", encode({ type: MessageType.SyncBatch, roomCode: "dm-peer",
    live: true, batchIndex: 0, totalBatches: 1, messages: [card("live-1", 5)] }), "dm-peer");
  await vi.waitFor(() => expect(s.rows.has("live-1")).toBe(true));
  await new Promise((r) => setTimeout(r, 10));
  expect(toldAfterStore(before)).toBe(true);
});

it("a DM batch collected from the mailbox tells the DM list once its row is stored", async () => {
  const before = transportState.dmVersion;
  await deliverMailboxBatch("did:peer", encode({ type: MessageType.SyncBatch, roomCode: "dm-peer",
    live: true, batchIndex: 0, totalBatches: 1, messages: [card("mail-1", 7)] }));
  expect(s.rows.has("mail-1")).toBe(true);
  // Not only the refresh before the row existed: a signal after it.
  expect({ events: s.events, told: toldAfterStore(before) }).toMatchObject({ told: true });
});

it("a DM the list's mirror never had is listed once a mailbox batch lands in it", async () => {
  const saved = mirror.dmRooms;
  mirror.dmRooms = [];
  try {
    await deliverMailboxBatch("did:peer", encode({ type: MessageType.SyncBatch, roomCode: "dm-peer",
      live: true, batchIndex: 0, totalBatches: 1, messages: [card("mail-2", 9)] }));
    expect(s.rows.has("mail-2")).toBe(true);
    expect(s.events.lastIndexOf("refreshDmRooms")).toBeGreaterThan(s.events.indexOf("stored"));
  } finally {
    mirror.dmRooms = saved;
  }
});
