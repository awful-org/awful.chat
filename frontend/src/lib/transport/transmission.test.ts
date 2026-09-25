import { beforeEach, expect, it, vi } from "vitest";

const { state, transport } = vi.hoisted(() => ({
  state: {
    watchingTransmissions: new Map<string, string>(),
    pendingTransmissions: new Map<string, string>(),
    roomCode: "room", callRoomCode: "room",
  },
  transport: { peers: () => [], broadcast: vi.fn(), send: vi.fn() },
}));
vi.mock("./transport.svelte", () => ({
  transportState: state,
  _transport: transport,
  _forgetWatched: (peerId: string) => {
    const next = new Map(state.watchingTransmissions);
    next.delete(peerId);
    state.watchingTransmissions = next;
  },
}));
vi.mock("$lib/sounds", () => ({
  playTransmissionEndedSound: vi.fn(), playScreenShareStartSound: vi.fn(),
  playTransmissionJoinSound: vi.fn(), playTransmissionLeaveSound: vi.fn(),
}));
import {
  initTransmission,
  stopWatchingTransmission,
  watchTransmission,
} from "./transmission.svelte";
import { MediasoupVideo } from "./mediasoup";

const video = new MediasoupVideo();
const stop = vi.spyOn(video, "stopWatchingTransmission").mockImplementation(() => {});
vi.spyOn(video, "watchTransmission").mockImplementation(async () => {});
initTransmission(video);
const emit = (video as unknown as { emit: (event: string, ...args: string[]) => void }).emit.bind(video);

beforeEach(() => {
  state.watchingTransmissions = new Map();
  state.pendingTransmissions = new Map();
  stop.mockClear();
  transport.broadcast.mockClear();
});

it("restores watch controls with the new producer after reconnect, then stops locally", () => {
  state.pendingTransmissions.set("sharer", "stale-producer");
  emit("transmissionRestored", "sharer", "new-producer");
  expect(state.watchingTransmissions.get("sharer")).toBe("new-producer");
  expect(state.pendingTransmissions.has("sharer")).toBe(false);
  stopWatchingTransmission();
  expect(stop).toHaveBeenCalledWith("sharer");
  expect(state.watchingTransmissions.size).toBe(0);
  expect(state.pendingTransmissions.get("sharer")).toBe("new-producer");
});

it("watches several shares, and stopping one leaves the others playing", async () => {
  await watchTransmission("ada", "p-ada");
  await watchTransmission("bob", "p-bob");
  expect([...state.watchingTransmissions.keys()]).toEqual(["ada", "bob"]);

  // The first one started - the case the single peerId made unstoppable.
  stopWatchingTransmission("ada");
  expect(stop).toHaveBeenCalledWith("ada");
  expect([...state.watchingTransmissions.keys()]).toEqual(["bob"]);
  expect(state.pendingTransmissions.get("ada")).toBe("p-ada");
});

it("a bare stop takes the most recently started share", async () => {
  await watchTransmission("ada", "p-ada");
  await watchTransmission("bob", "p-bob");
  await watchTransmission("ada", "p-ada"); // re-watching moves ada to the end
  stopWatchingTransmission();
  expect(stop).toHaveBeenCalledWith("ada");
  expect([...state.watchingTransmissions.keys()]).toEqual(["bob"]);
});

it("announces every share it watches, and the latest for older clients", async () => {
  await watchTransmission("ada", "p-ada");
  await watchTransmission("bob", "p-bob");
  const frame = JSON.parse(
    new TextDecoder().decode(transport.broadcast.mock.lastCall![0] as Uint8Array)
  );
  expect(frame.watchingAll).toEqual(["ada", "bob"]);
  expect(frame.watching).toBe("bob");
});
