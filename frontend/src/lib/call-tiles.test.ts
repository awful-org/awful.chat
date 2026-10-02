import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCallTiles,
  remoteCameraTileId,
  wantedCameras,
  type CallState,
  type CameraSurfaces,
} from "./call-tiles";

describe("buildCallTiles", () => {
  let state: CallState;

  beforeEach(() => {
    state = {
      participants: new Map(),
      localCameraStream: null,
      localScreenStream: null,
      cameraOff: false,
      watchingTransmissions: new Map(),
      selfId: "self",
      trackStartTimes: new Map(),
    };
  });

  it("includes local camera when track exists", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    state.localCameraStream = stream;

    const tiles = buildCallTiles(state);
    const localTile = tiles.find((t) => t.id === "local-camera");

    expect(localTile).toBeDefined();
    expect(localTile?.id).toBe("local-camera");
    expect(localTile?.kind).toBe("camera");
    expect(localTile?.isLocal).toBe(true);
    expect(localTile?.peerId).toBe("self");
    expect(localTile?.videoTrack).toBe(track);
  });

  it("includes the local camera tile with no track (avatar when alone)", () => {
    state.localCameraStream = null;

    const tiles = buildCallTiles(state);
    const localTile = tiles.find((t) => t.id === "local-camera");

    expect(localTile?.videoTrack).toBeNull();
    expect(localTile?.isLocal).toBe(true);
  });

  it("includes remote camera for each participant", () => {
    const peer1Track = { kind: "video" } as MediaStreamTrack;
    state.participants.set("peer1", {
      videoTrack: peer1Track,
      screenTrack: null,
    });
    state.participants.set("peer2", {
      videoTrack: null,
      screenTrack: null,
    });

    const tiles = buildCallTiles(state);
    const remoteTiles = tiles.filter((t) => t.id.startsWith("remote-camera-"));

    expect(remoteTiles).toHaveLength(2);
    expect(remoteTiles[0].id).toBe("remote-camera-peer1");
    expect(remoteTiles[0].videoTrack).toBe(peer1Track);
    expect(remoteTiles[1].id).toBe("remote-camera-peer2");
    expect(remoteTiles[1].videoTrack).toBeNull();
  });

  it("includes local screen when track exists", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    state.localScreenStream = stream;

    const tiles = buildCallTiles(state);
    const screenTile = tiles.find((t) => t.id === "local-screen");

    expect(screenTile).toBeDefined();
    expect(screenTile?.kind).toBe("screen");
    expect(screenTile?.isLocal).toBe(true);
    expect(screenTile?.videoTrack).toBe(track);
  });

  it("preserves startedAt for local screen across rebuilds", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    state.localScreenStream = stream;

    const now = performance.now();
    state.trackStartTimes.set("local-screen", now);

    const tiles = buildCallTiles(state);
    const screenTile = tiles.find((t) => t.id === "local-screen");

    expect(screenTile?.startedAt).toBe(now);
  });

  it("includes remote screen for each peer with screenTrack", () => {
    const screenTrack1 = { kind: "video" } as MediaStreamTrack;
    const screenTrack2 = { kind: "video" } as MediaStreamTrack;
    state.participants.set("peer1", {
      videoTrack: null,
      screenTrack: screenTrack1,
    });
    state.participants.set("peer2", {
      videoTrack: null,
      screenTrack: screenTrack2,
    });
    state.participants.set("peer3", {
      videoTrack: null,
      screenTrack: null,
    });

    const tiles = buildCallTiles(state);
    const screenTiles = tiles.filter((t) => t.id.startsWith("remote-screen-"));

    expect(screenTiles).toHaveLength(2);
    expect(screenTiles.map((t) => t.id)).toEqual([
      "remote-screen-peer1",
      "remote-screen-peer2",
    ]);
  });

  it("a watched share with its track is a remote-screen tile, like the stage", () => {
    const transmissionTrack = { kind: "video" } as MediaStreamTrack;
    state.watchingTransmissions = new Map([["sharer1", "prod-123"]]);
    state.participants.set("sharer1", {
      videoTrack: null,
      screenTrack: transmissionTrack,
    });

    const tiles = buildCallTiles(state);
    const screen = tiles.find((t) => t.id === "remote-screen-sharer1");

    expect(screen?.kind).toBe("screen");
    expect(screen?.videoTrack).toBe(transmissionTrack);
    expect(tiles.find((t) => t.id === "pending-tx-sharer1")).toBeUndefined();
  });

  it("includes transmission tile while joining (producerId set, no track yet)", () => {
    state.watchingTransmissions = new Map([["sharer1", "prod-123"]]);
    state.participants.set("sharer1", {
      videoTrack: null,
      screenTrack: null,
    });

    const tiles = buildCallTiles(state);
    const txTile = tiles.find((t) => t.id === "pending-tx-sharer1");

    expect(txTile).toBeDefined();
    expect(txTile?.videoTrack).toBeNull();
  });

  it("a waiting tile for EVERY share being watched, not just the latest", () => {
    state.watchingTransmissions = new Map([
      ["sharer1", "prod-1"],
      ["sharer2", "prod-2"],
    ]);
    const tiles = buildCallTiles(state);
    expect(tiles.filter((t) => t.id.startsWith("pending-tx-")).map((t) => t.id)).toEqual([
      "pending-tx-sharer1",
      "pending-tx-sharer2",
    ]);
  });

  it("does not include transmission tile when not watching", () => {
    state.watchingTransmissions = new Map();
    state.participants.set("sharer1", {
      videoTrack: null,
      screenTrack: { kind: "video" } as MediaStreamTrack,
    });

    const tiles = buildCallTiles(state);
    const txTile = tiles.find((t) => t.id.startsWith("pending-tx-"));

    expect(txTile).toBeUndefined();
  });

  it("one tile per source: no duplicates for watched peer", () => {
    const screenTrack = { kind: "video" } as MediaStreamTrack;
    state.watchingTransmissions = new Map([["sharer1", "prod-123"]]);
    state.participants.set("sharer1", {
      videoTrack: null,
      screenTrack,
    });

    const tiles = buildCallTiles(state);

    // One screen tile, never a remote-screen AND a pending-tx for one share
    const sharer1Tiles = tiles.filter((t) => t.peerId === "sharer1");
    expect(sharer1Tiles).toHaveLength(2); // remote-camera + one screen
    expect(sharer1Tiles.map((t) => t.id)).toEqual([
      "remote-camera-sharer1",
      "remote-screen-sharer1",
    ]);
  });

  it("tile id formats match the stage exactly", () => {
    const selfTrack = { kind: "video" } as MediaStreamTrack;
    const remoteCamTrack = { kind: "video" } as MediaStreamTrack;
    const remoteScreenTrack = { kind: "video" } as MediaStreamTrack;
    const localScreenTrack = { kind: "video" } as MediaStreamTrack;

    state.localCameraStream = {
      getVideoTracks: () => [selfTrack],
    } as unknown as MediaStream;
    state.localScreenStream = {
      getVideoTracks: () => [localScreenTrack],
    } as unknown as MediaStream;
    state.participants.set("peer1", {
      videoTrack: remoteCamTrack,
      screenTrack: remoteScreenTrack,
    });
    state.watchingTransmissions = new Map([["peer2", "prod-123"]]);
    state.participants.set("peer2", {
      videoTrack: null,
      screenTrack: null,
    });

    const tiles = buildCallTiles(state);
    const ids = tiles.map((t) => t.id).sort();

    expect(ids).toEqual([
      "local-camera",
      "local-screen",
      "pending-tx-peer2",
      "remote-camera-peer1",
      "remote-camera-peer2",
      "remote-screen-peer1",
    ]);
  });

  it("preserves startedAt across rebuilds for screens", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const startTime = 1000;

    state.participants.set("peer1", {
      videoTrack: null,
      screenTrack: track,
    });
    state.trackStartTimes.set("remote-screen-peer1", startTime);

    const tiles = buildCallTiles(state);
    const screenTile = tiles.find((t) => t.id === "remote-screen-peer1");

    expect(screenTile?.startedAt).toBe(startTime);
  });

  it("initializes new track startedAt to performance.now() if not seen before", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    state.participants.set("peer1", {
      videoTrack: null,
      screenTrack: track,
    });
    // Not in trackStartTimes yet

    const tiles = buildCallTiles(state);
    const screenTile = tiles.find((t) => t.id === "remote-screen-peer1");

    expect(screenTile?.startedAt).toBeDefined();
    expect(typeof screenTile?.startedAt).toBe("number");
    expect(screenTile?.startedAt).toBeGreaterThan(0);
  });
});

describe("wantedCameras", () => {
  const camera = (peerId: string, isLocal = false) => ({
    id: isLocal ? "local-camera" : remoteCameraTileId(peerId),
    kind: "camera" as const,
    isLocal,
    peerId,
  });
  const share = (peerId: string) => ({
    id: `remote-screen-${peerId}`,
    kind: "screen" as const,
    isLocal: false,
    peerId,
  });
  const shown = (surfaces: Partial<CameraSurfaces>): CameraSurfaces => ({
    stage: [],
    spotlight: null,
    pinnedTileId: null,
    poppedOut: [],
    speaking: [],
    selfId: "self",
    ...surfaces,
  });

  it("is what the stage has on screen when nothing else shows a camera", () => {
    expect(wantedCameras(shown({ stage: ["a", "b"] }))).toEqual(new Set(["a", "b"]));
  });

  it("is nothing at all when no surface shows a camera", () => {
    // Another room open, the panel showing a share: no camera is worth
    // receiving, where every one used to be decoded at full size.
    expect(wantedCameras(shown({ spotlight: share("a") }))).toEqual(new Set());
  });

  it("adds the spotlight's camera: the floating panel and picture in picture show it", () => {
    expect(
      wantedCameras(shown({ stage: ["a"], spotlight: camera("b") }))
    ).toEqual(new Set(["a", "b"]));
  });

  it("never asks for our own camera, which is not received", () => {
    expect(
      wantedCameras(shown({ spotlight: camera("self", true), speaking: ["self"] }))
    ).toEqual(new Set());
  });

  it("adds whoever is talking, before the spotlight can move to them", () => {
    // Rule 3 hands the spotlight over after 1.5 s of speech. Asked for only
    // at the switch, a parked camera put a black picture in the floating
    // panel and picture in picture for the round trip it takes to return.
    expect(
      wantedCameras(shown({ spotlight: camera("a"), speaking: ["b", "self"] }))
    ).toEqual(new Set(["a", "b"]));
    expect(wantedCameras(shown({ speaking: ["b"] }))).toEqual(new Set(["b"]));
  });

  it("adds no one for talking while a pin holds the spotlight", () => {
    const pinned = camera("a");
    expect(
      wantedCameras(shown({ spotlight: pinned, pinnedTileId: pinned.id, speaking: ["b"] }))
    ).toEqual(new Set(["a"]));
  });

  it("adds no one for talking while a watched share holds the spotlight", () => {
    expect(
      wantedCameras(shown({ spotlight: share("a"), speaking: ["b"] }))
    ).toEqual(new Set());
  });

  it("a pin on a tile that is gone holds nothing", () => {
    // Rule 1 skips a pin whose tile left; the speakers rule decides again.
    expect(
      wantedCameras(
        shown({ spotlight: camera("a"), pinnedTileId: remoteCameraTileId("gone"), speaking: ["b"] })
      )
    ).toEqual(new Set(["a", "b"]));
  });

  it("adds a camera popped out into its own window, by the stage's tile id", () => {
    const tiles = buildCallTiles({
      participants: new Map([
        ["peer-c", { videoTrack: null, screenTrack: null }],
      ]),
      localCameraStream: null,
      localScreenStream: null,
      cameraOff: true,
      watchingTransmissions: new Map(),
      selfId: "self",
      trackStartTimes: new Map(),
    });
    const popped = tiles.find((t) => t.peerId === "peer-c")!.id;
    // The stage names its tiles with the same helper.
    expect(popped).toBe(remoteCameraTileId("peer-c"));

    expect(
      wantedCameras(
        shown({ poppedOut: [popped, "remote-screen-peer-d", "local-camera"] })
      )
    ).toEqual(new Set(["peer-c"]));
  });
});
