import { describe, expect, it } from "vitest";
import { Mru, MRU_LIMIT } from "./mru";

describe("mru", () => {
  describe("rank", () => {
    it("returns undefined for an id that was never touched", () => {
      const mru = new Mru();
      expect(mru.rank("never-seen")).toBeUndefined();
    });
  });

  describe("touch", () => {
    it("makes a touched id outrank one touched earlier", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      expect(mru.rank("b")).toBeGreaterThan(mru.rank("a")!);
    });

    it("moves a re-touched id back to the front", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      mru.touch("a");
      expect(mru.rank("a")).toBeGreaterThan(mru.rank("b")!);
    });
  });

  describe("recent", () => {
    it("returns ids from most to least recent", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      mru.touch("c");
      expect(mru.recent()).toEqual(["c", "b", "a"]);
    });

    it("honours its limit", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      mru.touch("c");
      expect(mru.recent(2)).toEqual(["c", "b"]);
    });
  });

  describe("forget", () => {
    it("removes exactly one id and reports that it did", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      expect(mru.forget("a")).toBe(true);
      expect(mru.rank("a")).toBeUndefined();
      expect(mru.rank("b")).toBeDefined();
    });

    it("reports false when the id was never tracked", () => {
      const mru = new Mru();
      expect(mru.forget("ghost")).toBe(false);
    });
  });

  describe("size", () => {
    it("tracks insertions", () => {
      const mru = new Mru();
      expect(mru.size).toBe(0);
      mru.touch("a");
      mru.touch("b");
      expect(mru.size).toBe(2);
    });

    it("does not grow when re-touching an existing id", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("a");
      expect(mru.size).toBe(1);
    });
  });

  describe("bound", () => {
    it("keeps size at MRU_LIMIT and evicts the least recent id once exceeded", () => {
      const mru = new Mru();
      for (let i = 0; i < MRU_LIMIT + 5; i++) mru.touch(`id${i}`);

      expect(mru.size).toBe(MRU_LIMIT);
      // The first five touches were the least recent, so they are gone.
      expect(mru.rank("id0")).toBeUndefined();
      expect(mru.rank("id4")).toBeUndefined();
      // The most recent touch survives.
      expect(mru.rank(`id${MRU_LIMIT + 4}`)).toBeDefined();
    });
  });

  describe("round trip", () => {
    it("preserves ordering through toJSON/fromJSON", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      mru.touch("c");

      const restored = Mru.fromJSON(mru.toJSON());
      expect(restored.recent()).toEqual(mru.recent());
    });

    it("resumes the counter above every restored rank, so a new touch still outranks them all", () => {
      const mru = new Mru();
      mru.touch("a");
      mru.touch("b");
      mru.touch("c");

      const restored = Mru.fromJSON(mru.toJSON());
      restored.touch("fresh");

      expect(restored.recent()[0]).toBe("fresh");
      expect(restored.rank("fresh")!).toBeGreaterThan(restored.rank("c")!);
    });
  });

  describe("fromJSON malformed input", () => {
    it("returns a usable empty Mru for null", () => {
      expect(Mru.fromJSON(null).size).toBe(0);
    });

    it("returns a usable empty Mru for a non-object", () => {
      expect(Mru.fromJSON("not an object").size).toBe(0);
    });

    it("returns a usable empty Mru when entries is missing", () => {
      expect(Mru.fromJSON({ counter: 5 }).size).toBe(0);
    });

    it("returns a usable empty Mru when entries is not an array", () => {
      expect(Mru.fromJSON({ counter: 5, entries: "nope" }).size).toBe(0);
    });

    it("drops entries whose id is not a string", () => {
      const mru = Mru.fromJSON({ counter: 1, entries: [[42, 1]] });
      expect(mru.size).toBe(0);
    });

    it("drops entries whose rank is not a finite number", () => {
      const mru = Mru.fromJSON({
        counter: 1,
        entries: [
          ["a", "notanumber"],
          ["b", Number.POSITIVE_INFINITY],
          ["c", 3],
        ],
      });
      expect(mru.size).toBe(1);
      expect(mru.rank("c")).toBeDefined();
    });

    it("filters malformed entries but keeps the well-formed ones, without throwing", () => {
      expect(() =>
        Mru.fromJSON({
          counter: 1,
          entries: [
            ["a", 1],
            "not-an-entry",
            ["b"],
            ["c", 2],
          ],
        }),
      ).not.toThrow();

      const mru = Mru.fromJSON({
        counter: 1,
        entries: [
          ["a", 1],
          "not-an-entry",
          ["b"],
          ["c", 2],
        ],
      });
      expect(mru.size).toBe(2);
      expect(mru.rank("a")).toBeDefined();
      expect(mru.rank("c")).toBeDefined();
    });

    it("derives a usable counter when counter itself is missing", () => {
      const mru = Mru.fromJSON({ entries: [["a", 7]] });
      mru.touch("fresh");
      expect(mru.rank("fresh")!).toBeGreaterThan(7);
    });
  });
});
