import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageType, type WireChatMessage } from "$lib/types/message";

// History push and receipt through the real transport.svelte message
// handler. Network and storage are in-memory stand-ins that keep storage.ts's
// rules: rows by id, watermarks that never regress, and advances that wait
// while a push holds the room.
const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rows: new Map<string, any>(),
  watermarks: new Map<string, number>(),
  holds: new Map<string, Map<string, number>>(),
  frames: [] as { peer: string; frame: any }[],
  inFlight: 0,
  mostInFlight: 0,
  refuse: (_frame: any): boolean => false,
  roomPeers: ["peer1"] as string[],
  pushReads: 0,
}));

function commit(room: string, sender: string, lamport: number): void {
  const key = `${room}|${sender}`;
  if ((s.watermarks.get(key) ?? -1) < lamport) s.watermarks.set(key, lamport);
}

vi.mock("$lib/identity/identity", () => {
  const session = { did: "did:key:me" };
  return { requireSession: () => session, onIdentityLock: () => () => {} };
});
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:key:me" } }));
vi.mock("./libp2p/transport", async () => {
  const { decode } = await import("$lib/utils");
  return { LibP2PTransport: class {
    p2pNode = {};
    on(event: string, fn: Function) { s.handlers.set(event, fn); }
    setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room"]; }
    peers() { return s.roomPeers; } peersInRoom() { return s.roomPeers; }
    isRoomPeer(_room: string, peer: string) { return s.roomPeers.includes(peer); }
    isSecureRoom() { return true; }
    async sendRoom(peer: string, _room: string, bytes: Uint8Array) {
      const frame = decode(bytes);
      s.inFlight++;
      s.mostInFlight = Math.max(s.mostInFlight, s.inFlight);
      await Promise.resolve();
      s.inFlight--;
      if (s.refuse(frame)) return false;
      s.frames.push({ peer, frame });
      return true;
    }
    broadcast = vi.fn(); send = vi.fn(); leaveRoom = vi.fn(); disconnect = vi.fn();
  } };
});
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
  PAGE_SIZE: 50,
  MAX_ROOM_PARTICIPANTS: 512,
  addRoomParticipants: async () => {},
  updateParticipantLastSeen: async () => {},
  getAttachmentsByInfoHash: async () => [],
  getMessage: async (id: string) => s.rows.get(id),
  putMessage: async (m: any) => { s.rows.set(m.id, m); },
  bulkPutMessages: async (rows: any[]) => { rows.forEach((m) => s.rows.set(m.id, m)); },
  messageClearFieldsByIds: async (ids: string[]) => new Map(ids.filter((id) => s.rows.has(id)).map((id) => {
    const m = s.rows.get(id);
    return [id, { roomCode: m.roomCode, senderId: m.senderId, lamport: m.lamport }];
  })),
  getMessagesAboveWatermarks: async (room: string, marks: Record<string, number>) => {
    s.pushReads++;
    return [...s.rows.values()].filter((m) => m.roomCode === room && m.lamport > (marks[m.senderId] ?? -1));
  },
  getRoom: async (room: string) => ({ roomCode: room, type: "text", createdAt: 1 }),
  updateMessageStatus: async () => {},
  senderMaxLamports: async (room: string) => {
    const out = new Map<string, number>();
    for (const m of s.rows.values()) {
      if (m.roomCode === room && (out.get(m.senderId) ?? -1) < m.lamport) out.set(m.senderId, m.lamport);
    }
    return out;
  },
  getWatermarksForRoom: async (room: string) => {
    const out: Record<string, number> = {};
    for (const [key, lamport] of s.watermarks) {
      const [r, sender] = key.split("|");
      if (r === room) out[sender] = lamport;
    }
    return out;
  },
  setWatermark: async (room: string, sender: string, lamport: number) => {
    const held = s.holds.get(room);
    if (!held) return commit(room, sender, lamport);
    if ((held.get(sender) ?? -1) < lamport) held.set(sender, lamport);
  },
  commitWatermark: async (room: string, sender: string, lamport: number) => commit(room, sender, lamport),
  holdWatermarks: (room: string) => { if (!s.holds.has(room)) s.holds.set(room, new Map()); },
  heldWatermarks: (room: string) => s.holds.get(room) ?? new Map(),
  releaseWatermarks: async (room: string) => {
    const held = s.holds.get(room);
    s.holds.delete(room);
    for (const [sender, lamport] of held ?? []) commit(room, sender, lamport);
  },
}));
vi.mock("./attachment-ownership", () => ({ ensureMessageAttachmentOwnership: async () => {} }));
vi.mock("$lib/messaging", () => ({}));
vi.mock("$lib/rooms.svelte", () => ({
  noteRoomActivity: vi.fn(), noteUnreadArrivals: vi.fn(), noteRoomRead: vi.fn(), refreshDmRooms: async () => {},
  roomsStore: { rooms: [], dmRooms: [] },
}));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ isDmRequestRoom: () => false }));
vi.mock("./verify-incoming", async (original) => ({
  ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }),
}));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v, hashRef: (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { _peerIdToDid, transportState } from "./transport.svelte";
import { _resetSyncThrottle } from "./sync-throttle";
import { _resetSyncProgress } from "./sync-progress.svelte";
import { encode } from "$lib/utils";

const ROOM = "rd2_room";
const SENDERS = ["did:key:a", "did:key:b", "did:key:c"];

function row(lamport: number): WireChatMessage & { roomCode: string } {
  const senderId = SENDERS[lamport % SENDERS.length];
  return {
    id: `m${String(lamport).padStart(6, "0")}`, roomCode: ROOM, senderId, senderDid: senderId,
    senderName: "Someone", timestamp: lamport, lamport, type: MessageType.Text,
    content: `m${lamport}`, sig: "sig", sigV: 3,
  } as WireChatMessage & { roomCode: string };
}

const send = (peer: string, frame: unknown) => s.handlers.get("message")!(peer, encode(frame), ROOM);

beforeEach(() => {
  s.rows.clear();
  s.watermarks.clear();
  s.holds.clear();
  s.frames = [];
  s.roomPeers = ["peer1", "peer2"];
  _resetSyncThrottle();
  _resetSyncProgress();
  transportState.roomCode = "rd2_elsewhere";
  transportState.messages = [];
  _peerIdToDid.set("peer1", "did:key:peer1");
  _peerIdToDid.set("peer2", "did:key:peer2");
});

// Every digest we send holds the room until the peer answers it - for an
// older build, which never answers, 15s (EXPECT_PUSH_MS). A live message
// landing meanwhile is stored but its claim waits. The next exchange with
// anybody who also has it used to read as "we are behind": we asked them for
// a row we held, they pushed it back, and the exchange reset the repair
// backoff instead of letting it grow.
it("does not ask a peer for a live message it already holds because a digest went out", async () => {
  // Both sides hold, and have claimed, the same 30 rows.
  for (let l = 1; l <= 30; l++) s.rows.set(row(l).id, row(l));
  for (const l of [30, 28, 29]) s.watermarks.set(`${ROOM}|${row(l).senderId}`, l);
  // Any routine digest: here the fan-out after a completed sync elsewhere.
  send("peer2", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.waitFor(() => expect(s.frames.some((f) => f.peer === "peer1")).toBe(true));
  // A live message from b (lamport 31) lands while that digest's hold runs.
  send("peer2", { ...row(31), roomCode: undefined });
  await vi.waitFor(() => expect(s.rows.has(row(31).id)).toBe(true));
  // peer1 has it too and says so. We hold everything peer1 has.
  s.frames = [];
  send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM,
    watermarks: { [SENDERS[0]]: 30, [SENDERS[1]]: 31, [SENDERS[2]]: 29 } });
  await new Promise((r) => setTimeout(r, 30));
  const asked = s.frames.filter((f) => f.peer === "peer1" && f.frame.type === MessageType.SyncDigest)
    .map((f) => f.frame.watermarks[SENDERS[1]]);
  // Nothing to ask peer1 for: we must not ask it to re-send b's row 31.
  expect(asked.filter((b: number) => b < 31)).toEqual([]);
});

it("control: with no digest out beforehand, the same exchange asks for nothing", async () => {
  for (let l = 1; l <= 30; l++) s.rows.set(row(l).id, row(l));
  for (const l of [30, 28, 29]) s.watermarks.set(`${ROOM}|${row(l).senderId}`, l);
  // Let any hold from the test above run out.
  await new Promise((r) => setTimeout(r, 0));
  s.holds.clear();
  send("peer2", { ...row(31), roomCode: undefined });
  await vi.waitFor(() => expect(s.rows.has(row(31).id)).toBe(true));
  s.frames = [];
  send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM,
    watermarks: { [SENDERS[0]]: 30, [SENDERS[1]]: 31, [SENDERS[2]]: 29 } });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.frames.filter((f) => f.peer === "peer1" && f.frame.type === MessageType.SyncDigest)).toEqual([]);
});

it("writes a held live message's claim as soon as the peer it asked says no push is coming", async () => {
  for (let l = 1; l <= 30; l++) s.rows.set(row(l).id, row(l));
  for (const l of [30, 28, 29]) s.watermarks.set(`${ROOM}|${row(l).senderId}`, l);
  const b = row(31).senderId;
  send("peer2", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.waitFor(() => expect(s.frames.some((f) =>
    f.peer === "peer1" && f.frame.type === MessageType.SyncDigest)).toBe(true));
  send("peer2", { ...row(31), roomCode: undefined });
  await vi.waitFor(() => expect(s.holds.get(ROOM)?.get(b)).toBe(31));
  // Held: the digest to peer1 might still bring a push.
  expect(s.watermarks.get(`${ROOM}|${b}`)).toBe(28);
  // peer1 has nothing to send. The claim lands now, not when the wait runs out.
  send("peer1", { type: MessageType.SyncNone, roomCode: ROOM });
  await vi.waitFor(() => expect(s.watermarks.get(`${ROOM}|${b}`)).toBe(31), { timeout: 1_000 });
  expect(s.holds.has(ROOM)).toBe(false);
});

it("ends no hold on a SyncNone from a peer it did not ask", async () => {
  for (let l = 1; l <= 30; l++) s.rows.set(row(l).id, row(l));
  for (const l of [30, 28, 29]) s.watermarks.set(`${ROOM}|${row(l).senderId}`, l);
  const b = row(31).senderId;
  send("peer2", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.waitFor(() => expect(s.frames.some((f) =>
    f.peer === "peer1" && f.frame.type === MessageType.SyncDigest)).toBe(true));
  send("peer2", { ...row(31), roomCode: undefined });
  await vi.waitFor(() => expect(s.holds.get(ROOM)?.get(b)).toBe(31));
  // peer2 was not asked: its word says nothing about peer1's push.
  send("peer2", { type: MessageType.SyncNone, roomCode: ROOM });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.watermarks.get(`${ROOM}|${b}`)).toBe(28);
  expect(s.holds.has(ROOM)).toBe(true);
  // Clean up for the next test: peer1 answers.
  send("peer1", { type: MessageType.SyncNone, roomCode: ROOM });
  await vi.waitFor(() => expect(s.holds.has(ROOM)).toBe(false));
});
