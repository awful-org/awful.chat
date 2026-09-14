import { expect, it, vi } from "vitest";

const { state, transport } = vi.hoisted(() => ({
  state: {
    watchingTransmissionPeerId: null as string | null,
    watchingTransmissionProducerId: null as string | null,
    pendingTransmissions: new Map<string, string>(),
    roomCode: "room", callRoomCode: "room",
  },
  transport: { peers: () => [], broadcast: vi.fn(), send: vi.fn() },
}));
vi.mock("./transport.svelte", () => ({ transportState: state, _transport: transport }));
vi.mock("$lib/sounds", () => ({
  playTransmissionEndedSound: vi.fn(), playScreenShareStartSound: vi.fn(),
  playTransmissionJoinSound: vi.fn(), playTransmissionLeaveSound: vi.fn(),
}));
import { initTransmission, stopWatchingTransmission } from "./transmission.svelte";
import { MediasoupVideo } from "./mediasoup";

it("restores watch controls with the new producer after reconnect, then stops locally", () => {
  const video = new MediasoupVideo();
  const stop = vi.spyOn(video, "stopWatchingTransmission").mockImplementation(() => {});
  initTransmission(video);
  const emit = (video as unknown as { emit: (event: string, ...args: string[]) => void }).emit.bind(video);
  state.pendingTransmissions.set("sharer", "stale-producer");
  emit("transmissionRestored", "sharer", "new-producer");
  expect(state.watchingTransmissionPeerId).toBe("sharer");
  expect(state.watchingTransmissionProducerId).toBe("new-producer");
  expect(state.pendingTransmissions.has("sharer")).toBe(false);
  stopWatchingTransmission();
  expect(stop).toHaveBeenCalledWith("sharer");
  expect(state.watchingTransmissionPeerId).toBeNull();
  expect(state.pendingTransmissions.get("sharer")).toBe("new-producer");
});
