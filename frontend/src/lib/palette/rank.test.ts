import { describe, expect, it } from "vitest";
import { compareRanked, flatten, rank, scoreCmd, RECENT_GROUP } from "./rank";
import { parseQuery } from "./query";
import { Mru } from "./mru";
import type { Cmd, RankedCmd, RankedGroup } from "./types";

/** A minimal, uniquely-idd command. Fills in the boring bits every fixture needs. */
function cmd(partial: Partial<Cmd> & { title: string; id?: string }): Cmd {
  return {
    group: "Test",
    action: { kind: "act", perform() {} },
    ...partial,
    id: partial.id ?? partial.title,
  };
}

const emptyMru = new Mru();
const emptySeq = new Map<string, number>();

describe("rank", () => {
  describe("scoreCmd", () => {
    it("accepts every command when there are zero terms", () => {
      const c = cmd({ title: "Anything at all" });
      expect(scoreCmd(c, [])).not.toBeNull();
    });

    it("returns null when any term fails, even if another term matched strongly", () => {
      // "settings" is a whole-title hit; "zzzzzzz" matches nothing on the
      // command at all. One failing term must veto the whole row.
      const c = cmd({ title: "Settings" });
      const terms = parseQuery("settings zzzzzzz").terms;
      expect(scoreCmd(c, terms)).toBeNull();
    });

    it("keeps a leading-phrase match ahead of a scattered one across terms", () => {
      // Regression, caught by driving the real palette. Both rows land in
      // TIER_TITLE because their second term only fuzzy-matches, so the raw
      // character score decides. The prefix term used to contribute a flat
      // length boost instead of a real score, which let the scattered title
      // win on points.
      const leading = cmd({ title: "Join room by code" });
      const scattered = cmd({ title: "Create or join a room" });
      const terms = parseQuery("join room").terms;

      const a = scoreCmd(leading, terms)!;
      const b = scoreCmd(scattered, terms)!;
      expect(a.score).toBeGreaterThan(b.score);
      expect(compareRanked(a, b, emptyMru, emptySeq)).toBeLessThan(0);
    });

    it("takes a command's weakest term's tier, not its strongest", () => {
      // "settings" hits the title exactly (the strongest possible tier);
      // "audio" only hits the subtitle. The row must carry the subtitle tier.
      const c = cmd({ title: "Settings", subtitle: "audio device" });
      const terms = parseQuery("settings audio").terms;
      const scored = scoreCmd(c, terms);
      expect(scored).not.toBeNull();

      const titleOnly = scoreCmd(cmd({ title: "Settings" }), parseQuery("settings").terms);
      // The combined score's tier is strictly weaker than the title-only tier.
      expect(scored!.tier).toBeLessThan(titleOnly!.tier);
    });

    describe("tier ordering is absolute", () => {
      // Tiers are spaced so far apart that no amount of character score can
      // cross one. These four checks defend that "tiers, not blending" design.
      const prefixCmd = cmd({ title: "Room settings" });
      const titleFuzzyCmd = cmd({ title: "Warehouse chatroom exploration hub" });
      const keywordCmd = cmd({ title: "Random Panel", keywords: ["zephyr"] });
      const subtitleCmd = cmd({ title: "Random Panel Two", subtitle: "wisteria lane" });

      const prefixRow = scoreCmd(prefixCmd, parseQuery("room").terms)!;
      const titleFuzzyRow = scoreCmd(titleFuzzyCmd, parseQuery("room").terms)!;
      const keywordRow = scoreCmd(keywordCmd, parseQuery("zephyr").terms)!;
      const subtitleRow = scoreCmd(subtitleCmd, parseQuery("wisteria").terms)!;

      it("resolved every fixture to a real row", () => {
        expect(prefixRow).not.toBeNull();
        expect(titleFuzzyRow).not.toBeNull();
        expect(keywordRow).not.toBeNull();
        expect(subtitleRow).not.toBeNull();
      });

      it("ranks a title prefix match above a much longer, better-scoring title fuzzy hit", () => {
        expect(prefixRow.tier).toBeGreaterThan(titleFuzzyRow.tier);
        expect(compareRanked(prefixRow, titleFuzzyRow, emptyMru, emptySeq)).toBeLessThan(0);
      });

      it("ranks a title fuzzy hit above a keyword hit", () => {
        expect(titleFuzzyRow.tier).toBeGreaterThan(keywordRow.tier);
        expect(compareRanked(titleFuzzyRow, keywordRow, emptyMru, emptySeq)).toBeLessThan(0);
      });

      it("ranks a keyword hit above a subtitle-only hit", () => {
        expect(keywordRow.tier).toBeGreaterThan(subtitleRow.tier);
        expect(compareRanked(keywordRow, subtitleRow, emptyMru, emptySeq)).toBeLessThan(0);
      });
    });

    it("lets a shorter title win a prefix tie (\"Room\" before \"Room settings\")", () => {
      const terms = parseQuery("room").terms;
      const room = scoreCmd(cmd({ title: "Room" }), terms)!;
      const roomSettings = scoreCmd(cmd({ title: "Room settings" }), terms)!;
      expect(compareRanked(room, roomSettings, emptyMru, emptySeq)).toBeLessThan(0);
    });

    it("marks the matched characters in titleRanges, merging a multi-term query into one ascending non-overlapping list", () => {
      const c = cmd({ title: "Room Settings Panel" });
      const terms = parseQuery("room panel").terms;
      const scored = scoreCmd(c, terms)!;

      expect(scored.titleRanges.length).toBeGreaterThan(1);
      for (let i = 1; i < scored.titleRanges.length; i++) {
        expect(scored.titleRanges[i].start).toBeGreaterThanOrEqual(scored.titleRanges[i - 1].end);
      }
      // The prefix hit on "room" covers the first four characters.
      expect(scored.titleRanges[0]).toEqual({ start: 0, end: 4 });
    });

    it("produces no titleRanges for a keyword-only match, because keywords are not on screen", () => {
      const c = cmd({ title: "Random Panel", keywords: ["zephyr"] });
      const scored = scoreCmd(c, parseQuery("zephyr").terms)!;
      expect(scored.titleRanges).toEqual([]);
    });

    it("rejects a quoted term that only fuzzy-matches non-contiguously", () => {
      const c = cmd({ title: "Settings" });
      expect(scoreCmd(c, parseQuery('"stg"').terms)).toBeNull();
      // The same characters, unquoted, are a legitimate fuzzy hit.
      expect(scoreCmd(c, parseQuery("stg").terms)).not.toBeNull();
    });
  });

  describe("compareRanked", () => {
    it("never returns 0 for two different commands", () => {
      const fixtures = [
        cmd({ title: "Room settings" }),
        cmd({ title: "Warehouse chatroom exploration hub" }),
        cmd({ title: "Random Panel", keywords: ["zephyr"] }),
        cmd({ title: "Random Panel Two", subtitle: "wisteria lane" }),
        cmd({ title: "Room" }),
      ];
      const queries = ["room", "room", "zephyr", "wisteria", "room"];
      const rows = fixtures.map((c, i) => scoreCmd(c, parseQuery(queries[i]).terms)!);

      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows.length; j++) {
          if (i === j) continue;
          expect(compareRanked(rows[i], rows[j], emptyMru, emptySeq)).not.toBe(0);
        }
      }
    });

    it("sorts the same way regardless of starting order (a stable total order)", () => {
      const fixtures = [
        cmd({ id: "a", title: "Room" }),
        cmd({ id: "b", title: "A room mention buried deep inside" }),
        cmd({ id: "c", title: "Another chatroom reference somewhere in here" }),
      ];
      const terms = parseQuery("room").terms;
      const rows = fixtures.map((c) => scoreCmd(c, terms)!);

      const forward = [...rows].sort((a, b) => compareRanked(a, b, emptyMru, emptySeq));
      const backward = [...rows]
        .reverse()
        .sort((a, b) => compareRanked(a, b, emptyMru, emptySeq));

      expect(backward.map((r) => r.cmd.id)).toEqual(forward.map((r) => r.cmd.id));
    });

    it("lets recency break a tie within a tier", () => {
      const untouched = cmd({ id: "untouched", title: "A room mention buried deep inside" });
      const touched = cmd({ id: "touched", title: "Another chatroom reference in here too" });
      const terms = parseQuery("room").terms;

      const rowUntouched = scoreCmd(untouched, terms)!;
      const rowTouched = scoreCmd(touched, terms)!;
      expect(rowUntouched.tier).toBe(rowTouched.tier);

      const mru = new Mru();
      mru.touch("touched");
      expect(compareRanked(rowTouched, rowUntouched, mru, emptySeq)).toBeLessThan(0);
    });

    it("never lets recency cross into a stronger tier", () => {
      const strong = cmd({ id: "strong", title: "Room" });
      const weakTouched = cmd({ id: "weak", title: "A room mention buried deep inside" });
      const terms = parseQuery("room").terms;

      const rowStrong = scoreCmd(strong, terms)!;
      const rowWeak = scoreCmd(weakTouched, terms)!;
      expect(rowStrong.tier).toBeGreaterThan(rowWeak.tier);

      const mru = new Mru();
      mru.touch("weak");
      // Touching the weaker row cannot make it outrank the untouched, stronger one.
      expect(compareRanked(rowWeak, rowStrong, mru, emptySeq)).toBeGreaterThan(0);
    });
  });

  describe("rank", () => {
    it("puts RECENT_GROUP first when history exists", () => {
      const cmds = [cmd({ id: "a", title: "Alpha" }), cmd({ id: "b", title: "Beta" })];
      const mru = new Mru();
      mru.touch("b");
      const groups = rank(cmds, parseQuery(""), mru);
      expect(groups[0].name).toBe(RECENT_GROUP);
      expect(groups[0].items.map((r) => r.cmd.id)).toEqual(["b"]);
    });

    it("omits RECENT_GROUP when history is empty", () => {
      const cmds = [cmd({ id: "a", title: "Alpha" })];
      const groups = rank(cmds, parseQuery(""), new Mru());
      expect(groups.some((g) => g.name === RECENT_GROUP)).toBe(false);
    });

    it("never lists the same command id twice", () => {
      const cmds = [
        cmd({ id: "a", title: "Alpha", group: "G1" }),
        cmd({ id: "b", title: "Beta", group: "G1" }),
      ];
      const mru = new Mru();
      mru.touch("a");
      const groups = rank(cmds, parseQuery(""), mru);
      const ids = groups.flatMap((g) => g.items.map((r) => r.cmd.id));
      expect(ids).toEqual(["a", "b"]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("orders groups by their best member's score", () => {
      // A prefix hit ("Room One") outscores a weak fuzzy hit buried in
      // another group's title, so that group must sort first.
      const strongGroup = cmd({ id: "g1", title: "Room One", group: "Rooms" });
      const weakGroup = cmd({ id: "g2", title: "Zeta thing room-ish", group: "Other" });
      const groups = rank([weakGroup, strongGroup], parseQuery("room"), new Mru());
      expect(groups.map((g) => g.name)).toEqual(["Rooms", "Other"]);
    });

    it("honours its limit argument", () => {
      const cmds = [
        cmd({ id: "a", title: "Alpha", group: "G1" }),
        cmd({ id: "b", title: "Beta", group: "G1" }),
        cmd({ id: "c", title: "Gamma", group: "G2" }),
      ];
      const groups = rank(cmds, parseQuery(""), new Mru(), 2);
      const ids = groups.flatMap((g) => g.items.map((r) => r.cmd.id));
      expect(ids).toEqual(["a", "b"]);
    });

    it("gives two commands sharing a title a distinguishing subtitle", () => {
      const cmds = [cmd({ id: "dupA", title: "Room" }), cmd({ id: "dupB", title: "Room" })];
      const groups = rank(cmds, parseQuery("room"), new Mru());
      const rows = groups.flatMap((g) => g.items);
      expect(rows.find((r) => r.cmd.id === "dupA")!.cmd.subtitle).toBe("dupA");
      expect(rows.find((r) => r.cmd.id === "dupB")!.cmd.subtitle).toBe("dupB");
    });

    it("leaves a command that already has a subtitle alone", () => {
      const cmds = [
        cmd({ id: "dupA", title: "Room" }),
        cmd({ id: "dupB", title: "Room", subtitle: "already set" }),
      ];
      const groups = rank(cmds, parseQuery("room"), new Mru());
      const rows = groups.flatMap((g) => g.items);
      expect(rows.find((r) => r.cmd.id === "dupB")!.cmd.subtitle).toBe("already set");
    });
  });

  describe("flatten", () => {
    it("returns rows in group order", () => {
      const rowA: RankedCmd = { ...scoreCmd(cmd({ id: "a", title: "A" }), [])! };
      const rowB: RankedCmd = { ...scoreCmd(cmd({ id: "b", title: "B" }), [])! };
      const rowC: RankedCmd = { ...scoreCmd(cmd({ id: "c", title: "C" }), [])! };
      const groups: RankedGroup[] = [
        { name: "G1", items: [rowA, rowB] },
        { name: "G2", items: [rowC] },
      ];
      expect(flatten(groups).map((r) => r.cmd.id)).toEqual(["a", "b", "c"]);
    });
  });
});
