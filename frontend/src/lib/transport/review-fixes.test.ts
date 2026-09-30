import { beforeEach, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";

const s = vi.hoisted(() => ({
  session: { did: "did:alice" } as { did: string } | null,
  locks: [] as (() => void)[], handlers: new Map<string, Function>(),
  profile: vi.fn(async (): Promise<any> => ({ nickname: "Alice" })),
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
  setDmIntroduction() {} selfId() { return "self"; } rooms() { return ["rd2_room", "dm-peer"]; }
  peers() { return []; } peersInRoom() { return []; }
  broadcast = s.broadcast; disconnect = s.disconnect;
} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class {} }));
vi.mock("./mediasoup", () => ({ MediasoupVideo: class {
  setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {}
} }));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./file/webtorrent", () => ({ WebTorrentFileTransport: class {
  on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers = s.reset;
} }));
vi.mock("$lib/storage", () => ({
  getOwnProfile: s.profile, nextMessageLamport: s.lamport, putMessage: s.put,
  setWatermark: s.watermark, markRoomSeen: vi.fn(async () => {}),
  getAttachmentsWithData: () => s.read ?? Promise.resolve(s.attachments),
  getMessage: async (id: string) => s.rows.get(id),
  messageClearFieldsByIds: async () => new Map([...s.rows].map(([id, m]) => [id, { roomCode: m.roomCode, senderId: m.senderId }])),
  bulkPutMessages: async (rows: any[], guard: () => void) => { guard(); rows.forEach(m => s.rows.set(m.id, m)); },
  getAttachmentsByMessage: async (id: string) => s.attachments.filter(a => a.messageId === id),
  putAttachment: async (a: any, guard: () => void) => { guard(); s.attachments.push(a); },
  getDeletedFloor: async () => 0, addRoomParticipants: async () => {},
}));
vi.mock("$lib/messaging", () => ({ signMessage: s.sign }));
vi.mock("$lib/rooms.svelte", () => ({ noteRoomActivity: vi.fn(), refreshUnreadCount: async () => {}, refreshDmRooms: async () => {}, roomsStore: { rooms: [], dmRooms: [] } }));
vi.mock("$lib/profile.svelte", () => ({ profileStore: {} }));
vi.mock("$lib/dm-panel.svelte", () => ({ appendToDmPanel: vi.fn() }));
vi.mock("./dm.svelte", () => ({ dmConversationCodeAsync: async () => "dm-peer", ensureDmRoomForPeer: async () => "dm-peer", dmPeerDid: () => "did:peer", isDmRequestRoom: () => false }));
vi.mock("./verify-incoming", async original => ({ ...await original<typeof import("./verify-incoming")>(), verifyIncoming: async () => ({ ok: true }) }));
vi.mock("../storage-crypto", () => ({ blindValue: async (v: string) => v }));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn() }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

import { sendMessage, sendCard, sendUpdate, transportState, deliverMailboxBatch } from "./transport.svelte";
import { encode } from "$lib/utils";
import { hydrateLegacyAttachments } from "./files.svelte";
import { ensureMessageAttachmentOwnership } from "./attachment-ownership";

beforeEach(() => {
  vi.clearAllMocks(); s.session = { did: "did:alice" }; s.rows.clear(); s.attachments = []; s.read = null;
  s.profile.mockResolvedValue({ nickname: "Alice" }); s.lamport.mockResolvedValue(1);
  transportState.roomCode = "rd2_room"; transportState.chatMode = "room";
  transportState.messages = []; transportState.fileTransfers = new Map();
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
