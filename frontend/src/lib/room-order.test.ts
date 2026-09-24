import { describe, expect, it } from "vitest";
import { dropIndex, moveItem, slotTop, sortRooms } from "./room-order";
import type { Room } from "./storage";

const room = (roomCode: string, extra: Partial<Room> = {}): Room => ({
  roomCode,
  type: "text",
  name: roomCode,
  lastSeenLamport: 0,
  createdAt: 0,
  participants: [],
  ...extra,
});

const codes = (list: Room[]) => list.map((r) => r.roomCode);

describe("sortRooms", () => {
  it("keeps the incoming order when nothing is pinned or placed", () => {
    expect(codes(sortRooms([room("a"), room("b"), room("c")]))).toEqual(["a", "b", "c"]);
  });

  it("lays placed rooms out by position, unplaced ones after in incoming order", () => {
    const list = [room("a"), room("b", { position: 1 }), room("c"), room("d", { position: 0 })];
    expect(codes(sortRooms(list))).toEqual(["d", "b", "a", "c"]);
  });

  it("puts pinned rooms first, oldest pin on top, whatever their position", () => {
    const list = [
      room("a", { position: 0 }),
      room("b", { pinnedAt: 200, position: 5 }),
      room("c", { pinnedAt: 100 }),
    ];
    expect(codes(sortRooms(list))).toEqual(["c", "b", "a"]);
  });
});

describe("moveItem", () => {
  it("moves an item up and down", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

// Three 40px rows stacked from the top.
const boxes = [0, 40, 80].map((top) => ({ top, height: 40 }));

describe("dropIndex", () => {
  it("stays put until the dragged center crosses a neighbour's midpoint", () => {
    expect(dropIndex(boxes, 0, 20)).toBe(0);
    expect(dropIndex(boxes, 0, 59)).toBe(0);
  });

  it("moves DOWN past the next row once its midpoint is crossed", () => {
    // The old rule inserted before the row under the pointer, which put a
    // row dragged onto its lower neighbour straight back where it was.
    expect(dropIndex(boxes, 0, 61)).toBe(1);
    expect(dropIndex(boxes, 0, 101)).toBe(2);
  });

  it("moves UP past the previous row once its midpoint is crossed", () => {
    expect(dropIndex(boxes, 2, 59)).toBe(1);
    expect(dropIndex(boxes, 2, 19)).toBe(0);
  });

  it("clamps past either end", () => {
    expect(dropIndex(boxes, 1, -500)).toBe(0);
    expect(dropIndex(boxes, 1, 500)).toBe(2);
  });
});

describe("slotTop", () => {
  it("is the row's own top when it has not moved", () => {
    expect(slotTop(boxes, 1, 1)).toBe(40);
  });

  it("takes the displaced row's top moving up", () => {
    expect(slotTop(boxes, 2, 0)).toBe(0);
  });

  it("sits after the rows that slid up moving down", () => {
    expect(slotTop(boxes, 0, 2)).toBe(80);
    const mixed = [
      { top: 0, height: 30 },
      { top: 30, height: 50 },
    ];
    expect(slotTop(mixed, 0, 1)).toBe(50);
  });
});
