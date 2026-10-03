import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";

// A user in three protected rooms with the same three people in each, an
// uploaded avatar, and a transport that records every frame handed to it.
const s = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  rooms: ["rd2_a", "rd2_b", "rd2_c"],
  peers: ["p1", "p2", "p3"],
  profile: vi.fn(async (): Promise<any> => ({ nickname: "Alice", pfpData: new Uint8Array(4096).fill(7).buffer })),
  roomProfile: vi.fn(async (_room: string, _did: string): Promise<any> => undefined),
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
  addRoomParticipant: async () => {}, getRoomParticipants: async () => [],
  getOwnRoomProfile: s.roomProfile,
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
// Counted, so a frame built for nothing shows.
vi.mock("$lib/utils", async (original) => {
  const utils = await original<typeof import("$lib/utils")>();
  return { ...utils, bytesToBase64: vi.fn(utils.bytesToBase64) };
});

import { broadcastProfile, disconnectTransport } from "./transport.svelte";
import { bytesToBase64, decode, encode, sniffImageMime } from "$lib/utils";

/** Full profiles handed to the transport, by peer, oldest first. */
function profilesTo(peer?: string) {
  return s.roomSend.mock.calls
    .map(([to, room, frame]) => ({ to, room, msg: decode(frame) as Record<string, unknown> }))
    .filter(({ to, msg }) => msg.type === MessageType.Profile && !msg.roomScoped && (!peer || to === peer));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
let clock = 1_000_000;

beforeEach(async () => {
  // A broadcast is fire-and-forget and yields between copies: under a loaded
  // machine the previous case's tail can still be running. Let it land before
  // the counters are cleared, or its copies are counted here.
  await settle();
  // Date only: the broadcast's own pauses are real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock += 60_000);
  s.roomSend.mockClear(); s.broadcast.mockClear(); s.direct.mockClear();
  s.roomSend.mockImplementation(async () => true);
  s.profile.mockResolvedValue({ nickname: "Alice", pfpData: new Uint8Array(4096).fill(7).buffer });
  s.roomProfile.mockResolvedValue(undefined);
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

it("encodes an unchanged avatar once however many room clicks ask, into the same bytes as ever", async () => {
  // Fresh buffers on every read, as storage decrypts them.
  const avatar = () => new Uint8Array(4096).fill(9).buffer;
  s.profile.mockImplementation(async () => ({ nickname: "Alice C", pfpData: avatar() }));
  const base64 = vi.mocked(bytesToBase64);
  base64.mockClear();
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  for (let click = 0; click < 5; click++) {
    vi.setSystemTime(Date.now() + 60_000);
    broadcastProfile();
  }
  await settle();
  expect(profilesTo()).toHaveLength(3);
  expect(base64).toHaveBeenCalledOnce();
  const actual = await vi.importActual<typeof import("$lib/utils")>("$lib/utils");
  const bytes = new Uint8Array(avatar());
  const [, , frame] = s.roomSend.mock.calls.find(([, , f]) => (decode(f) as { type: string }).type === MessageType.Profile)!;
  expect(frame).toEqual(encode({
    type: MessageType.Profile, name: "Alice C", did: "did:alice",
    avatarUrl: `data:${sniffImageMime(bytes)};base64,${actual.bytesToBase64(bytes)}`,
    color: null, peerId: "self", bindingSig: "sig", roomProfilesSupported: true,
  }));
});

it("sends members the relay lists again nothing they hold, and one it lists anew our profile", async () => {
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  vi.setSystemTime(Date.now() + 60_000); // past the burst window
  // A rendezvous reconnect: every room's members, listed again.
  for (const room of s.rooms) s.handlers.get("roomPeers")!(room, s.peers);
  await settle();
  expect(profilesTo()).toHaveLength(3);
  s.peers.push("p4");
  try {
    s.handlers.get("roomPeers")!("rd2_a", ["p4"]);
    await vi.waitFor(() => expect(profilesTo("p4")).toHaveLength(1));
  } finally {
    s.peers.pop();
    s.handlers.get("disconnect")!("p4");
  }
  expect(profilesTo()).toHaveLength(4);
});

/** Times our 4096-byte avatar was base64'd into a frame. */
const avatarEncodes = () => vi.mocked(bytesToBase64).mock.calls.filter(([bytes]) => bytes.length === 4096).length;

it("encodes nothing on a room click however many rooms have a profile of their own", async () => {
  s.rooms.push("rd2_d", "rd2_e", "rd2_f");
  try {
    // Fresh buffers on every read, as storage decrypts them, and a nickname of its own in every room.
    s.profile.mockImplementation(async () => ({ nickname: "Alice D", pfpData: new Uint8Array(4096).fill(3).buffer }));
    s.roomProfile.mockImplementation(async (room: string) => ({ fields: { nickname: `Alice in ${room}` } }));
    vi.mocked(bytesToBase64).mockClear();
    // p1 introduces itself as taking room profiles: the reply carries ours and each room's.
    s.handlers.get("message")!("p1", encode({ type: MessageType.Profile, name: "Bob", did: "did:bob",
      peerId: "p1", bindingSig: "sig", avatarUrl: null, roomProfilesSupported: true }), "rd2_a");
    const scoped = () => s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as { roomScoped?: boolean }).roomScoped);
    await vi.waitFor(() => expect(scoped()).toHaveLength(6));
    expect(avatarEncodes()).toBe(1);
    for (let click = 0; click < 5; click++) {
      vi.setSystemTime(Date.now() + 60_000);
      broadcastProfile();
    }
    await settle();
    // A click asks for the main frame and six rooms' own. Only four were
    // kept, so each pushed out the next one asked for and all were built
    // again, avatar and all, on every click.
    expect(avatarEncodes()).toBe(1);
    expect(scoped()).toHaveLength(6);
  } finally {
    s.rooms.splice(3);
  }
});

it("forgets the frames it encoded, and who was delivered them, when the session ends", async () => {
  s.profile.mockImplementation(async () => ({ nickname: "Alice E", pfpData: new Uint8Array(4096).fill(4).buffer }));
  vi.mocked(bytesToBase64).mockClear();
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(3));
  expect(avatarEncodes()).toBe(1);
  // A lock runs the same teardown. Our decrypted avatar lived on in the frame.
  disconnectTransport();
  vi.setSystemTime(Date.now() + 60_000);
  broadcastProfile();
  await vi.waitFor(() => expect(profilesTo()).toHaveLength(6));
  expect(avatarEncodes()).toBe(2);
});

it("keeps nothing it encoded after a lock that landed while it read a room's profile", async () => {
  s.profile.mockImplementation(async () => ({ nickname: "Alice F", pfpData: new Uint8Array(4096).fill(5).buffer }));
  // rd2_a has an avatar of its own, read - and decrypted - fresh every time.
  let lockDuringRead = true;
  s.roomProfile.mockImplementation(async (room: string) => {
    if (room !== "rd2_a") return undefined;
    if (lockDuringRead) {
      lockDuringRead = false;
      disconnectTransport();
    }
    return { fields: { pfpData: new Uint8Array(2048).fill(6).buffer } };
  });
  const roomAvatarEncodes = () => vi.mocked(bytesToBase64).mock.calls.filter(([bytes]) => bytes.length === 2048).length;
  vi.mocked(bytesToBase64).mockClear();
  const introduce = () => s.handlers.get("message")!("p1", encode({ type: MessageType.Profile, name: "Bob",
    did: "did:bob", peerId: "p1", bindingSig: "sig", avatarUrl: null, roomProfilesSupported: true }), "rd2_a");
  const toRoomA = () => s.roomSend.mock.calls.filter(([, room, frame]) =>
    room === "rd2_a" && (decode(frame) as { roomScoped?: boolean }).roomScoped);
  introduce();
  await vi.waitFor(() => expect(toRoomA()).toHaveLength(1));
  expect(roomAvatarEncodes()).toBe(1);
  // The next session asks for the same frame: it is built from what that
  // session reads, not found kept from the call the lock interrupted.
  vi.setSystemTime(Date.now() + 60_000);
  introduce();
  await vi.waitFor(() => expect(toRoomA()).toHaveLength(2));
  expect(roomAvatarEncodes()).toBe(2);
});
