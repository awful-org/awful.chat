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
  s.refuse = () => false;
  s.roomPeers = ["peer1", "peer2"];
  _resetSyncThrottle();
  _resetSyncProgress();
  transportState.roomCode = "rd2_elsewhere";
  transportState.messages = [];
  _peerIdToDid.set("peer1", "did:key:peer1");
  _peerIdToDid.set("peer2", "did:key:peer2");
});
afterEach(() => vi.useRealTimers());

// A current build's push into a ROOM (not a DM), cut off after its head and
// the first three "asc" batches - a phone backgrounded mid-sync, a peer that
// closed its tab. sync-inbound.ts is meant to claim the "asc" prefix as it
// lands, and to keep no per-peer claims for a paced pusher.
it("a current build's room push claims its asc prefix as it lands", async () => {
  vi.useFakeTimers();
  const history = Array.from({ length: 200 }, (_, i) => row(i + 1));
  const batches = planPush(history, { batchSize: 20, pageSize: 50, maxBatchBytes: 1_500_000, sizeOf: () => 512 });
  expect(batches.map((b) => b.order)).toEqual(["head", "head", "head", ...Array(8).fill("asc")]);
  // Head (3 batches, rows 151..200) and asc batches 0..2 (rows 1..60) arrive.
  for (let i = 0; i < 6; i++) {
    send("peer1", { type: MessageType.SyncBatch, roomCode: ROOM, batchIndex: i,
      totalBatches: batches.length, order: batches[i].order, messages: batches[i].rows });
  }
  await vi.advanceTimersByTimeAsync(50);
  expect(s.rows.size).toBe(110);
  // Rows 1..60 arrived oldest first with nothing missing below them.
  expect(SENDERS.map(mark)).toEqual([60, 58, 59]);
});

it("a current build's cut-off room push leaves no per-peer claims that hide the undelivered rows", async () => {
  vi.useFakeTimers();
  const history = Array.from({ length: 200 }, (_, i) => row(i + 1));
  const batches = planPush(history, { batchSize: 20, pageSize: 50, maxBatchBytes: 1_500_000, sizeOf: () => 512 });
  for (let i = 0; i < 6; i++) {
    send("peer1", { type: MessageType.SyncBatch, roomCode: ROOM, batchIndex: i,
      totalBatches: batches.length, order: batches[i].order, messages: batches[i].rows });
  }
  await vi.advanceTimersByTimeAsync(50);
  // The push stalls.
  await vi.advanceTimersByTimeAsync(21_000);
  // Any completed sync elsewhere fans a digest out to peer1.
  send("peer2", { type: MessageType.SyncComplete, roomCode: ROOM });
  await vi.advanceTimersByTimeAsync(50);
  const toPeer1 = s.frames.filter((f) => f.peer === "peer1" && f.frame.type === MessageType.SyncDigest);
  expect(toPeer1.length).toBeGreaterThan(0);
  const advertised = toPeer1.at(-1)!.frame.watermarks as Record<string, number>;
  // peer1 must still be asked for rows 61..150, which it never delivered:
  // nothing advertised to it may sit above the delivered asc prefix.
  expect(Math.max(-1, ...Object.values(advertised))).toBeLessThanOrEqual(60);
});

