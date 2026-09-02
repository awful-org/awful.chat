import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  watchingTransmissionPeerId: null,
  watchingTransmissionProducerId: null,
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
};

const transportMock = {
  reconcileNow: vi.fn(),
  selfId: () => "self-id",
  send: vi.fn(),
  broadcast: vi.fn(),
  peers: () => [] as string[],
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
const { joinCall, leaveCall, setDeafened } = await import("./call.svelte");

beforeEach(() => {
  transportState.roomCode = "room1";
  transportState.relayConnected = true;
  transportState.inCall = false;
  transportState.callRoomCode = null;
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
});

describe("_joinCall roster sequencing (finding 6)", () => {
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
    transportMock.peers = () => peers;

    setDeafened(true);

    expect(transportMock.send.mock.calls.map((c) => c[0]).sort()).toEqual([
      "peerA",
      "peerB",
    ]);
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
