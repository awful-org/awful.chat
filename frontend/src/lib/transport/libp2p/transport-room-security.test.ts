import { expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
vi.mock("@libp2p/peer-id", async (original) => ({
  ...await original<typeof import("@libp2p/peer-id")>(),
  peerIdFromString: (peer: string) => ({ toString: () => peer }),
}));
import { LibP2PTransport } from "./transport";
import { newRoomSecret } from "$lib/room-security/keys";
import { lockIdentity } from "$lib/identity/identity";
import { ROOM_SECURITY_V2_RELEASED } from "$lib/room-security/invitation-release";

it("cancels a pending connection when identity lock revokes its room", async () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  transport.joinSecureRoom(newRoomSecret());
  t.installStreamNoiseFilter = () => {};
  let finish!: (key: undefined) => void;
  t.privateKeyFromRawKey = () => new Promise(resolve => { finish = resolve; });
  const pending = transport.connect(new Uint8Array(32));
  const rejected = expect(pending).rejects.toThrow("cancelled");
  lockIdentity();
  finish(undefined);
  await rejected;
  expect(t.node).toBeNull();
  expect(t.secureRooms.size).toBe(0);
});

it("revokes retained capabilities synchronously on identity lock before socket shutdown", async () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  const room = transport.joinSecureRoom(newRoomSecret());
  let finish!: () => void;
  t.node = { stop: () => new Promise<void>(resolve => { finish = resolve; }) };
  t.rendezvousSend = vi.fn();
  lockIdentity();
  expect(t.secureRooms.size).toBe(0);
  expect(await transport.sendRoom("bob", room, new Uint8Array([1]))).toBe(false);
  finish();
});

it("registers only a derived identifier and blocks accidentally registering the root", () => {
  const transport = new LibP2PTransport();
  const register = vi.fn();
  const t = transport as any;
  t.rendezvousSend = register;
  const secret = newRoomSecret();
  const room = transport.joinSecureRoom(secret);
  expect(register).toHaveBeenCalledWith({ type: "REGISTER", room });
  expect(JSON.stringify(register.mock.calls)).not.toContain(secret);
  expect(() => transport.joinRoom(secret)).toThrow();
  expect(() => transport.joinRoom("rd2_" + "A".repeat(43))).toThrow();
});

it("never falls back to plaintext for a missing v2 capability", async () => {
  const transport = new LibP2PTransport();
  const plaintext = vi.spyOn(transport, "send");
  expect(await transport.sendRoom("bob", "rd2_" + "A".repeat(43), new Uint8Array([1]))).toBe(false);
  expect(await transport.sendRoom("bob", newRoomSecret(), new Uint8Array([1]))).toBe(false);
  expect(plaintext).not.toHaveBeenCalled();
});

it("keeps a local DM reference off discovery and fails closed after leaving", async () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  t.rendezvousSend = vi.fn();
  const plaintext = vi.spyOn(transport, "send");
  const local = "dm-" + "a".repeat(40);
  const secret = newRoomSecret();
  const wire = transport.joinSecureConversation(local, secret);
  expect(transport.rooms()).toEqual([local]);
  expect(transport.isSecureRoom(local)).toBe(true);
  expect(t.rendezvousSend).toHaveBeenCalledExactlyOnceWith({ type: "REGISTER", room: wire });
  expect(JSON.stringify(t.rendezvousSend.mock.calls)).not.toContain(local);
  expect(JSON.stringify(t.rendezvousSend.mock.calls)).not.toContain(secret);
  transport.leaveRoom(local);
  expect(t.rendezvousSend).toHaveBeenLastCalledWith({ type: "UNREGISTER", room: wire });
  expect(transport.rooms()).toEqual([]);
  expect(await transport.sendRoom("bob", local, new Uint8Array([1]))).toBe(false);
  expect(() => transport.joinRoom(local)).toThrow(ROOM_SECURITY_V2_RELEASED ? "Legacy rooms are read-only" : "Missing room capability");
  await transport.disconnect();
  expect(await transport.sendRoom("bob", local, new Uint8Array([1]))).toBe(false);
  expect(plaintext).not.toHaveBeenCalled();
  expect(transport.joinSecureConversation(local, secret)).toBe(wire);
});

it("rejects unprotected DM joins and conflicting capability bindings", () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  t.rendezvousSend = vi.fn();
  const local = "dm-" + "a".repeat(40);
  const secret = newRoomSecret();
  expect(() => transport.joinRoom(local)).toThrow(ROOM_SECURITY_V2_RELEASED ? "Legacy rooms are read-only" : "Missing room capability");
  transport.joinSecureConversation(local, secret);
  expect(() => transport.joinSecureConversation(local, newRoomSecret())).toThrow("Conflicting");
  expect(() => transport.joinSecureConversation("dm-" + "b".repeat(40), secret)).toThrow("Conflicting");
  expect(() => transport.joinSecureConversation("not-a-dm", secret)).toThrow("Invalid");
});

it("maps a relay roster back to the local conversation without authorizing its peers", () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  t.rendezvousSend = vi.fn();
  t.verifyDiscoveredRoomPeer = vi.fn();
  const local = "dm-" + "a".repeat(40);
  const wire = transport.joinSecureConversation(local, newRoomSecret());
  const roster = vi.fn();
  transport.on("roomPeers", roster);
  t.handleRendezvousMsg("alice", { type: "PEERS", room: wire, peers: ["mallory"] });
  expect(roster).toHaveBeenCalledWith(local, []);
  expect(transport.isRoomPeer(local, "mallory")).toBe(false);
});

it("does not authorize a peer just because the relay claims membership", () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  t.rendezvousSend = vi.fn();
  t.verifyDiscoveredRoomPeer = vi.fn();
  const room = transport.joinSecureRoom(newRoomSecret());
  t.connectedPeers.add("mallory");
  t.handleRendezvousMsg("alice", { type: "PEER_JOINED", room, peer: "mallory" });
  expect(t.verifyDiscoveredRoomPeer).toHaveBeenCalledWith(room, "mallory");
  expect(transport.peersInRoom(room)).toEqual([]);
  expect(transport.isRoomPeer(room, "mallory")).toBe(false);
});

it("single-flights concurrent secure sends and rejects a late dial after leaving", async () => {
  const transport = new LibP2PTransport();
  const t = transport as any;
  t.rendezvousSend = vi.fn();
  const room = transport.joinSecureRoom(newRoomSecret());
  let finish!: (connection: unknown) => void;
  const dial = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  t.node = { dial, peerId: { toString: () => "alice" } };
  const first = transport.sendSecureRoom("bob", room, new Uint8Array([1]));
  const second = transport.sendSecureRoom("bob", room, new Uint8Array([2]));
  expect(dial).toHaveBeenCalledOnce();
  transport.leaveRoom(room);
  const newStream = vi.fn();
  finish({ newStream });
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(newStream).not.toHaveBeenCalled();
  expect(t.secureOpening.size).toBe(0);
});
