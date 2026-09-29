import { expect, it } from "vitest";
import { profileDeliveryRoom } from "./profile-route";

it("does not disclose profiles through legacy or relay-only membership in a v2 session", () => {
  const members = (room: string) => room === "old" ? ["mallory"] : ["alice"];
  expect(profileDeliveryRoom(["old", "rd2_room"], "mallory", members)).toBeNull();
  expect(profileDeliveryRoom(["rd2_room"], "alice", members)).toBe("rd2_room");
});

it("preserves the legacy session until the coordinated cutover", () => {
  expect(profileDeliveryRoom(["old"], "alice", () => [])).toBeUndefined();
});
