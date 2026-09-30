import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
import { LibP2PTransport } from "./transport";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";

afterEach(() => { vi.useRealTimers(); });

function transport() {
  const t = new LibP2PTransport();
  const internal = t as any;
  internal.rendezvousSend = vi.fn();
  return { t, internal, register: internal.rendezvousSend as ReturnType<typeof vi.fn> };
}
const local = "dm-" + "a".repeat(40);

it("moves a live classical DM onto its post-quantum secret in place", () => {
  const { t, internal, register } = transport();
  const classical = newRoomSecret(), hybrid = newRoomSecret();
  const d0 = t.joinSecureConversation(local, classical);
  const d1 = t.joinSecureConversation(local, hybrid, classical);
  expect(d1).toBe(deriveRoomKeys(hybrid).discoveryId);
  expect(d1).not.toBe(d0);
  // The classical room is left - keys gone, unregistered - before the new
  // one is joined, and the conversation keeps its local ID.
  expect(internal.secureRooms.has(d0)).toBe(false);
  expect(internal.secureRooms.has(d1)).toBe(true);
  expect(t.rooms()).toEqual([local]);
  expect(register).toHaveBeenCalledWith({ type: "UNREGISTER", room: d0 });
  expect(register).toHaveBeenLastCalledWith({ type: "REGISTER", room: d1 });
  // ...and the classical ID is watched as a lobby, not joined as a room.
  expect(register.mock.calls.filter(([m]) => m.type === "REGISTER" && m.room === d0)).toHaveLength(2);
  expect(internal.joinedRooms.has(d0)).toBe(false);
});

it("refuses to go back to the classical secret once post-quantum", () => {
  const { t } = transport();
  const classical = newRoomSecret(), hybrid = newRoomSecret();
  t.joinSecureConversation(local, classical);
  t.joinSecureConversation(local, hybrid, classical);
  expect(() => t.joinSecureConversation(local, classical)).toThrow("Conflicting");
  // Re-joining the same post-quantum secret is fine.
  expect(t.joinSecureConversation(local, hybrid, classical)).toBe(deriveRoomKeys(hybrid).discoveryId);
});

it("joins a new conversation post-quantum directly, without ever joining classical", () => {
  const { t, internal, register } = transport();
  const classical = newRoomSecret(), hybrid = newRoomSecret();
  const d0 = deriveRoomKeys(classical).discoveryId;
  t.joinSecureConversation(local, hybrid, classical);
  expect(internal.secureRooms.has(d0)).toBe(false);
  expect(register).toHaveBeenCalledWith({ type: "REGISTER", room: d0 });
  expect(() => t.joinSecureConversation(local, classical)).toThrow("Conflicting");
});

it("only rebinds onto a post-quantum secret of the SAME conversation", () => {
  const { t } = transport();
  const classical = newRoomSecret();
  t.joinSecureConversation(local, classical);
  // Another conversation's classical anchor: not an upgrade of this one.
  expect(() => t.joinSecureConversation(local, newRoomSecret(), newRoomSecret())).toThrow("Conflicting");
  // A "post-quantum" secret that is the classical one is not an upgrade.
  expect(() => t.joinSecureConversation(local, classical, classical)).toThrow();
  // Nor may another conversation claim this one's anchor.
  expect(() => t.joinSecureConversation("dm-" + "b".repeat(40), newRoomSecret(), classical)).toThrow("Conflicting");
});

it("allows replacing one post-quantum state by another for the same conversation", () => {
  const { t, internal } = transport();
  const classical = newRoomSecret(), first = newRoomSecret(), second = newRoomSecret();
  t.joinSecureConversation(local, first, classical);
  const d2 = t.joinSecureConversation(local, second, classical);
  expect(internal.secureRooms.has(deriveRoomKeys(first).discoveryId)).toBe(false);
  expect(internal.secureRooms.has(d2)).toBe(true);
});

it("introduces peers found in the lobby, once per peer, unless already in the PQ room", async () => {
  vi.useFakeTimers();
  const { t, internal } = transport();
  const classical = newRoomSecret();
  const d0 = deriveRoomKeys(classical).discoveryId;
  t.joinSecureConversation(local, newRoomSecret(), classical);
  const introduce = vi.spyOn(t, "introduceDm").mockResolvedValue(true);
  internal.node = { peerId: { toString: () => "me" } };
  const roster = vi.fn();
  t.on("roomPeers", roster);
  internal.handleRendezvousMsg("me", { type: "PEERS", room: d0, peers: ["old-device", "me"] });
  internal.handleRendezvousMsg("me", { type: "PEER_JOINED", room: d0, peer: "old-device" });
  vi.spyOn(t, "isRoomPeer").mockImplementation((_room, peer) => peer === "upgraded-device");
  internal.handleRendezvousMsg("me", { type: "PEER_JOINED", room: d0, peer: "upgraded-device" });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(introduce).toHaveBeenCalledTimes(1);
  expect(introduce).toHaveBeenCalledWith("old-device");
  // A lobby is not a room: no roster, no membership, nothing to verify.
  expect(roster).not.toHaveBeenCalled();
  expect(t.isSecureRoom(local)).toBe(true);
});

it("stops watching the lobby when the conversation is left or the identity locks", () => {
  const { t, internal, register } = transport();
  const classical = newRoomSecret();
  const d0 = deriveRoomKeys(classical).discoveryId;
  t.joinSecureConversation(local, newRoomSecret(), classical);
  t.leaveRoom(local);
  expect(register).toHaveBeenCalledWith({ type: "UNREGISTER", room: d0 });
  expect(internal.dmLobbies.size).toBe(0);
  t.joinSecureConversation(local, newRoomSecret(), classical);
  expect(internal.dmLobbies.size).toBe(1);
  t.clearRoomSecurity();
  expect(internal.dmLobbies.size).toBe(0);
});
