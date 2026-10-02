import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";

// A user in three protected rooms with the same three people in each, an
// uploaded avatar, and a transport that records every frame handed to it.
const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rooms: ["rd2_a", "rd2_b", "rd2_c"],
  peers: ["p1", "p2", "p3"],
  profile: vi.fn(async (): Promise<any> => ({ nickname: "Alice", pfpData: new Uint8Array(4096).fill(7).buffer })),
  roomSend: vi.fn(async (_peer: string, _room: string, _frame: Uint8Array) => true),
  broadcast: vi.fn(async (_frame: Uint8Array, _room: string) => {}),
  direct: vi.fn(async (_peer: string, _frame: Uint8Array) => true),
}));
vi.mock("$lib/identity/identity", () => ({
  requireSession: () => ({ did: "did:alice" }),
  onIdentityLock: () => () => {},
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return s.rooms; }
  peers() { return s.peers; } peersInRoom() { return s.peers; }
  isRoomPeer(_room: string, peer: string) { return s.peers.includes(peer); }
  isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
  send = s.direct; sendRoom = s.roomSend; broadcast = s.broadcast;
  leaveRoom() {} disconnect() {}
} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class { setCallPeers() {} } }));
vi.mock("./mediasoup", () => ({ MediasoupVideo: class {
  setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {}
} }));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./mailbox.svelte", () => ({ mailboxPrefs: { enabled: true } }));
vi.mock("./file/webtorrent", () => ({ WebTorrentFileTransport: class {
  on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers() {} onPeerDisconnect() {}
} }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: s.profile,
  getPeerProfile: async () => undefined, putPeerProfile: async () => {},
  updateParticipantLastSeen: async () => {}, addRoomParticipants: async () => {},
  getOwnRoomProfile: async () => undefined,
  getRoom: async (room: string) => ({ roomCode: room, type: "text", createdAt: 1 }),
  MAX_ROOM_PARTICIPANTS: 512,
}));
vi.mock("$lib/messaging", () => ({ signPeerBinding: () => ({ bindingSig: "sig" }), verifyPeerBinding: async () => true }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, refreshDmRooms: async () => {}, roomsStore: { rooms: [], dmRooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ dmConversationCodeAsync: async () => "dm-peer", ensureDmRoomForPeer: async () => "dm-peer", dmPeerDid: () => "did:peer", flushQueuedDmForPeer: async () => {}, isDmRequestRoom: () => false, offerDmUpgrade: () => {} }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { broadcastProfile } from "./transport.svelte";
import { decode, encode } from "$lib/utils";

/** Full profiles handed to the transport, by peer, oldest first. */
function profilesTo(peer?: string) {
  return s.roomSend.mock.calls
    .map(([to, room, frame]) => ({ to, room, msg: decode(frame) as Record<string, unknown> }))
    .filter(({ to, msg }) => msg.type === MessageType.Profile && !msg.roomScoped && (!peer || to === peer));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
let clock = 1_000_000;

beforeEach(() => {
  // Date only: the broadcast's own pauses are real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock += 60_000);
  s.roomSend.mockClear(); s.broadcast.mockClear(); s.direct.mockClear();
  s.roomSend.mockImplementation(async () => true);
  s.profile.mockResolvedValue({ nickname: "Alice", pfpData: new Uint8Array(4096).fill(7).buffer });
  // A disconnect is what wipes a peer's record; start every case from none.
  for (const peer of s.peers) s.handlers.get("disconnect")?.(peer);
});
afterEach(() => vi.useRealTimers());

it("sends each peer one copy, over a room they share, not one per room", async () => {
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  await settle();
  expect(profilesTo().map((p) => p.to).sort()).toEqual(["p1", "p2", "p3"]);
  // The per-room broadcast sealed another copy for every member of every room.
  expect(s.broadcast).not.toHaveBeenCalled();
});

it("sends nothing on the next room click or resume when nothing changed, however long after", async () => {
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  vi.setSystemTime(Date.now() + 10 * 60_000); // far past the 5 s burst window
  broadcastProfile();
  broadcastProfile();
  await settle();
  expect(profilesTo()).toHaveLength(3);
});

it("sends a changed profile to everyone once", async () => {
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  s.profile.mockResolvedValue({ nickname: "Alice B", pfpData: new Uint8Array(4096).fill(7).buffer });
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(6));
  vi.setSystemTime(Date.now() + 60_000);
  broadcastProfile();
  await settle();
  expect(profilesTo()).toHaveLength(6);
  expect(profilesTo().slice(3).every((p) => p.msg.name === "Alice B")).toBe(true);
});

it("sends again to a peer whose copy did not go through, and to one that went away and came back", async () => {
  s.roomSend.mockImplementation(async (peer) => peer !== "p2");
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  s.roomSend.mockImplementation(async () => true);
  vi.setSystemTime(Date.now() + 60_000);
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo("p2")).toHaveLength(2));
  s.handlers.get("disconnect")!("p3");
  vi.setSystemTime(Date.now() + 60_000);
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo("p3")).toHaveLength(2));
  await settle();
  expect(profilesTo("p1")).toHaveLength(1);
});

it("counts a reply as delivered: a peer that just got ours that way is not sent it again", async () => {
  // p1 introduces itself; we answer with our profile, flagged as a reply.
  s.handlers.get("message")!("p1", encode({ type: MessageType.Profile, name: "Bob", did: "did:bob",
    peerId: "p1", bindingSig: "sig", avatarUrl: null }), "rd2_a");
  await vi.waitFor(() => expect(profilesTo("p1")).toHaveLength(1));
  expect(profilesTo("p1")[0].msg.reply).toBe(true);
  vi.setSystemTime(Date.now() + 60_000);
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  await settle();
  expect(profilesTo("p1")).toHaveLength(1);
});

it("starts the copies one at a time, letting the event loop run in between", async () => {
  let startedBeforeTheNextTask = -1;
  s.roomSend.mockImplementation(async () => {
    if (startedBeforeTheNextTask === -1) {
      startedBeforeTheNextTask = 0;
      setTimeout(() => { startedBeforeTheNextTask = profilesTo().length; }, 0);
    }
    return true;
  });
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  // All three used to be started, and sealed, in the one task that began them.
  expect(startedBeforeTheNextTask).toBe(1);
});
