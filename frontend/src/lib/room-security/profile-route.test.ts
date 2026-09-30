import { expect, it } from "vitest";
import { profileDeliveryRoom, profileRoomsForPeer } from "./profile-route";

it("does not disclose profiles through legacy or relay-only membership in a v2 session", () => {
  const members = (room: string) => room === "old" ? ["mallory"] : ["alice"];
  expect(profileDeliveryRoom(["old", "rd2_room"], "mallory", members)).toBeNull();
  expect(profileDeliveryRoom(["rd2_room"], "alice", members)).toBe("rd2_room");
});

it("preserves the legacy session until the coordinated cutover", () => {
  expect(profileDeliveryRoom(["old"], "alice", () => [])).toBeUndefined();
});

it("targets each shared chat room only after support is known, excluding DMs and strangers", () => {
  const rooms = ["rd2_one", "rd2_two", "dm-alice", "rd2_other"];
  const members = (room: string) => room === "rd2_other" ? ["stranger"] : ["alice"];
  expect(profileRoomsForPeer(rooms, "alice", true, members)).toEqual(["rd2_one", "rd2_two"]);
  expect(profileRoomsForPeer(rooms, "alice", false, members)).toEqual([]);
  expect(profileRoomsForPeer(rooms, "unknown", true, members)).toEqual([]);
});
