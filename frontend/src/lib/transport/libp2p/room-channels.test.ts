import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
vi.mock("@libp2p/peer-id", async (original) => ({
  ...await original<typeof import("@libp2p/peer-id")>(),
  peerIdFromString: (peer: string) => ({ toString: () => peer }),
}));
const recorded = vi.hoisted(() => [] as Array<{ kind: string; sev: string; peer: string | null; d?: Record<string, unknown> }>);
vi.mock("$lib/telemetry/recorder", async (original) => ({
  ...await original<typeof import("$lib/telemetry/recorder")>(),
  rec: (event: (typeof recorded)[number]) => { recorded.push(event); },
}));
import { LibP2PTransport } from "./transport";
import { newRoomSecret } from "$lib/room-security/keys";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  recorded.length = 0;
});

function transport() {
  const t = new LibP2PTransport();
  const internal = t as any;
  internal.rendezvousSend = vi.fn();
  const room = t.joinSecureRoom(newRoomSecret());
  return { t, internal, room };
}

it("queues room channel openings past the concurrent limit instead of refusing them", async () => {
  const { t, internal, room } = transport();
  let inFlight = 0, most = 0;
  const fail: Array<() => void> = [];
  const dial = vi.fn(() => {
    most = Math.max(most, ++inFlight);
    return new Promise((_, reject) => fail.push(() => { inFlight--; reject(new Error("unreachable")); }));
  });
  internal.node = { dial, peerId: { toString: () => "alice" } };
  const sends = Array.from({ length: 100 }, (_, i) => t.sendSecureRoom(`peer${i}`, room, new Uint8Array([1])));
  await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(64));
  // The old limit refused the other 36 on the spot, never to be tried again.
  while (fail.length) {
    fail.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(dial).toHaveBeenCalledTimes(100);
  expect(most).toBe(64);
  expect(await Promise.all(sends)).toEqual(Array(100).fill(false));
  expect(internal.roomOpenings.active).toBe(0);
});

it("refuses handshakes past the per-connection limit, and says so", () => {
  const { internal } = transport();
  const connection = { status: "open", remotePeer: { toString: () => "mallory" } };
  const streams = Array.from({ length: 65 }, () => ({
    addEventListener() {}, removeEventListener() {}, abort: vi.fn(), send: () => true, onDrain: async () => {},
  }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const stream of streams) internal.attachSecureStream(stream, connection);
  expect(streams.slice(0, 64).every((s) => s.abort.mock.calls.length === 0)).toBe(true);
  expect(streams[64].abort).toHaveBeenCalledOnce();
  expect(internal.debugStats.roomChannelRefusals).toBe(1);
  expect(recorded).toContainEqual(expect.objectContaining({
    kind: "session.config", sev: "warn", peer: "mallory", d: { roomChannel: "refused", reason: "handshakes" },
  }));
  expect(warn).toHaveBeenCalledOnce();
  for (const entry of [...internal.secureStreams]) entry.close();
});

it("tries a listed pair that never proved its room again, backing off, until it does", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const { internal, room } = transport();
  internal.node = { peerId: { toString: () => "alice" } };
  internal.connectedPeers.add("bob");
  internal.joinedRooms.add(room);
  internal.roomPeers.set(room, new Set(["bob", "carol"]));
  const ensure = vi.spyOn(internal, "ensureSecureRoom").mockResolvedValue(null);
  const sweep = (ms: number) => { vi.advanceTimersByTime(ms); internal.retryUnprovenRoomPeers(); };
  // The rendezvous reply already made the first attempt; this waits its turn.
  sweep(0);
  expect(ensure).not.toHaveBeenCalled();
  sweep(5_000);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ensure).toHaveBeenLastCalledWith("bob", room);
  sweep(5_000);
  expect(ensure).toHaveBeenCalledTimes(1);
  sweep(5_000);
  expect(ensure).toHaveBeenCalledTimes(2);
  // carol is listed but not connected: dialling her is retryMissingRoomPeers' job.
  expect(ensure.mock.calls.every(([peer]) => peer === "bob")).toBe(true);
  // Proven: no more tries.
  internal.roomMembers.set(room, new Map([["bob", { status: "open" }]]));
  internal.roomProveRetry.clear();
  sweep(600_000);
  expect(ensure).toHaveBeenCalledTimes(2);
  // Gone, by the relay's word: nor for them.
  internal.roomMembers.clear();
  internal.handleRendezvousMsg("alice", { type: "PEER_LEFT", room, peer: "bob" });
  sweep(600_000);
  sweep(600_000);
  expect(ensure).toHaveBeenCalledTimes(2);
});
