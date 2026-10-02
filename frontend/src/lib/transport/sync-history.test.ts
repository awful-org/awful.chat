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
import { planPush } from "./sync-push";
import { observedLamport } from "./logical-clock";

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
const mark = (sender: string) => s.watermarks.get(`${ROOM}|${sender}`) ?? -1;

beforeEach(() => {
  s.rows.clear();
  s.watermarks.clear();
  s.holds.clear();
  s.frames = [];
  s.inFlight = 0;
  s.mostInFlight = 0;
  s.refuse = () => false;
  s.roomPeers = ["peer1"];
  s.pushReads = 0;
  _resetSyncThrottle();
  _resetSyncProgress();
  transportState.roomCode = "rd2_elsewhere";
  transportState.messages = [];
});
afterEach(() => vi.useRealTimers());

it("pushes the newest page first, then the rest oldest first, one frame at a time, SyncComplete last", async () => {
  for (let l = 1; l <= 120; l++) s.rows.set(row(l).id, row(l));
  send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM, watermarks: {} });
  await vi.waitFor(() => expect(s.frames.at(-1)?.frame.type).toBe(MessageType.SyncComplete), { timeout: 5000 });
  const batches = s.frames.filter((f) => f.frame.type === MessageType.SyncBatch).map((f) => f.frame);
  expect(batches.map((b) => b.batchIndex)).toEqual(batches.map((_, i) => i));
  expect(batches.every((b) => b.totalBatches === batches.length)).toBe(true);
  const head = batches.filter((b) => b.order === "head").flatMap((b) => b.messages.map((m: any) => m.lamport));
  const asc = batches.filter((b) => b.order === "asc").flatMap((b) => b.messages.map((m: any) => m.lamport));
  expect(head).toEqual(Array.from({ length: 50 }, (_, i) => 120 - i));
  expect(asc).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  // Never more than one frame of the push handed to the channel at a time.
  expect(s.mostInFlight).toBe(1);
});

it("stops a push the channel will not take, and never claims it complete", async () => {
  for (let l = 1; l <= 100; l++) s.rows.set(row(l).id, row(l));
  s.refuse = (frame) => frame.type === MessageType.SyncBatch && frame.batchIndex === 3;
  send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM, watermarks: {} });
  await vi.waitFor(() => expect(s.frames.length).toBe(3), { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 1_500));
  expect(s.frames.map((f) => f.frame.batchIndex)).toEqual([0, 1, 2]);
  expect(s.frames.some((f) => f.frame.type === MessageType.SyncComplete)).toBe(false);
});

it("keeps a cut-off push from an older build from claiming past what it did not deliver", async () => {
  vi.useFakeTimers();
  _peerIdToDid.set("old", "did:key:old");
  _peerIdToDid.set("peer1", "did:key:peer1");
  s.roomPeers = ["old", "peer1"];
  const history = Array.from({ length: 200 }, (_, i) => row(i + 1));
  const newestFirst = [...history].reverse();
  // An older build: newest first, unmarked, and its channel let three of ten
  // batches through, with no SyncComplete.
  for (let i = 0; i < 3; i++) {
    send("old", { type: MessageType.SyncBatch, roomCode: ROOM, batchIndex: i, totalBatches: 10,
      messages: newestFirst.slice(i * 20, i * 20 + 20) });
  }
  await vi.advanceTimersByTimeAsync(10);
  expect(s.rows.size).toBe(60);
  // A live message lands meanwhile: it must not claim over the gap either.
  send("peer1", { type: MessageType.SyncBatch, roomCode: ROOM, batchIndex: 0, totalBatches: 1,
    live: true, messages: [row(201)] });
  await vi.advanceTimersByTimeAsync(10);
  expect(s.rows.has(row(201).id)).toBe(true);
  expect(SENDERS.map(mark)).toEqual([-1, -1, -1]);
  // The push stalls. Still nothing claimed.
  await vi.advanceTimersByTimeAsync(21_000);
  expect(SENDERS.map(mark)).toEqual([-1, -1, -1]);

  // A digest to the older build carries what its own short push delivered,
  // so it stops re-sending the same newest rows. Anyone else is still asked
  // for everything.
  send("peer1", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.advanceTimersByTimeAsync(10);
  const toOld = s.frames.filter((f) => f.peer === "old" && f.frame.type === MessageType.SyncDigest);
  expect(Math.max(...Object.values(toOld.at(-1)!.frame.watermarks as Record<string, number>))).toBe(200);

  // A current build answers our digest - which claims nothing yet - with the
  // whole history, and completes.
  const batches = planPush(history, { batchSize: 20, pageSize: 50, maxBatchBytes: 1_500_000, sizeOf: () => 512 });
  batches.forEach((b, i) => send("peer1", { type: MessageType.SyncBatch, roomCode: ROOM,
    batchIndex: i, totalBatches: batches.length, order: b.order, messages: b.rows }));
  send("peer1", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.advanceTimersByTimeAsync(100);
  // Every row is claimed, the ones the older build delivered included.
  expect(history.filter((m) => m.lamport > mark(m.senderId))).toEqual([]);
  // The live message's claim waited for the room to settle, then landed.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mark(row(201).senderId)).toBe(201);
});

it("answers a digest that lacks nothing without reading anything to push, or using up the push window", async () => {
  for (let l = 1; l <= 30; l++) s.rows.set(row(l).id, row(l));
  const theirs: Record<string, number> = {};
  for (const m of s.rows.values()) theirs[m.senderId] = Math.max(theirs[m.senderId] ?? -1, m.lamport);
  // Both sides hold, and have claimed, the same history.
  for (const [sender, lamport] of Object.entries(theirs)) s.watermarks.set(`${ROOM}|${sender}`, lamport);
  for (let i = 0; i < 5; i++) send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM, watermarks: theirs });
  await new Promise((r) => setTimeout(r, 20));
  expect(s.pushReads).toBe(0);
  expect(s.frames).toEqual([]);
  // The window is still there for a digest that does lack something.
  const behind = { ...theirs, [SENDERS[0]]: 0 };
  send("peer1", { type: MessageType.SyncDigest, roomCode: ROOM, watermarks: behind });
  await vi.waitFor(() => expect(s.frames.at(-1)?.frame.type).toBe(MessageType.SyncComplete));
  expect(s.pushReads).toBe(1);
});

it("takes a lamport jump as a gap only against the room's clock", async () => {
  const chat = (lamport: number) => send("peer1", { ...row(lamport), roomCode: undefined });
  const digests = () => s.frames.filter((f) => f.frame.type === MessageType.SyncDigest);
  // The room's clock is module state, already moved by the tests above.
  const base = Math.max(observedLamport(ROOM), 1);
  // A conversation: each sender's lamport jumps whenever somebody else spoke,
  // but the room's clock never does. No digest for any of it.
  for (let l = base + 1; l <= base + 9; l++) {
    chat(l);
    await vi.waitFor(() => expect(s.rows.has(row(l).id)).toBe(true));
  }
  expect(digests()).toEqual([]);
  // Something we never saw came before this one: ask, for this room.
  chat(base + 15);
  await vi.waitFor(() => expect(digests()).toHaveLength(1));
  expect(digests()[0]).toMatchObject({ peer: "peer1", frame: { roomCode: ROOM } });
});
