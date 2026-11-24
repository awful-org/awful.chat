import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real transport module, receiving real CallPresence frames: what reaches
// the voice layer's roster (its whole admission rule for an offer, and so for
// our microphone) is the thing under test. Same harness as
// transport-housekeeping.test.ts: a stand-in window so the repair tick that
// sweeps call ghosts is set up, with only setInterval faked.
const s = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = new EventTarget();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  return {
    identity: { did: "did:key:z6Mkself" as string | null, isUnlocked: true },
    handlers: new Map<string, Function>(),
    joined: new Set<string>(),
    roomPeers: new Map<string, Set<string>>(),
    connected: [] as string[],
    roster: [] as string[],
    dialled: [] as string[],
    producerAdmission: null as ((peerId: string) => boolean) | null,
  };
});

vi.mock("$lib/identity/identity", async (original) => {
  const real = await original<typeof import("$lib/identity/identity")>();
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  const session = { privateKey, publicKey, did: real.publicKeyToDid(publicKey) };
  return { ...real, requireSession: () => session, isUnlocked: () => true };
});
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: s.identity }));
vi.mock("./libp2p/transport", () => ({
  LibP2PTransport: class {
    on(event: string, fn: Function) { s.handlers.set(event, fn); }
    setDmIntroduction() {}
    selfId() { return "12D3-self"; }
    rooms() { return [...s.joined]; }
    peers() { return [...s.connected]; }
    peersInRoom(room: string) { return [...(s.roomPeers.get(room) ?? [])]; }
    isRoomPeer(room: string, peer: string) { return !!s.roomPeers.get(room)?.has(peer); }
    isSecureRoom(room: string) { return room.startsWith("rd2_") || room.startsWith("dm-"); }
    async broadcast() {}
    async sendRoom() { return true; }
    async send() { return true; }
    reconcileNow() {}
    dialNow(peer: string) { s.dialled.push(peer); }
    async checkRelayLiveness() {}
    disconnect() {}
  },
}));
vi.mock("./ice-server-list", () => ({ refreshTurnCredentials: async () => {} }));
vi.mock("./libp2p/voice", () => ({
  LibP2PVoice: class {
    setCallPeers(peers: Iterable<string>) { s.roster = [...peers].sort(); }
    activePeers() { return []; }
  },
}));
vi.mock("./mediasoup", () => ({
  MediasoupVideo: class {
    setRoomAdmission() {} setJoinSigner() {} retryDeferredProducers() {}
    setCallPeerAdmission(fn: (peerId: string) => boolean) { s.producerAdmission = fn; }
  },
}));
vi.mock("../audio/dtln-processor", () => ({ DtlnProcessor: class {} }));
vi.mock("./voice.svelte", () => ({ initVoice() {} }));
vi.mock("./transmission.svelte", () => ({ initTransmission() {}, _sendWatchPresence() {} }));
vi.mock("./call.svelte", () => ({
  leaveCall: vi.fn(), joinCall: vi.fn(), switchVoiceChannel: vi.fn(),
  _sendCallPresence() {}, _sendCallState() {},
}));
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
const sounds = vi.hoisted(() => ({ join: vi.fn(), leave: vi.fn() }));
vi.mock("$lib/sounds", () => ({ playPeerJoinSound: sounds.join, playPeerLeaveSound: sounds.leave }));
vi.mock("./mailbox.svelte", () => ({
  mailboxPrefs: { enabled: true },
  collectMailbox: async () => {},
  depositDmToMailbox: async () => "sent",
}));

import { isInMyCall, transportState } from "./transport.svelte";
import { peersInMyCall, voiceChannelsIn } from "./voice-channels";
import { encode } from "$lib/utils";
import { MessageType } from "$lib/types/message";

const ROOM = "rd2_room";
const OTHER_ROOM = "rd2_other";
const LOUNGE = "lounge01";
const GAMING = "gaming01";

/** A frame as the peer's client would put it on the wire. */
function presence(room: string | null, voiceChannel = "") {
  if (!room) return { type: MessageType.CallPresence, inCall: false };
  if (!voiceChannel) return { type: MessageType.CallPresence, inCall: true, roomCode: room };
  return { type: MessageType.CallPresence, inCall: true, voiceRoomCode: room, voiceChannel };
}

const receive = (peer: string, frame: unknown, over: string | null = ROOM) =>
  s.handlers.get("message")!(peer, encode(frame), over);

function inCall(room: string, voiceChannel: string) {
  Object.assign(transportState, { inCall: true, callRoomCode: room, callVoiceChannel: voiceChannel });
}

const channelsOf = (room: string) =>
  Object.fromEntries([...voiceChannelsIn(room)].map(([c, ms]) => [c, ms.map((m) => m.peerId).sort()]));

beforeEach(() => {
  s.joined = new Set([ROOM, OTHER_ROOM]);
  s.roomPeers = new Map([
    [ROOM, new Set(["12D3-alice", "12D3-bob", "12D3-carol"])],
    [OTHER_ROOM, new Set(["12D3-dave"])],
  ]);
  s.connected = ["12D3-alice", "12D3-bob", "12D3-carol", "12D3-dave"];
  s.roster = [];
  s.dialled = [];
  sounds.join.mockClear();
  sounds.leave.mockClear();
  Object.assign(transportState, {
    roomCode: ROOM, chatMode: "room", inCall: false, callRoomCode: null, callVoiceChannel: "",
    callPeerIds: new Set(), callPeerRooms: new Map(), callPeerVoiceChannels: new Map(),
    callPeerStates: new Map(), participants: new Map(), pendingTransmissions: new Map(),
    transmissionViewers: new Map(), watchingTransmissions: new Map(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two voice channels in one room do not hear each other", () => {
  it("admits to the voice roster only the peers of OUR channel", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-carol", presence(ROOM));
    expect(s.roster).toEqual(["12D3-alice"]);
    // The SFU's producer naming is held to the same rule.
    expect(isInMyCall("12D3-alice")).toBe(true);
    expect(s.producerAdmission!("12D3-alice")).toBe(true);
    expect(s.producerAdmission!("12D3-bob")).toBe(false);
    expect(s.producerAdmission!("12D3-carol")).toBe(false);
  });

  it("chimes for our channel only", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-carol", presence(ROOM));
    expect(sounds.join).not.toHaveBeenCalled();
    receive("12D3-alice", presence(ROOM, LOUNGE));
    expect(sounds.join).toHaveBeenCalledTimes(1);
  });

  it("dials past the backoff only somebody in our channel", () => {
    inCall(ROOM, LOUNGE);
    s.connected = [];
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-alice", presence(ROOM, LOUNGE));
    expect(s.dialled).toEqual(["12D3-alice"]);
  });

  it("does not count a viewer in another channel in a share's audience", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-bob", { type: MessageType.WatchPresence, watching: "12D3-self", watchingAll: ["12D3-self"] });
    receive("12D3-alice", { type: MessageType.WatchPresence, watching: "12D3-self", watchingAll: ["12D3-self"] });
    expect([...(transportState.transmissionViewers.get("12D3-self") ?? [])]).toEqual(["12D3-alice"]);
  });
});

describe("the default channel, as old clients and DMs know it", () => {
  it("is the frame with no channel field, and still meets new clients there", () => {
    inCall(ROOM, "");
    receive("12D3-alice", presence(ROOM));
    expect(s.roster).toEqual(["12D3-alice"]);
    expect(transportState.callPeerRooms.get("12D3-alice")).toBe(ROOM);
    expect(transportState.callPeerVoiceChannels.get("12D3-alice")).toBe("");
  });

  it("is not a channel somebody in another channel is reached through", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM));
    expect(s.roster).toEqual([]);
  });
});

describe("moving between channels", () => {
  it("takes them out of the old channel's roster and leaves no ghost there", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-alice", { type: MessageType.WatchPresence, watching: "12D3-self", watchingAll: ["12D3-self"] });
    transportState.participants = new Map([["12D3-alice", { peerId: "12D3-alice" } as never]]);
    expect(s.roster).toEqual(["12D3-alice"]);

    receive("12D3-alice", presence(ROOM, GAMING));
    expect(s.roster).toEqual([]);
    expect(channelsOf(ROOM)).toEqual({ "": [], [LOUNGE]: ["12D3-self"], [GAMING]: ["12D3-alice"] });
    // Their tile and their place in our share's audience were the old call's.
    expect(transportState.participants.has("12D3-alice")).toBe(false);
    expect(transportState.transmissionViewers.get("12D3-self")).toBeUndefined();
    expect(sounds.leave).toHaveBeenCalledTimes(1);

    receive("12D3-alice", presence(ROOM, LOUNGE));
    expect(s.roster).toEqual(["12D3-alice"]);
    expect(sounds.join).toHaveBeenCalledTimes(2);
  });

  it("follows our own switch: the roster is rebuilt for the channel we moved to", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-bob", presence(ROOM, GAMING));
    expect(s.roster).toEqual(["12D3-alice"]);
    // What switchVoiceChannel does to the state, then the roster sync it runs.
    transportState.callVoiceChannel = GAMING;
    receive("12D3-carol", presence(ROOM));
    expect(s.roster).toEqual(["12D3-bob"]);
  });
});

describe("what is refused", () => {
  it.each([
    ["a malformed channel id", { type: MessageType.CallPresence, inCall: true, voiceRoomCode: ROOM, voiceChannel: "LOUNGE01" }],
    ["a channel id that is too long", { type: MessageType.CallPresence, inCall: true, voiceRoomCode: ROOM, voiceChannel: "a".repeat(33) }],
    ["a channel frame that also names roomCode", { type: MessageType.CallPresence, inCall: true, roomCode: ROOM, voiceRoomCode: ROOM, voiceChannel: LOUNGE }],
  ])("%s: never admitted, and an earlier entry is dropped", (_what, frame) => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    expect(s.roster).toEqual(["12D3-alice"]);
    receive("12D3-alice", frame);
    expect(s.roster).toEqual([]);
    expect(transportState.callPeerRooms.has("12D3-alice")).toBe(false);
    expect(transportState.callPeerVoiceChannels.has("12D3-alice")).toBe(false);
  });

  // A peer cannot get our microphone by naming our channel unless the relay
  // places it in our room: the channel is no substitute for membership.
  it("a non-member naming our room and channel", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-dave", presence(ROOM, LOUNGE));
    expect(s.roster).toEqual([]);
    expect(channelsOf(ROOM)).toEqual({ "": [], [LOUNGE]: ["12D3-self"] });
  });

  // ...nor by naming our channel in a room of its own: the channel id is the
  // same string, but the call is (room, channel).
  it("a member of another room naming our channel id there", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-dave", presence(OTHER_ROOM, LOUNGE), OTHER_ROOM);
    expect(s.roster).toEqual([]);
    expect(channelsOf(ROOM)[LOUNGE]).toEqual(["12D3-self"]);
    expect(channelsOf(OTHER_ROOM)[LOUNGE]).toEqual(["12D3-dave"]);
  });
});

describe("the ghost sweep, per channel", () => {
  it("drops a silent peer from its channel and keeps one whose presence goes on", () => {
    inCall(ROOM, LOUNGE);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-carol", presence(ROOM));

    // Alice keeps heartbeating in our channel, Carol in the default one; Bob
    // stops.
    now.mockReturnValue(t0 + 50_000);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-carol", presence(ROOM));
    now.mockReturnValue(t0 + 100_000);
    vi.advanceTimersByTime(15_000);

    expect(channelsOf(ROOM)).toEqual({ "": ["12D3-carol"], [LOUNGE]: ["12D3-alice", "12D3-self"] });
    expect(transportState.callPeerVoiceChannels.has("12D3-bob")).toBe(false);
    expect(s.roster).toEqual(["12D3-alice"]);
    // Bob was never in our call: his going is no "leave" for us.
    expect(sounds.leave).not.toHaveBeenCalled();

    // Alice goes silent too: our own channel's ghost is swept, with a chime.
    now.mockReturnValue(t0 + 200_000);
    vi.advanceTimersByTime(15_000);
    expect(channelsOf(ROOM)[LOUNGE]).toEqual(["12D3-self"]);
    expect(s.roster).toEqual([]);
    expect(sounds.leave).toHaveBeenCalledTimes(1);
  });
});

describe("the read API", () => {
  it("lists every channel of a room with its members, us included, DIDs when bound", () => {
    inCall(ROOM, LOUNGE);
    receive("12D3-alice", presence(ROOM, LOUNGE));
    receive("12D3-bob", presence(ROOM, GAMING));
    receive("12D3-dave", presence(OTHER_ROOM), OTHER_ROOM);
    const lounge = voiceChannelsIn(ROOM).get(LOUNGE)!;
    expect(lounge).toContainEqual({ peerId: "12D3-self", did: "did:key:z6Mkself", self: true });
    expect(lounge).toContainEqual({ peerId: "12D3-alice", did: null, self: false });
    expect(channelsOf(ROOM)).toEqual({ "": [], [LOUNGE]: ["12D3-alice", "12D3-self"], [GAMING]: ["12D3-bob"] });
    expect(channelsOf(OTHER_ROOM)).toEqual({ "": ["12D3-dave"] });
    expect(peersInMyCall()).toEqual(["12D3-alice"]);
  });

  it("names no call of ours, and nobody in it, when we are in none", () => {
    receive("12D3-alice", presence(ROOM));
    expect(peersInMyCall()).toEqual([]);
    expect(channelsOf(ROOM)).toEqual({ "": ["12D3-alice"] });
  });
});

describe("what a peer says they are doing in a call", () => {
  const state = (over: object = {}) => ({ type: MessageType.CallState, muted: false, deafened: false, ...over });
  const status = (peer = "12D3-alice") => transportState.callPeerStates.get(peer)?.status;
  const app = { plugin: "app", label: "Playing Jeopardy" };

  it("is kept for somebody in a call of the room, in any channel, and goes with it", () => {
    receive("12D3-alice", presence(ROOM, GAMING));
    receive("12D3-alice", state({ status: { sharing: true, activities: [app] } }));
    expect(status()).toEqual({ sharing: true, activities: [app] });
    receive("12D3-alice", state({ status: {} }));
    expect(status()).toEqual({ sharing: false, activities: [] });
    receive("12D3-alice", presence(null));
    expect(transportState.callPeerStates.has("12D3-alice")).toBe(false);
  });

  it("is null from a build that says nothing, whose mute still counts", () => {
    receive("12D3-alice", presence(ROOM));
    receive("12D3-alice", state({ muted: true }));
    expect(transportState.callPeerStates.get("12D3-alice")).toEqual({ muted: true, deafened: false, status: null });
  });

  it("is not taken from somebody in no call, or not in the room", () => {
    receive("12D3-bob", state({ status: { sharing: true } }));
    receive("12D3-dave", presence(ROOM), OTHER_ROOM);
    receive("12D3-dave", state({ status: { sharing: true } }), OTHER_ROOM);
    expect(status("12D3-bob")).toBeUndefined();
    expect(status("12D3-dave")).toBeUndefined();
  });

  it("stands over what can be seen from inside the call, which is for older builds", async () => {
    const { peerCallStatus } = await import("$lib/call-status.svelte");
    receive("12D3-alice", presence(ROOM));
    transportState.pendingTransmissions = new Map([["12D3-alice", "producer"]]);
    receive("12D3-alice", state());
    expect(peerCallStatus("12D3-alice", "did:key:zAlice", ROOM).sharing).toBe(true);
    // They turned it off: nothing is shown, whatever we could tell.
    receive("12D3-alice", state({ status: {} }));
    expect(peerCallStatus("12D3-alice", "did:key:zAlice", ROOM)).toEqual({ sharing: false, activities: [] });
  });
});

describe("our own call status", () => {
  it("is what the room is told, and nothing once turned off or out of the call", async () => {
    const { ownCallStatus } = await import("$lib/call-status.svelte");
    const { setSelfActivity } = await import("$lib/plugins/activity.svelte");
    const { setShareCallStatus } = await import("$lib/display-prefs.svelte");
    inCall(ROOM, LOUNGE);
    transportState.screenSharing = true;
    setSelfActivity("app", "In an app");
    const told = { sharing: true, activities: [{ plugin: "app", label: "In an app" }] };
    expect(ownCallStatus()).toEqual(told);
    setShareCallStatus(false);
    expect(ownCallStatus()).toEqual({ sharing: false, activities: [] });
    setShareCallStatus(true);
    expect(ownCallStatus()).toEqual(told);
    transportState.inCall = false;
    expect(ownCallStatus()).toEqual({ sharing: false, activities: [] });
    transportState.screenSharing = false;
    setSelfActivity("app", null);
  });
});
