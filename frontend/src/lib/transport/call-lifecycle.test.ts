import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as audioPrefs from "./audio-prefs";

// call.svelte.ts pulls in the real transport singletons (transport.svelte.ts
// builds a libp2p node at import time - see the comment in call-error.ts),
// so every dependency it touches gets a plain mock here instead.

vi.mock("$lib/sounds", () => ({
  playCameraOffSound: vi.fn(async () => {}),
  playCameraOnSound: vi.fn(async () => {}),
  playDeafenSound: vi.fn(async () => {}),
  playJoinSound: vi.fn(async () => {}),
  playLeaveSound: vi.fn(async () => {}),
  playMuteSound: vi.fn(async () => {}),
  playScreenShareStartSound: vi.fn(async () => {}),
  playScreenShareStopSound: vi.fn(async () => {}),
  playUndeafenSound: vi.fn(async () => {}),
  playUnmuteSound: vi.fn(async () => {}),
}));

const sendWatchPresence = vi.hoisted(() => vi.fn());
vi.mock("./transmission.svelte", () => ({
  setTransmissionOutputVolume: vi.fn(),
  _sendWatchPresence: sendWatchPresence,
}));

// A plain object standing in for the real $state-backed transportState -
// reactivity is irrelevant here, only the field values call.svelte.ts reads
// and writes.
const transportState: Record<string, unknown> = {
  roomCode: "room1",
  relayConnected: true,
  inCall: false,
  callRoomCode: null,
  callVoiceChannel: "",
  callPeerRooms: new Map(),
  callPeerVoiceChannels: new Map(),
  joiningCall: false,
  muted: false,
  deafened: false,
  transmissionOutputVolume: 1,
  localMicStream: null,
  localCameraStream: null,
  localScreenStream: null,
  cameraOff: true,
  screenSharing: false,
  participants: new Map(),
  pendingTransmissions: new Map(),
  transmissionViewers: new Map(),
  watchingTransmissions: new Map(),
  error: null,
};

let outputVolume = 1;
let voiceMuted = false;
const voiceMock = {
  join: vi.fn(async () => {}),
  leave: vi.fn(),
  isMuted: () => voiceMuted,
  mute: vi.fn(() => {
    voiceMuted = true;
  }),
  unmute: vi.fn(() => {
    voiceMuted = false;
  }),
  getMicStream: () => null,
  getOutputVolume: () => outputVolume,
  setOutputVolume: (v: number) => {
    outputVolume = v;
  },
  stopCallAudio: vi.fn(),
};

const videoMock = {
  join: vi.fn(async () => {}),
  leave: vi.fn(),
  ensureLive: vi.fn(),
  stopCamera: vi.fn(),
  stopScreenShare: vi.fn(),
  startScreenShare: vi.fn(async (_stream: MediaStream, _encoding: RTCRtpEncodingParameters) => {}),
  roomPeerCount: () => 0,
  isConnected: () => true,
};

const transportMock = {
  isSecureRoom: (room: string) => room.startsWith("rd2_") || room.startsWith("dm-"),
  sendRoom: vi.fn(),
  reconcileNow: vi.fn(),
  selfId: () => "self-id",
  send: vi.fn(),
  broadcast: vi.fn(),
  peers: () => [] as string[],
  // Relay-attested room membership. The direct fan-out of a call frame is
  // gated on it: the frame carries the call's room code, which is that
  // room's whole join secret.
  peersInRoom: (_room: string) => [] as string[],
  announce: vi.fn(),
};

const syncVoiceRoster = vi.fn();

vi.mock("./transport.svelte", () => ({
  transportState,
  _transport: transportMock,
  _video: videoMock,
  _voice: voiceMock,
  _syncVoiceRoster: syncVoiceRoster,
  connect: vi.fn(async () => {}),
}));

// Dynamic import, matching files-announce.test.ts/files-inline.test.ts: the
// vi.mock calls above must resolve before call.svelte.ts's own top-level
// `import { ... } from "./transport.svelte"` runs, and only a module loaded
// after those mocks land observes the mocked version.
const { joinCall, leaveCall, setDeafened, startScreenShare, switchVoiceChannel, _sendCallState } = await import("./call.svelte");
const { decode } = await import("$lib/utils");
const { MessageType } = await import("$lib/types/message");

it.each(["rd2_" + "A".repeat(43), "dm-" + "a".repeat(40)])(
  "routes call state through the protected call scope %s when another room is displayed",
  (room) => {
    transportState.callRoomCode = room;
    transportMock.send.mockClear();
    transportMock.sendRoom.mockClear();
    _sendCallState("member");
    expect(transportMock.sendRoom).toHaveBeenCalledWith("member", room, expect.any(Uint8Array));
    expect(transportMock.send).not.toHaveBeenCalled();
  },
);

it("says with it what we are doing, unless that is turned off", async () => {
  const { setShareCallStatus } = await import("$lib/display-prefs.svelte");
  const state = transportState as Record<string, unknown>;
  state.callRoomCode = "rd2_" + "A".repeat(43);
  state.inCall = true;
  state.screenSharing = true;
  const sent = () => {
    transportMock.sendRoom.mockClear();
    _sendCallState("member");
    return decode(transportMock.sendRoom.mock.calls[0][2] as Uint8Array) as { status?: unknown };
  };
  expect(sent().status).toEqual({ sharing: true });
  setShareCallStatus(false);
  expect(sent().status).toEqual({});
  setShareCallStatus(true);
  state.screenSharing = false;
  state.inCall = false;
});

beforeEach(() => {
  transportState.roomCode = "room1";
  transportState.relayConnected = true;
  transportState.inCall = false;
  transportState.callRoomCode = null;
  transportState.callVoiceChannel = "";
  transportState.deafened = false;
  transportState.muted = false;
  transportState.transmissionOutputVolume = 1;
  outputVolume = 1;
  voiceMuted = false;
  syncVoiceRoster.mockReset();
  videoMock.join.mockReset();
  videoMock.join.mockImplementation(async () => {});
});

afterEach(() => {
  // Every test that joins leaves a presence heartbeat interval running;
  // leaveCall() is the only thing that clears it.
  leaveCall();
  vi.restoreAllMocks();
});

describe("_joinCall roster sequencing (finding 6)", () => {
  it("does not infer a node split from a zero-peer SFU snapshot", async () => {
    transportState.callPeerRooms = new Map([["alice", "room1"]]);
    await joinCall();
    expect(transportState.inCall).toBe(true);
    expect(transportState.error).toBeNull();
    expect(videoMock.ensureLive).not.toHaveBeenCalled();
  });

  it("keeps voice and video in the original room while microphone permission is pending", async () => {
    let finish: () => void = () => {};
    voiceMock.join.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const joined = joinCall();
    transportState.roomCode = "room2";
    finish();
    await joined;
    expect(voiceMock.join).toHaveBeenLastCalledWith("room1");
    expect(transportState.callRoomCode).toBe("room1");
    expect(videoMock.join).toHaveBeenLastCalledWith("room1", "self-id", "");
  });
  it("sets inCall/callRoomCode before the FIRST roster sync, not after _video.join()", async () => {
    const snapshots: Array<{ inCall: unknown; callRoomCode: unknown }> = [];
    syncVoiceRoster.mockImplementation(() => {
      snapshots.push({
        inCall: transportState.inCall,
        callRoomCode: transportState.callRoomCode,
      });
    });
    // _video.join() never resolves during this assertion window - if the
    // first sync ran before inCall/callRoomCode were set (the bug), it
    // would still see the stale values here since nothing else touches
    // them until after this same await.
    let resolveVideoJoin: () => void = () => {};
    videoMock.join.mockImplementation(
      () => new Promise<void>((resolve) => (resolveVideoJoin = resolve))
    );

    const joined = joinCall();
    // Let the microtask queue drain up to the point _video.join() is
    // in flight and awaiting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Resolve BEFORE asserting: on a failing assertion, an un-resolved
    // _video.join() would leave _joinPromise pending forever and hang
    // every later test that calls joinCall() again.
    resolveVideoJoin();
    await joined;

    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // Before the fix this was {inCall: false, callRoomCode: null} - an
    // empty roster (default-deny, nobody admitted) for the whole
    // _video.join() round trip (finding 6).
    expect(snapshots[0]).toEqual({ inCall: true, callRoomCode: "room1" });
  });
});

describe("screen-share content hint", () => {
  it.each(["", "motion", "detail"] as const)("applies %s before publishing while retaining the FPS cap", async (hint) => {
    vi.spyOn(audioPrefs, "loadAudioPrefs").mockReturnValue({
      ...audioPrefs.AUDIO_PREF_DEFAULTS, shareContentHint: hint, shareFps: 15,
    });
    const track = { kind: "video", contentHint: "", getSettings: () => ({}), stop: vi.fn() };
    const stream = {
      getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track],
    } as unknown as MediaStream;
    videoMock.startScreenShare.mockImplementationOnce(async () => {
      expect(track.contentHint).toBe(hint);
    });
    await startScreenShare(stream);
    expect(videoMock.startScreenShare).toHaveBeenLastCalledWith(stream, expect.objectContaining({ maxFramerate: 15 }));
  });
});

describe("deafen, leave, rejoin: peer gain is not stuck at 0 (finding 5)", () => {
  it("restores voice output volume on leaveCall when deafened", async () => {
    await joinCall();
    expect(outputVolume).toBe(1);

    setDeafened(true);
    expect(outputVolume).toBe(0);

    leaveCall();
    // Before the fix, leaveCall only wrote transportState.deafened = false
    // directly and never told _voice to restore its gain - so the NEXT
    // join's setupRemoteAudio would seed every peer's gain node at
    // currentOutputVolume(0) * peerVolume, leaving every peer silent while
    // the deafen icon read normal.
    expect(outputVolume).not.toBe(0);
    expect(transportState.deafened).toBe(false);
  });

  it("does not touch voice output volume on a leave that was never deafened", () => {
    leaveCall();
    expect(outputVolume).toBe(1);
  });
});

describe("mute/deafen state broadcasts into the CALL's room", () => {
  it("reaches the call room even when a different room is on screen", () => {
    transportState.inCall = true;
    transportState.callRoomCode = "call-room";
    transportState.roomCode = "other-room"; // user is browsing elsewhere
    transportMock.broadcast.mockClear();

    setDeafened(true);

    const rooms = transportMock.broadcast.mock.calls.map((c) => c[1]);
    // Before the fix this went ONLY to "other-room" (the room on screen),
    // so peers in the call kept the stale badge until a reconnect.
    expect(rooms).toContain("call-room");
    expect(rooms).toContain("other-room");
  });

  // Gossipsub is best effort and needs a formed mesh, so a peer that has just
  // joined the topic never sees the frame. Call presence always fanned out
  // directly as well as broadcasting; mute/deafen did not, and a stale badge
  // is what that looks like. The heartbeat is no substitute: it repeats the
  // same broadcast down the same missing path.
  it("also sends mute state straight down every open stream", () => {
    transportState.inCall = true;
    transportState.callRoomCode = "room1";
    transportState.roomCode = "room1";
    transportMock.send.mockClear();
    const peers = ["peerA", "peerB"];
    transportMock.peersInRoom = (room: string) =>
      room === "room1" ? peers : [];

    setDeafened(true);

    expect(transportMock.send.mock.calls.map((c) => c[0]).sort()).toEqual([
      "peerA",
      "peerB",
    ]);
    transportMock.peersInRoom = () => [] as string[];
  });

  // ...but only down the streams of peers the relay places in the room. The
  // direct copy used to go to _transport.peers(), which is anybody who dialled
  // us - handing a stranger the call room's code every 20 seconds.
  it("does not send call frames to a peer outside the room", () => {
    transportState.inCall = true;
    transportState.callRoomCode = "room1";
    transportState.roomCode = "room1";
    transportMock.send.mockClear();
    transportMock.peers = () => ["stranger"];
    transportMock.peersInRoom = () => [] as string[];

    setDeafened(true);

    expect(transportMock.send).not.toHaveBeenCalled();
    transportMock.peers = () => [] as string[];
  });

  it("broadcasts once when the call room IS the room on screen", () => {
    transportState.inCall = true;
    transportState.callRoomCode = "room1";
    transportState.roomCode = "room1";
    transportMock.broadcast.mockClear();

    setDeafened(true);

    expect(
      transportMock.broadcast.mock.calls.map((c) => c[1])
    ).toEqual(["room1"]);
  });
});

describe("presence heartbeat replays watch presence and call state", () => {
  it("re-announces all three on the 20s beat, so one lost gossip frame heals", async () => {
    vi.useFakeTimers();
    try {
      await joinCall();
      transportMock.broadcast.mockClear();
      sendWatchPresence.mockClear();

      await vi.advanceTimersByTimeAsync(20_000);

      // Watch presence rode the beat (it broadcasts from its own module,
      // mocked here)...
      expect(sendWatchPresence).toHaveBeenCalledTimes(1);
      // ...and call presence + mute/deafen state both went out too.
      expect(
        transportMock.broadcast.mock.calls.length
      ).toBeGreaterThanOrEqual(2);
    } finally {
      leaveCall();
      vi.useRealTimers();
    }
  });
});

describe("voice channels", () => {
  const ROOM = "rd2_" + "r".repeat(52);
  const OTHER = "rd2_" + "o".repeat(52);
  const presences = () =>
    transportMock.broadcast.mock.calls
      .map(([payload, room]) => ({ room, frame: decode(payload as Uint8Array) as Record<string, unknown> }))
      .filter(({ frame }) => frame.type === MessageType.CallPresence);

  beforeEach(() => {
    transportState.roomCode = ROOM;
    transportMock.broadcast.mockClear();
    voiceMock.join.mockClear();
    voiceMock.leave.mockClear();
    videoMock.leave.mockClear();
    videoMock.stopCamera.mockClear();
  });

  it("joins a named channel: its own SFU room, and the channel in the presence", async () => {
    await joinCall("lounge01");
    expect(transportState.callVoiceChannel).toBe("lounge01");
    expect(videoMock.join).toHaveBeenLastCalledWith(ROOM, "self-id", "lounge01");
    expect(presences().at(-1)).toEqual({
      room: ROOM,
      frame: { type: MessageType.CallPresence, inCall: true, voiceRoomCode: ROOM, voiceChannel: "lounge01" },
    });
  });

  it("announces the default channel in the frame old clients read", async () => {
    await joinCall();
    expect(presences().at(-1)?.frame).toEqual({ type: MessageType.CallPresence, inCall: true, roomCode: ROOM });
  });

  it("switches channel in place: same microphone, same mute, never out of the call", async () => {
    await joinCall();
    voiceMuted = true;
    transportState.muted = true;
    transportMock.broadcast.mockClear();
    videoMock.join.mockClear();
    voiceMock.join.mockClear();
    const snapshots: unknown[] = [];
    syncVoiceRoster.mockImplementation(() => snapshots.push(transportState.callVoiceChannel));

    await joinCall("lounge01");

    // The voice pipeline is not rebuilt; its links follow the roster.
    expect(voiceMock.leave).not.toHaveBeenCalled();
    expect(voiceMock.join).not.toHaveBeenCalled();
    expect(snapshots[0]).toBe("lounge01");
    // The SFU room is the channel's own.
    expect(videoMock.leave).toHaveBeenCalledTimes(1);
    expect(videoMock.join).toHaveBeenLastCalledWith(ROOM, "self-id", "lounge01");
    expect(transportState).toMatchObject({ inCall: true, callRoomCode: ROOM, callVoiceChannel: "lounge01", muted: true });
    // No "left the call" in between: nobody hears us leave and rejoin, and
    // the frame that moves us is the one that takes us out of the old channel.
    expect(presences().map((p) => p.frame.inCall)).not.toContain(false);
    expect(presences().at(-1)?.frame).toMatchObject({ voiceRoomCode: ROOM, voiceChannel: "lounge01" });

    await switchVoiceChannel("");
    expect(transportState.callVoiceChannel).toBe("");
    expect(presences().at(-1)?.frame).toEqual({ type: MessageType.CallPresence, inCall: true, roomCode: ROOM });
  });

  it("stops a camera published into the channel it leaves", async () => {
    await joinCall();
    const track = { stop: vi.fn() };
    transportState.cameraOff = false;
    transportState.localCameraStream = { getTracks: () => [track] };
    await joinCall("lounge01");
    expect(track.stop).toHaveBeenCalled();
    expect(videoMock.stopCamera).toHaveBeenCalled();
    expect(transportState.cameraOff).toBe(true);
  });

  it.each(["LOUNGE01", "short", "a".repeat(33), "lounge-01"])("refuses the malformed channel id %s", async (bad) => {
    await expect(joinCall(bad)).rejects.toThrow();
    expect(voiceMock.join).not.toHaveBeenCalled();
    expect(transportState.inCall).toBe(false);

    await joinCall("lounge01");
    await expect(joinCall(bad)).rejects.toThrow();
    await expect(switchVoiceChannel(bad)).rejects.toThrow();
    expect(transportState.callVoiceChannel).toBe("lounge01");
  });

  it("refuses a channel in a DM, and in a room without protection", async () => {
    transportState.roomCode = "dm-" + "a".repeat(40);
    await expect(joinCall("lounge01")).rejects.toThrow();
    transportState.roomCode = "room1";
    await expect(joinCall("lounge01")).rejects.toThrow();
    expect(voiceMock.join).not.toHaveBeenCalled();
  });

  it("lands in the channel pressed last when it was pressed during a join", async () => {
    let finish: () => void = () => {};
    voiceMock.join.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = joinCall();
    const second = joinCall("lounge01");
    finish();
    await first;
    await second;
    expect(transportState).toMatchObject({ inCall: true, callVoiceChannel: "lounge01" });
  });

  it("does not undo a hang-up with a channel pressed before it", async () => {
    let finish: () => void = () => {};
    voiceMock.join.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = joinCall();
    const second = joinCall("lounge01");
    leaveCall();
    finish();
    await first;
    await second;
    expect(transportState.inCall).toBe(false);
  });

  it("does not carry a channel pressed during a join into a room opened since", async () => {
    let fail: (err: Error) => void = () => {};
    voiceMock.join.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { fail = reject; })
    );
    const first = joinCall();
    const second = joinCall("lounge01");
    // The user moves on to another room, and the first join then fails.
    transportState.roomCode = OTHER;
    fail(new Error("Could not start audio source"));
    await first.catch(() => {});
    await second;
    // The waiting press was for a channel of ROOM: it is not one of OTHER's,
    // and nobody pressed anything in OTHER.
    expect(transportState.inCall).toBe(false);
    expect(videoMock.join).not.toHaveBeenCalled();
  });

  it("unwinds a switch hung up while its SFU join was out", async () => {
    await joinCall();
    let finish: () => void = () => {};
    videoMock.join.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const switching = joinCall("lounge01");
    leaveCall();
    videoMock.leave.mockClear();
    finish();
    await switching;
    expect(transportState.inCall).toBe(false);
    expect(videoMock.leave).toHaveBeenCalledTimes(1);
  });

  // The leave used to go to whatever room was on screen once callRoomCode
  // was cleared - so hanging up from another room left a ghost in the call.
  it("sends the leave into the call's room when another room is on screen", async () => {
    await joinCall("lounge01");
    transportState.roomCode = OTHER;
    transportMock.broadcast.mockClear();
    leaveCall();
    expect(presences()).toEqual([{ room: ROOM, frame: { type: MessageType.CallPresence, inCall: false } }]);
  });

  it("stays out of another room's channels while in a call elsewhere", async () => {
    await joinCall("lounge01");
    transportState.roomCode = OTHER;
    videoMock.join.mockClear();
    await joinCall("gaming01");
    expect(transportState).toMatchObject({ callRoomCode: ROOM, callVoiceChannel: "lounge01" });
    expect(videoMock.join).not.toHaveBeenCalled();
  });
});
