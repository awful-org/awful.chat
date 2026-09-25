import { describe, expect, it } from "vitest";
import { MAX_WATCHED, latestWatched, watchedFromWire } from "./watch-presence";

describe("watchedFromWire", () => {
  it("reads every share from a newer sender", () => {
    expect(watchedFromWire({ watching: "b", watchingAll: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("reads the single share from an older sender", () => {
    expect(watchedFromWire({ watching: "a" })).toEqual(["a"]);
    expect(watchedFromWire({ watching: null })).toEqual([]);
  });

  it("drops junk and caps the list", () => {
    expect(watchedFromWire({ watchingAll: ["a", 7, null, "b"] })).toEqual(["a", "b"]);
    const many = Array.from({ length: 100 }, (_, i) => `p${i}`);
    expect(watchedFromWire({ watchingAll: many })).toHaveLength(MAX_WATCHED);
  });
});

describe("latestWatched", () => {
  it("is the last share started, or null", () => {
    expect(latestWatched(new Map())).toBeNull();
    expect(latestWatched(new Map([["a", "1"], ["b", "2"]]))).toBe("b");
  });
});
