import { beforeEach, expect, it, vi } from "vitest";
import { MessageType, type Message } from "$lib/types/message";

// The transport halves of the chat list's fixes: load-older when the view
// was cut above where the read began, and a room profile frame that repeats
// what is known. The harness is review-fixes.test.ts's: this module builds
// a libp2p node when it is imported, so everything it talks to is a fake.

const s = vi.hoisted(() => ({
  session: { did: "did:alice" } as { did: string } | null,
  handlers: new Map<string, Function>(),
  roomWrites: vi.fn(async (_room: string, _generation: number, _profile: unknown) => {}),
  roomPeer: "peer1",
  page: vi.fn(
    async (_room: string, _before: unknown, _page?: { capped: boolean }): Promise<unknown[]> => []
  ),
}));
vi.mock("$lib/identity/identity", () => ({
  requireSession: () => { if (!s.session) throw new Error("Locked"); return s.session; },
  onIdentityLock: () => () => {},
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room", "rd2_b", "dm-peer"]; }
  peers() { return []; } peersInRoom(room: string) { return room === "dm-peer" ? [] : [s.roomPeer]; }
  isRoomPeer(room: string, peer: string) { return room !== "dm-peer" && peer === s.roomPeer; }
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
  on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers = vi.fn();
  onPeerDisconnect() {}
} }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: async () => ({ nickname: "Alice" }), nextMessageLamport: async () => 1,
  putMessage: async () => {}, getPeerProfile: async () => undefined, putPeerProfile: async () => {},
  updateParticipantLastSeen: async () => {},
  getOwnRoomProfile: async () => ({ fields: {} }),
  getAllPeerRoomProfiles: async () => [],
  putPeerRoomProfile: s.roomWrites,
  getRoom: async (room: string) => ({ roomCode: room, type: "text", createdAt: 1 }),
  setWatermark: async () => {}, markRoomSeen: vi.fn(async () => {}),
  getMessage: async () => undefined,
  getMessages: s.page,
  getDeletedFloor: async () => 0, addRoomParticipants: async () => {}, MAX_ROOM_PARTICIPANTS: 512,
  deletePeerRoomProfile: async () => {},
}));
vi.mock("$lib/messaging", () => ({ signMessage: (m: unknown) => m, signPeerBinding: () => ({ bindingSig: "sig" }), verifyPeerBinding: async () => true }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, refreshDmRooms: async () => {}, roomsStore: { rooms: [], dmRooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ dmConversationCodeAsync: async () => "dm-peer", ensureDmRoomForPeer: async () => "dm-peer", dmPeerDid: () => "did:peer", flushQueuedDmForPeer: async () => {}, isDmRequestRoom: () => false, offerDmUpgrade: () => {} }));
vi.mock("./verify-incoming", async original => ({ ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }) }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { loadMoreMessages, transportState } from "./transport.svelte";
import { encode } from "$lib/utils";

function row(lamport: number): Message {
  return {
    id: `m${String(lamport).padStart(4, "0")}`,
    roomCode: "rd2_room",
    senderId: "did:peer",
    senderName: "Peer",
    timestamp: lamport,
    lamport,
    type: MessageType.Text,
    content: `message ${lamport}`,
    attachments: [],
  };
}

const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(from + i));

beforeEach(() => {
  vi.clearAllMocks();
  s.session = { did: "did:alice" };
  s.roomPeer = "peer1";
  transportState.roomCode = "rd2_room";
  transportState.chatMode = "room";
  transportState.messages = rows(100, 150);
  transportState.peerRoomProfiles = new Map();
});

it("puts an older page under the view's floor, and says whether more is stored", async () => {
  s.page.mockImplementationOnce(async (_room, _before, page) => {
    page!.capped = true;
    return rows(50, 100);
  });
  expect(await loadMoreMessages(transportState.messages[0])).toBe(true);
  expect(transportState.messages.map((m) => m.lamport)).toEqual(rows(50, 150).map((m) => m.lamport));
});

// ChatView lets go of held rows while the page is read; the page would sit
// under a gap. It stays in storage, and the answer is that there is more:
// "no more" hid load-older for the rest of the visit.
it("merges nothing, and says more is stored, when the view was cut above where the read began", async () => {
  const start = transportState.messages[0];
  s.page.mockImplementationOnce(async (_room, _before, page) => {
    transportState.messages = transportState.messages.slice(20);
    page!.capped = false;
    return rows(80, 100);
  });
  expect(await loadMoreMessages(start)).toBe(true);
  expect(transportState.messages.map((m) => m.lamport)).toEqual(rows(120, 150).map((m) => m.lamport));
});

// Every peer sends one on each connect and room switch; a new map re-ran
// every name and avatar in the room on screen.
it("replaces no room profile map for a scoped frame that repeats what is known", async () => {
  const onMessage = s.handlers.get("message")!;
  const frame = (name: string) => encode({ type: MessageType.Profile, roomScoped: true, name,
    did: "did:peer", peerId: "peer1", bindingSig: "sig", avatarUrl: null });
  onMessage("peer1", frame("Room"), "rd2_room");
  await vi.waitFor(() =>
    expect(transportState.peerRoomProfiles.get("rd2_room")?.get("did:peer")?.nickname).toBe("Room"));
  const known = transportState.peerRoomProfiles;

  onMessage("peer1", frame("Room"), "rd2_room");
  await vi.waitFor(() => expect(s.roomWrites).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Stored all the same; nothing on screen is told it changed.
  expect(transportState.peerRoomProfiles).toBe(known);

  onMessage("peer1", frame("Renamed"), "rd2_room");
  await vi.waitFor(() =>
    expect(transportState.peerRoomProfiles.get("rd2_room")?.get("did:peer")?.nickname).toBe("Renamed"));
  expect(transportState.peerRoomProfiles).not.toBe(known);
});
