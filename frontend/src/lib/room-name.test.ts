import { describe, expect, it } from "vitest";
import { isChosenName, judgeRoomName, nextNameStamp } from "./room-name";

const NOW = 1_800_000_000_000;
const room = (name: string, nameAt?: number) => ({ roomCode: "rd2_x", name, nameAt });

describe("judgeRoomName", () => {
  it("takes a newer name and answers an older one", () => {
    expect(judgeRoomName(room("Book club", NOW - 100), "Reading", NOW - 50, NOW)).toBe("take");
    // The member who was offline during the rename re-announces the old name.
    expect(judgeRoomName(room("Reading", NOW - 50), "Book club", NOW - 100, NOW)).toBe("answer");
  });

  it("never lets the placeholder from a bare link win, and lets any name replace it", () => {
    expect(isChosenName(room("Room", 0))).toBe(false);
    expect(judgeRoomName(room("Room", 0), "Book club", undefined, NOW)).toBe("take");
    expect(judgeRoomName(room("rd2_x"), "Book club", NOW - 1, NOW)).toBe("take");
  });

  it("puts names from before timestamps behind any rename since", () => {
    expect(judgeRoomName(room("Old"), "New", NOW - 1, NOW)).toBe("take");
    expect(judgeRoomName(room("New", NOW - 1), "Old", undefined, NOW)).toBe("answer");
  });

  it("settles a tie the same way on both sides", () => {
    const a = judgeRoomName(room("Alpha", NOW - 10), "Beta", NOW - 10, NOW);
    const b = judgeRoomName(room("Beta", NOW - 10), "Alpha", NOW - 10, NOW);
    expect([a, b].sort()).toEqual(["answer", "take"]);
    expect(a).toBe("take");
    expect(judgeRoomName(room("Same", NOW - 10), "Same", NOW - 10, NOW)).toBe("keep");
  });

  it("ignores a stamp from a clock far in the future, or no stamp at all", () => {
    expect(judgeRoomName(room("Book club", NOW - 100), "Hijack", NOW + 2 * 3600_000, NOW)).toBe("keep");
    expect(judgeRoomName(room("Book club", NOW - 100), "Broken", Number.NaN, NOW)).toBe("keep");
    expect(judgeRoomName(room("Book club", NOW - 100), "Broken", 0, NOW)).toBe("keep");
  });
});

describe("nextNameStamp", () => {
  it("stamps a rename after the name it replaces, even behind a fast clock elsewhere", () => {
    expect(nextNameStamp(room("A", NOW - 5), NOW)).toBe(NOW);
    expect(nextNameStamp(room("A", NOW + 60_000), NOW)).toBe(NOW + 60_001);
    expect(nextNameStamp(undefined, NOW)).toBe(NOW);
  });
});
