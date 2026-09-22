import { describe, expect, it } from "vitest";
import { applyRoomOrder, moveRoomBefore } from "./room-order";
import type { Room } from "./storage";

const room = (roomCode: string): Room => ({
  roomCode,
  type: "text",
  name: roomCode,
  lastSeenLamport: 0,
  createdAt: 0,
  participants: [],
});

const rooms = [room("a"), room("b"), room("c")];

describe("applyRoomOrder", () => {
  it("is the identity with no stored order", () => {
    expect(applyRoomOrder(rooms, []).map((r) => r.roomCode)).toEqual(["a", "b", "c"]);
  });

  it("lays rooms out by the stored order", () => {
    expect(applyRoomOrder(rooms, ["c", "a", "b"]).map((r) => r.roomCode)).toEqual([
      "c", "a", "b",
    ]);
  });

  it("appends a room the order has never named, in its original relative position", () => {
    expect(applyRoomOrder(rooms, ["b"]).map((r) => r.roomCode)).toEqual(["b", "a", "c"]);
  });

  it("skips a roomCode the order names that no longer exists", () => {
    expect(applyRoomOrder(rooms, ["z", "c", "a", "b"]).map((r) => r.roomCode)).toEqual([
      "c", "a", "b",
    ]);
  });
});

describe("moveRoomBefore", () => {
  it("moves a room to sit just before another, starting from no stored order", () => {
    expect(moveRoomBefore(rooms, [], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("moves a room later in the list", () => {
    expect(moveRoomBefore(rooms, [], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("is a no-op dragging a room onto itself", () => {
    expect(moveRoomBefore(rooms, [], "a", "a")).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for a roomCode that does not exist", () => {
    expect(moveRoomBefore(rooms, [], "z", "a")).toEqual(["a", "b", "c"]);
    expect(moveRoomBefore(rooms, [], "a", "z")).toEqual(["a", "b", "c"]);
  });

  it("captures the pre-existing effective order, not just the stored one, on a first drag", () => {
    // "b" has never been named by `order`, so it sits after "c" (its original
    // relative position) until this drag moves it explicitly.
    expect(moveRoomBefore(rooms, ["c"], "b", "c")).toEqual(["b", "c", "a"]);
  });
});
