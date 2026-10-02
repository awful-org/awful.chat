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

/** A room stream as attachSecureStream records it, bookkeeping only: inbound from bob unless told otherwise. */
function roomStream(fields: Record<string, unknown> = {}) {
  return {
    connection: { status: "open" }, peer: "bob", outgoing: false, room: null, channel: null,
    usedAt: Date.now(), provenAt: 0, superseded: false, replaces: null, departed: false,
    close: vi.fn(), getChannel: () => null, ...fields,
  };
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

it("keeps our young channel to a larger peer through a crossing hello, and lets theirs replace it only once proven", () => {
  vi.useFakeTimers();
  const { internal, room } = transport();
  internal.node = { peerId: { toString: () => "alice" } }; // smaller than bob
  const ours = roomStream({ outgoing: true, room, channel: { verified: true }, provenAt: Date.now() });
  internal.secureStreams.add(ours);
  // Theirs is let in beside ours, which stays: one they had given up never proves.
  const crossing = roomStream();
  internal.secureStreams.add(crossing);
  expect(internal.admitRoomStream(crossing, room)).toBe(true);
  expect(ours.close).not.toHaveBeenCalled();
  expect(crossing.replaces).toBe(ours);
  // Past the handshake window a hello of theirs can only mean their end of ours is gone.
  vi.advanceTimersByTime(10_000);
  const reopened = roomStream();
  internal.secureStreams.add(reopened);
  expect(internal.admitRoomStream(reopened, room)).toBe(true);
  expect(ours.close).toHaveBeenCalledOnce();
  expect(crossing.close).toHaveBeenCalledOnce();
  expect(reopened.replaces).toBeNull();
  // Still refused outright while ours has yet to prove.
  internal.secureStreams.clear();
  internal.secureStreams.add(roomStream({ outgoing: true, room }));
  expect(internal.admitRoomStream(roomStream(), room)).toBe(false);
});

it("does not count a member the relay says left back in over the channel their leaving is closing, unless it lists them again", async () => {
  const { t, internal, room } = transport();
  internal.node = { peerId: { toString: () => "alice" } };
  internal.dialPeer = vi.fn(async () => {});
  internal.connectedPeers.add("bob");
  const channel = { verified: true };
  const live = roomStream({ room, channel, provenAt: Date.now() });
  internal.secureStreams.add(live);
  internal.roomMembers.set(room, new Map([["bob", live.connection]]));
  internal.handleRendezvousMsg("alice", { type: "PEER_LEFT", room, peer: "bob" });
  // A send before the reset of their channel lands still goes over it...
  expect(await internal.ensureSecureRoom("bob", room)).toBe(channel);
  expect(t.isRoomPeer(room, "bob")).toBe(true);
  // ...and once it lands, they are gone: that send proved nothing.
  internal.secureStreams.delete(live);
  expect(t.isRoomPeer(room, "bob")).toBe(false);
  // A relay bounce instead - PEER_LEFT, then listed again - and the channel
  // still open is proof once more.
  const bounced = roomStream({ room, channel, provenAt: Date.now() });
  internal.secureStreams.add(bounced);
  internal.handleRendezvousMsg("alice", { type: "PEER_LEFT", room, peer: "bob" });
  internal.handleRendezvousMsg("alice", { type: "PEER_JOINED", room, peer: "bob" });
  await vi.waitFor(() => expect(internal.roomMembers.get(room)?.has("bob")).toBe(true));
  internal.secureStreams.delete(bounced);
  expect(t.isRoomPeer(room, "bob")).toBe(true);
});
