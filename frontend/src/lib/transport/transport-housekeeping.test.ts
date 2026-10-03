import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// What the transport only does in a browser: the repair tick and the resync
// on coming back online. A stand-in window makes the module set both up, and
// only setInterval is faked, so storage still runs on its own timers.
const s = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = new EventTarget();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  return {
    session: null as UnlockedSession | null,
    identity: { did: null as string | null, isUnlocked: true },
    handlers: new Map<string, Function>(),
    joined: new Set<string>(),
    roomPeers: new Map<string, Set<string>>(),
    broadcasts: [] as { room: string; data: Uint8Array }[],
  };
});

vi.mock("$lib/identity/identity", async (original) => ({
  ...(await original<typeof import("$lib/identity/identity")>()),
  requireSession: () => {
    if (!s.session) throw new Error("Locked");
    return s.session;
  },
  isUnlocked: () => !!s.session,
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: s.identity }));
vi.mock("./libp2p/transport", () => ({
  LibP2PTransport: class {
    on(event: string, fn: Function) { s.handlers.set(event, fn); }
    setDmIntroduction() {}
    selfId() { return "12D3-self"; }
    rooms() { return [...s.joined]; }
    peers() { return []; }
    peersInRoom(room: string) { return [...(s.roomPeers.get(room) ?? [])]; }
    isRoomPeer(room: string, peer: string) { return !!s.roomPeers.get(room)?.has(peer); }
    isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
    async broadcast(data: Uint8Array, room: string) { s.broadcasts.push({ room, data }); }
    async sendRoom() { return true; }
    async send() { return true; }
    reconcileNow() {}
    dialNow() {}
    async checkRelayLiveness() {}
    async disconnect() {}
  },
}));
vi.mock("./ice-server-list", () => ({ refreshTurnCredentials: async () => {} }));
vi.mock("./libp2p/voice", () => ({ LibP2PVoice: class { setCallPeers() {} activePeers() { return []; } } }));
vi.mock("./mediasoup", () => ({
  MediasoupVideo: class {
    setRoomAdmission() {} setJoinSigner() {} setCallPeerAdmission() {} retryDeferredProducers() {}
  },
}));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {}, _sendWatchPresence() {} }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn(), _sendCallPresence() {}, _sendCallState() {} }));
vi.mock("./file/webtorrent", () => ({
  WebTorrentFileTransport: class {
    on() {} setLocalFileLookup() {} setSignalSender() {} resetTransfers() {} onPeerDisconnect() {}
    onPeerConnect() {} registerSeeder() {} ensureDownload() {}
  },
}));
vi.mock("../telemetry/taps", () => ({ stopTelemetryTaps: vi.fn(), installTelemetryTaps: vi.fn() }));
vi.mock("./node-lock", () => ({ releaseNodeLock: vi.fn(), acquireNodeLock: async () => {} }));
vi.mock("../plugins/registry", () => ({ getPlugin: async () => null, getManifest: () => undefined }));
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));
vi.mock("../announce", () => ({ announceMessage: vi.fn() }));
vi.mock("$lib/sounds", () => ({ playPeerJoinSound() {}, playPeerLeaveSound() {} }));
vi.mock("./mailbox.svelte", () => ({
  mailboxPrefs: { enabled: true },
  collectMailbox: async () => {},
  depositDmToMailbox: async () => "sent",
}));

import { transportState } from "./transport.svelte";
import { decode, encode } from "$lib/utils";
import { MessageType } from "$lib/types/message";
import { hashDmRoomCode } from "./dm-codec";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

const receive = (peer: string, frame: unknown, room: string | null) =>
  s.handlers.get("message")!(peer, encode(frame), room);

beforeEach(() => {
  s.session = identity();
  s.identity.did = s.session.did;
  s.joined.clear(); s.roomPeers.clear();
  s.broadcasts = [];
  Object.assign(transportState, {
    roomCode: null, chatMode: "room", activeDmPeerId: null, roomUsers: [], messages: [],
    inCall: false, callRoomCode: null, callPeerIds: new Set(), callPeerRooms: new Map(),
    transmissionViewers: new Map(),
  });
});

describe("a call member whose presence lapses leaves its audience (G01.2)", () => {
  const SELF = "12D3-self";
  const viewersOf = (sharer: string) => [...(transportState.transmissionViewers.get(sharer) ?? [])];

  it("when the repair tick drops them from the call, not only when they say so", () => {
    s.joined.add("rd2_call");
    s.roomPeers.set("rd2_call", new Set(["12D3-member"]));
    Object.assign(transportState, { inCall: true, callRoomCode: "rd2_call" });
    receive("12D3-member", { type: MessageType.CallPresence, inCall: true, roomCode: "rd2_call" }, "rd2_call");
    receive("12D3-member", { type: MessageType.WatchPresence, watching: SELF, watchingAll: [SELF] }, "rd2_call");
    expect(viewersOf(SELF)).toEqual(["12D3-member"]);

    // Their presence stops: past its time to live the tick takes them out.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
    try {
      vi.advanceTimersByTime(15_000);
    } finally {
      now.mockRestore();
    }
    expect(transportState.callPeerRooms.has("12D3-member")).toBe(false);
    expect(viewersOf(SELF)).toEqual([]);
  });
});

describe("coming back to the app sends no join over a DM (G01.1)", () => {
  const joins = () =>
    s.broadcasts.filter((b) => (decode(b.data) as { type?: string })?.type === MessageType.JoinRoom);

  it("with a DM open, and still for a room", async () => {
    const dm = await hashDmRoomCode(s.session!.did, identity().did);
    Object.assign(transportState, { roomCode: dm, chatMode: "dm" });
    window.dispatchEvent(new Event("online"));
    expect(joins()).toEqual([]);

    Object.assign(transportState, { roomCode: "rd2_room", chatMode: "room" });
    window.dispatchEvent(new Event("online"));
    expect(joins().map((b) => b.room)).toEqual(["rd2_room"]);
  });
});
