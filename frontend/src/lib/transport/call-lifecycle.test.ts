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

vi.mock("./transmission.svelte", () => ({
  setTransmissionOutputVolume: vi.fn(),
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
