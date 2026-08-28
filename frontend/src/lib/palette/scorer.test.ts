import { describe, expect, it } from "vitest";
import {
  MAX_PATTERN,
  MAX_TEXT,
  match,
  matchExact,
  mergeRanges,
  span,
  toRanges,
} from "./scorer";

/** Convenience: the matcher requires pre-lowercased input. */
function score(text: string, pattern: string) {
  return match(text.toLowerCase(), pattern.toLowerCase());
}

describe("scorer", () => {
  describe("match", () => {
    // These four numbers are the reference values produced by fzf's
    // FuzzyMatchV2 for the label "Join Room". They pin the port to the
    // original algorithm, so a regression in the bonus table shows up here.
    it("scores an acronym match and reports both initials", () => {
      expect(score("Join Room", "jr")).toEqual({
        score: 56,
        positions: [0, 5],
      });
    });

    it("scores a contiguous prefix run", () => {
      expect(score("Join Room", "join")).toEqual({
        score: 114,
        positions: [0, 1, 2, 3],
      });
    });

    it("scores a contiguous run at a word boundary", () => {
      expect(score("Join Room", "room")).toEqual({
        score: 114,
        positions: [5, 6, 7, 8],
      });
    });

    it("scores an initial plus a following word above either alone", () => {
      expect(score("Join Room", "jroom")).toEqual({
        score: 134,
        positions: [0, 5, 6, 7, 8],
      });
    });

    it("returns null when the characters are not present in order", () => {
      expect(score("Join Room", "xq")).toBeNull();
      expect(score("Join Room", "mor")).toBeNull();
    });

    it("returns null for an empty pattern", () => {
      expect(match("join room", "")).toBeNull();
    });

    it("returns null when the pattern is longer than the text", () => {
      expect(score("ab", "abc")).toBeNull();
    });

    it("prefers a word-boundary match over a mid-word match", () => {
      // "Set Theme" starts a word with `t`; "Battery" buries it.
      const boundary = score("Set Theme", "t")!;
      const buried = score("Battery", "t")!;
      expect(boundary.score).toBeGreaterThan(buried.score);
    });

    it("rates start-of-string and after-a-space as the same boundary", () => {
      // Deliberate. fzf calibrates one boundary bonus, and preferring the
      // start of a title is the tier layer's job, not the character scorer's.
      // `rank.ts` puts a prefix match strictly above any fuzzy match, so
      // "Room settings" still beats "Open room" for the query `r`.
      expect(score("Room settings", "r")!.score).toBe(
        score("Open room", "r")!.score,
      );
    });


    it("credits camelCase boundaries like word boundaries", () => {
      const camel = score("joinRoom", "jr")!;
      expect(camel.positions).toEqual([0, 4]);
    });

    it("treats a letter-to-digit transition as a boundary", () => {
      const withDigit = score("room2", "r2")!;
      expect(withDigit.positions).toEqual([0, 4]);
    });

    it("prefers a tighter match over a scattered one", () => {
      const tight = score("mic mute", "mm")!;
      const scattered = score("maximize window frame", "mm")!;
      expect(tight.score).toBeGreaterThan(scattered.score);
    });

    it("charges less for one long gap than for several short ones", () => {
      // Affine gaps: opening costs -3, extending costs -1.
      const oneGap = score("abxxxxcd", "abcd")!;
      const manyGaps = score("axbxcxd", "abcd")!;
      expect(oneGap.score).toBeGreaterThan(manyGaps.score);
    });

    it("matches case-insensitively", () => {
      expect(score("PROFILE", "pro")).not.toBeNull();
      expect(score("profile", "PRO")).not.toBeNull();
    });

    it("matches accented and non-Latin text", () => {
      expect(score("Café Room", "caf")).not.toBeNull();
      expect(score("Комната", "ком")).not.toBeNull();
    });

    it("returns ascending positions", () => {
      const result = score("Toggle Screen Share", "tss")!;
      const sorted = [...result.positions].sort((a, b) => a - b);
      expect(result.positions).toEqual(sorted);
    });

    it("returns exactly one position per pattern character", () => {
      const result = score("Start Screen Share", "sss")!;
      expect(result.positions).toHaveLength(3);
    });

    it("refuses a pattern longer than the cap", () => {
      expect(match("a".repeat(300), "a".repeat(MAX_PATTERN + 1))).toBeNull();
    });

    it("stays bounded on a pathological low-entropy label", () => {
      // The cmdk scorer costs ~29 ms for this shape because it has no cap.
      // Here the text is truncated to MAX_TEXT and the DP is bounded, so the
      // call has to stay far below a frame budget.
      const text = "a".repeat(2000);
      const started = performance.now();
      const result = match(text, "a".repeat(8));
      const elapsed = performance.now() - started;
      expect(result).not.toBeNull();
      expect(elapsed).toBeLessThan(5);
    });

    it("only considers the first MAX_TEXT characters", () => {
      const text = `${"b".repeat(MAX_TEXT)}z`;
      expect(match(text, "z")).toBeNull();
    });
  });

  describe("toRanges", () => {
    it("collapses consecutive positions into one range", () => {
      expect(toRanges([0, 1, 2])).toEqual([{ start: 0, end: 3 }]);
    });

    it("splits non-consecutive positions", () => {
      expect(toRanges([0, 5, 6])).toEqual([
        { start: 0, end: 1 },
        { start: 5, end: 7 },
      ]);
    });

    it("returns nothing for no positions", () => {
      expect(toRanges([])).toEqual([]);
    });
  });

  describe("mergeRanges", () => {
    it("merges overlapping ranges", () => {
      expect(
        mergeRanges([
          { start: 0, end: 4 },
          { start: 2, end: 6 },
        ]),
      ).toEqual([{ start: 0, end: 6 }]);
    });

    it("merges touching ranges", () => {
      expect(
        mergeRanges([
          { start: 0, end: 2 },
          { start: 2, end: 4 },
        ]),
      ).toEqual([{ start: 0, end: 4 }]);
    });

    it("keeps disjoint ranges apart and sorts them", () => {
      expect(
        mergeRanges([
          { start: 8, end: 9 },
          { start: 0, end: 2 },
        ]),
      ).toEqual([
        { start: 0, end: 2 },
        { start: 8, end: 9 },
      ]);
    });

    it("does not mutate its input", () => {
      const input = [{ start: 2, end: 4 }, { start: 0, end: 3 }];
      mergeRanges(input);
      expect(input).toEqual([{ start: 2, end: 4 }, { start: 0, end: 3 }]);
    });
  });

  describe("span", () => {
    it("measures the distance the match covers", () => {
      expect(span([0, 5])).toBe(6);
      expect(span([0, 1, 2])).toBe(3);
    });

    it("is zero for no positions", () => {
      expect(span([])).toBe(0);
    });
  });

  describe("matchExact", () => {
    it("finds a contiguous substring", () => {
      const result = matchExact("join room", "n r")!;
      expect(result.positions).toEqual([3, 4, 5]);
    });

    it("rejects a non-contiguous pattern that fuzzy matching would accept", () => {
      expect(match("join room", "jr")).not.toBeNull();
      expect(matchExact("join room", "jr")).toBeNull();
    });

    it("scores a match at the start above a match in the middle", () => {
      const atStart = matchExact("room list", "room")!;
      const inMiddle = matchExact("open room", "room")!;
      expect(atStart.score).toBeGreaterThan(inMiddle.score);
    });

    it("returns null for an empty pattern", () => {
      expect(matchExact("join room", "")).toBeNull();
    });
  });
});
