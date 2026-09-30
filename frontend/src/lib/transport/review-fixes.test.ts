import { beforeEach, expect, it, vi } from "vitest";
import { MessageType, type WireProfile } from "$lib/types/message";

const s = vi.hoisted(() => ({
  session: { did: "did:alice" } as { did: string } | null,
  locks: [] as (() => void)[], handlers: new Map<string, Function>(),
  profile: vi.fn(async (): Promise<any> => ({ nickname: "Alice" })),
  roomProfile: vi.fn(async (room: string): Promise<any> => ({ fields: { nickname: room === "rd2_room" ? "A" : "B" } })),
  direct: vi.fn(async (_peer: string, _frame: Uint8Array) => true),
  leaveRoom: vi.fn(),
  roomSend: vi.fn(async (_peer: string, _room: string, _frame: Uint8Array) => true),
  roomPeer: "peer1",
  peerRoomRows: new Map<string, any[]>(), roomWrites: vi.fn(async (_room: string, _generation: number, _profile: any) => {}),
  joined: true,
  lamport: vi.fn(async () => 1), put: vi.fn(async (_m: any, guard?: () => void) => { guard?.(); }),
  watermark: vi.fn(async (_r: string, _s: string, _l: number, guard?: () => void) => { guard?.(); }),
  sign: vi.fn((m: any) => m), broadcast: vi.fn(), reset: vi.fn(), disconnect: vi.fn(),
  rows: new Map<string, any>(), attachments: [] as any[], read: null as Promise<any[]> | null,
}));
vi.mock("$lib/identity/identity", () => ({
  requireSession: () => { if (!s.session) throw new Error("Locked"); return s.session; },
  onIdentityLock: (fn: () => void) => { s.locks.push(fn); return () => {}; },
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:alice" } }));
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {
  on(event: string, fn: Function) { s.handlers.set(event, fn); }
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room", "rd2_b", "dm-peer"]; }
  peers() { return []; } peersInRoom(room: string) { return room === "dm-peer" ? [] : [s.roomPeer]; }
  isRoomPeer(room: string, peer: string) { return room !== "dm-peer" && peer === s.roomPeer; }
  isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
  send = s.direct; sendRoom = s.roomSend;
  leaveRoom = s.leaveRoom;
  broadcast = s.broadcast; disconnect = s.disconnect;
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
  on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers = s.reset;
  onPeerDisconnect() {}
} }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: s.profile, nextMessageLamport: s.lamport, putMessage: s.put,
  getPeerProfile: async () => undefined, putPeerProfile: async () => {},
  updateParticipantLastSeen: async () => {},
  getOwnRoomProfile: s.roomProfile,
  getAllPeerRoomProfiles: async (room: string) => s.peerRoomRows.get(room) ?? [],
  putPeerRoomProfile: s.roomWrites,
  getRoom: async (room: string) => s.joined ? ({ roomCode: room, type: "text", createdAt: 1 }) : undefined,
  setWatermark: s.watermark, markRoomSeen: vi.fn(async () => {}),
  getAttachmentsWithData: () => s.read ?? Promise.resolve(s.attachments),
  getMessage: async (id: string) => s.rows.get(id),
  messageClearFieldsByIds: async () => new Map([...s.rows].map(([id, m]) => [id, { roomCode: m.roomCode, senderId: m.senderId }])),
  bulkPutMessages: async (rows: any[], guard: () => void) => { guard(); rows.forEach(m => s.rows.set(m.id, m)); },
  getAttachmentsByMessage: async (id: string) => s.attachments.filter(a => a.messageId === id),
  putAttachment: async (a: any, guard: () => void) => { guard(); s.attachments.push(a); },
}));
vi.mock("$lib/messaging", () => ({ signMessage: s.sign, signPeerBinding: () => ({ bindingSig: "sig" }), verifyPeerBinding: async () => true }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, roomsStore: { rooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ dmConversationCodeAsync: async () => "dm-peer", ensureDmRoomForPeer: async () => "dm-peer", dmPeerDid: () => "did:peer", flushQueuedDmForPeer: async () => {} }));
vi.mock("./verify-incoming", async original => ({ ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }) }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { sendMessage, sendCard, sendUpdate, transportState, deliverMailboxBatch, peerIdToDid, forgetSyncedRoom } from "./transport.svelte";
import { roomsStore } from "$lib/rooms.svelte";
import { encode, decode } from "$lib/utils";
import { hydrateLegacyAttachments } from "./files.svelte";
import { ensureMessageAttachmentOwnership } from "./attachment-ownership";

beforeEach(() => {
  vi.clearAllMocks(); s.session = { did: "did:alice" }; s.rows.clear(); s.attachments = []; s.read = null;
  s.roomPeer = "peer1";
  s.joined = true;
  s.peerRoomRows.clear(); transportState.peerRoomProfiles = new Map();
  s.profile.mockResolvedValue({ nickname: "Alice" }); s.lamport.mockResolvedValue(1);
  transportState.roomCode = "rd2_room"; transportState.chatMode = "room";
  transportState.messages = []; transportState.fileTransfers = new Map();
});

it("does not republish a scoped profile after a failed write or a concurrent leave", async () => {
  const onMessage = s.handlers.get("message")!;
  const frame = encode({ type: MessageType.Profile, roomScoped: true, name: "Room",
    did: "did:peer", peerId: "peer1", bindingSig: "sig", avatarUrl: null });
  s.roomWrites.mockRejectedValueOnce(new Error("left"));
  onMessage("peer1", frame, "rd2_room");
  await vi.waitFor(() => expect(s.roomWrites).toHaveBeenCalledTimes(1));
  expect(peerIdToDid("peer1")).toBe("did:peer");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(transportState.peerRoomProfiles.get("rd2_room")?.has("did:peer")).not.toBe(true);
  let finish!: () => void;
  s.roomWrites.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  onMessage("peer1", frame, "rd2_room");
  await vi.waitFor(() => expect(s.roomWrites).toHaveBeenCalledTimes(2));
  s.joined = false;
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(transportState.peerRoomProfiles.get("rd2_room")?.has("did:peer")).not.toBe(true);
});

it("forgets a remotely deleted room from the live subscription and reactive profile cache", () => {
  roomsStore.rooms = [{ roomCode: "rd2_room" } as any];
  transportState.roomCode = "rd2_room";
  transportState.peerRoomProfiles = new Map([["rd2_room", new Map([["did:peer", { nickname: "Room" } as any]])]]);
  forgetSyncedRoom("rd2_room");
  expect(s.leaveRoom).toHaveBeenCalledWith("rd2_room");
  expect(roomsStore.rooms).toEqual([]);
  expect(transportState.roomCode).toBeNull();
  expect(transportState.peerRoomProfiles.has("rd2_room")).toBe(false);
});

it("keeps marked profiles in their authenticated room and leaves the main profile intact", async () => {
  const onMessage = s.handlers.get("message")!;
  const frame = (name: string, scoped = true) => encode({ type: MessageType.Profile, name,
    did: "did:peer", peerId: "peer1", bindingSig: "sig", avatarUrl: null,
    ...(scoped ? { roomScoped: true } : {}) });
  onMessage("peer1", frame("Main", false), "rd2_room");
  await vi.waitFor(() => expect(transportState.peerNames.get("did:peer")).toBe("Main"));
  onMessage("peer1", frame("A"), "rd2_room");
  onMessage("peer1", frame("B"), "rd2_b");
  await vi.waitFor(() => expect(transportState.peerRoomProfiles.get("rd2_b")?.get("did:peer")?.nickname).toBe("B"));
  expect(transportState.peerRoomProfiles.get("rd2_room")?.get("did:peer")?.nickname).toBe("A");
  expect(transportState.peerNames.get("did:peer")).toBe("Main");
  expect(s.roomWrites.mock.calls.map(([room, , p]) => [room, p.nickname])).toEqual([["rd2_room", "A"], ["rd2_b", "B"]]);
  onMessage("peer1", frame("Unjoined"), "rd2_other");
  onMessage("peer1", frame("Direct"), null);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(s.roomWrites).toHaveBeenCalledTimes(2);
  expect(transportState.peerNames.get("did:peer")).toBe("Main");
});

it("sends scoped profiles after support first arrives in a main reply, without leaking to a DM", async () => {
  const onMessage = s.handlers.get("message")!;
  onMessage("peer1", encode({ type: MessageType.Profile, name: "Peer", did: "did:peer", avatarUrl: null,
    peerId: "peer1", bindingSig: "sig", reply: true, roomProfilesSupported: true }), "rd2_room");
  await vi.waitFor(() => expect(s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as WireProfile).roomScoped === true)).toHaveLength(2));
  const scoped = s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as WireProfile).roomScoped === true)
    .map(([, room, frame]) => [room, (decode(frame) as WireProfile).name]);
  expect(scoped).toEqual([["rd2_room", "A"], ["rd2_b", "B"]]);
  expect(s.roomSend.mock.calls.some(([, room, frame]) => room === "dm-peer" && (decode(frame) as WireProfile).roomScoped === true)).toBe(false);
  s.roomProfile.mockResolvedValue({ fields: {} });
  s.profile.mockResolvedValue({ nickname: "Shared" });
  onMessage("peer1", encode({ type: MessageType.Profile, name: "Peer", did: "did:peer", avatarUrl: null,
    peerId: "peer1", bindingSig: "sig", roomProfilesSupported: true }), "rd2_room");
  await vi.waitFor(() => expect(s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as WireProfile).roomScoped === true)).toHaveLength(4));
  expect(s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as WireProfile).roomScoped === true).slice(2)
    .map(([, room, frame]) => [room, (decode(frame) as WireProfile).name])).toEqual([["rd2_room", "Shared"], ["rd2_b", "Shared"]]);
});

it("does not reuse support after a peer disconnects and returns with an old main frame", async () => {
  s.roomPeer = "peer2";
  const onMessage = s.handlers.get("message")!;
  const main = (supported: boolean) => encode({ type: MessageType.Profile, name: "Peer", did: "did:peer", avatarUrl: null,
    peerId: "peer2", bindingSig: "sig", reply: supported, ...(supported ? { roomProfilesSupported: true } : {}) });
  onMessage("peer2", main(true), "rd2_room");
  await vi.waitFor(() => expect(s.roomSend.mock.calls.filter(([, , frame]) => (decode(frame) as WireProfile).roomScoped === true)).toHaveLength(2));
  s.handlers.get("disconnect")!("peer2");
  s.roomSend.mockClear();
  onMessage("peer2", main(false), "rd2_room");
  await vi.waitFor(() => expect(s.roomSend).toHaveBeenCalled());
  expect(s.roomSend.mock.calls.every(([, , frame]) => (decode(frame) as WireProfile).roomScoped !== true)).toBe(true);
});

const sends = [() => sendMessage("secret"), () => sendCard("poll", {}),
  () => sendUpdate("poll", "card", {}), () => sendUpdate("poll", "card", {}, { ephemeral: true })];
it.each(sends.map((send, i) => [i, send] as const))("rejects stale outgoing operation %s after a profile lookup", async (_i, send) => {
  let finish!: (v: any) => void;
  s.profile.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const pending = send();
  s.session = { did: "did:alice" }; // same DID, different unlock
  finish({ nickname: "Alice" });
  await expect(pending).rejects.toThrow("Identity changed");
  expect(s.sign).not.toHaveBeenCalled(); expect(s.put).not.toHaveBeenCalled();
  expect(s.broadcast).not.toHaveBeenCalled(); expect(transportState.messages).toEqual([]);
});

it("ordinary identity lock revokes published URLs and invalidates an in-flight archive read", async () => {
  const url = URL.createObjectURL(new Blob(["secret"]));
  transportState.fileTransfers.set("old", { blobURL: url } as any);
  transportState.messages = [{ content: "secret" } as any];
  let finish!: (rows: any[]) => void;
  s.read = new Promise(r => { finish = r; });
  const pending = hydrateLegacyAttachments("old-room");
  s.session = null; s.locks.forEach(fn => fn());
  s.session = { did: "did:alice" };
  finish([{ roomCode: "old-room", infoHash: "late", data: new ArrayBuffer(1) }]);
  await pending;
  await expect(fetch(url)).rejects.toThrow();
  expect(s.reset).toHaveBeenCalledOnce(); expect(s.disconnect).toHaveBeenCalledOnce();
  expect(transportState.messages).toEqual([]); expect(transportState.fileTransfers.size).toBe(0);
});

it("reconciles encrypted non-inline files from the stored descriptor and heals partial ownership", async () => {
  const encryption = { version: 1, key: "protected" };
  const file = { infoHash: "cipher-hash", filename: "image.png", size: 3, mimeType: "image/png", encryption };
  s.rows.set("batch", { id: "batch", roomCode: "dm-peer", type: MessageType.File, timestamp: 1,
    meta: { files: [file, { ...file, infoHash: "second" }] } });
  s.attachments = [{ messageId: "batch", roomCode: "dm-peer", infoHash: "second" }];
  await ensureMessageAttachmentOwnership("batch", () => {});
  await ensureMessageAttachmentOwnership("batch", () => {});
  expect(s.attachments).toHaveLength(2);
  expect(s.attachments.find(a => a.infoHash === "cipher-hash")).toMatchObject({ roomCode: "dm-peer", encryption });
});

it("mailbox batch receipt creates ownership and duplicate repair uses the held descriptor", async () => {
  const file = { infoHash: "a".repeat(40), filename: "image.png", size: 3, mimeType: "image/png",
    encryption: { version: 2, key: "A".repeat(43), id: "A".repeat(22), size: 3, chunkSize: 1048576 } };
  const message = { id: "incoming", senderId: "did:peer", senderName: "Peer", type: MessageType.File,
    content: "", lamport: 1, timestamp: 1, meta: { files: [file] }, sig: "signed", sigV: 3 };
  const batch = (m: any) => encode({ type: MessageType.SyncBatch, roomCode: "dm-peer", messages: [m], batchIndex: 0, totalBatches: 1 });
  await deliverMailboxBatch("did:peer", batch(message));
  expect(s.attachments).toHaveLength(1);
  expect(s.attachments[0]).toMatchObject({ messageId: "incoming", roomCode: "dm-peer", encryption: file.encryption });
  s.attachments = [];
  await deliverMailboxBatch("did:peer", batch({ ...message, meta: { files: [{ ...file, filename: "replacement" }] } }));
  expect(s.attachments).toHaveLength(1);
  expect(s.attachments[0].filename).toBe("image.png");
});
