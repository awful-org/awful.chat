import { describe, it, expect, beforeEach } from "vitest";
import { buildCallTiles, type CallState } from "./call-tiles";

describe("buildCallTiles", () => {
  let state: CallState;

  beforeEach(() => {
    state = {
      participants: new Map(),
      localCameraStream: null,
      localScreenStream: null,
      cameraOff: false,
      watchingTransmissionPeerId: null,
      watchingTransmissionProducerId: null,
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
    state.watchingTransmissionPeerId = "sharer1";
    state.watchingTransmissionProducerId = "prod-123";
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
    state.watchingTransmissionPeerId = "sharer1";
    state.watchingTransmissionProducerId = "prod-123";
    state.participants.set("sharer1", {
      videoTrack: null,
      screenTrack: null,
    });

    const tiles = buildCallTiles(state);
    const txTile = tiles.find((t) => t.id === "pending-tx-sharer1");

    expect(txTile).toBeDefined();
    expect(txTile?.videoTrack).toBeNull();
  });

  it("does not include transmission tile when not watching", () => {
    state.watchingTransmissionPeerId = null;
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
    state.watchingTransmissionPeerId = "sharer1";
    state.watchingTransmissionProducerId = "prod-123";
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
    state.watchingTransmissionPeerId = "peer2";
    state.watchingTransmissionProducerId = "prod-123";
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
