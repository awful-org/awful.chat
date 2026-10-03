import { describe, expect, it } from "vitest";
import { hasUnseen, newestMerge, parseWhatsNew } from "./whats-new";

const note = (n: number, mergedAt: string, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  mergedAt,
  url: `https://github.com/o/r/pull/${n}`,
  body: `body ${n}`,
  ...extra,
});

describe("parseWhatsNew", () => {
  it("keeps well-formed entries, newest merge first", () => {
    const notes = parseWhatsNew([note(1, "2026-09-01T00:00:00Z"), note(3, "2026-09-03T00:00:00Z"), note(2, "2026-09-02T00:00:00Z")]);
    expect(notes.map((n) => n.number)).toEqual([3, 2, 1]);
    expect(notes[0]).toEqual({ number: 3, title: "PR 3", mergedAt: "2026-09-03T00:00:00Z", url: "https://github.com/o/r/pull/3", body: "body 3" });
  });

  it("drops what it cannot trust", () => {
    const notes = parseWhatsNew([
      null,
      "x",
      note(0, "2026-09-01T00:00:00Z"),
      note(1.5, "2026-09-01T00:00:00Z"),
      note(2, "not a date"),
      { ...note(3, "2026-09-01T00:00:00Z"), title: "  " },
      note(4, "2026-09-01T00:00:00Z", { url: "javascript:alert(1)", body: 42 }),
    ]);
    expect(notes).toEqual([{ number: 4, title: "PR 4", mergedAt: "2026-09-01T00:00:00Z", url: "", body: "" }]);
    expect(parseWhatsNew({ not: "a list" })).toEqual([]);
  });

  it("keeps one entry per number", () => {
    const notes = parseWhatsNew([note(1, "2026-09-02T00:00:00Z"), note(1, "2026-09-01T00:00:00Z")]);
    expect(notes).toHaveLength(1);
  });

  it("caps text and length", () => {
    const many = Array.from({ length: 20 }, (_, i) => note(i + 1, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    expect(parseWhatsNew(many)).toHaveLength(10);
    const [long] = parseWhatsNew([note(1, "2026-09-01T00:00:00Z", { title: "t".repeat(1000), body: "b".repeat(10000) })]);
    expect(long.title).toHaveLength(300);
    expect(long.body).toHaveLength(6000);
  });
});

describe("hasUnseen", () => {
  const notes = parseWhatsNew([note(7, "2026-09-02T00:00:00Z"), note(5, "2026-09-01T00:00:00Z")]);

  const at = (iso: string) => Date.parse(iso);

  it("is new only past what this device last opened", () => {
    expect(newestMerge(notes)).toBe(at("2026-09-02T00:00:00Z"));
    expect(hasUnseen(notes, at("2026-09-01T00:00:00Z"))).toBe(true);
    expect(hasUnseen(notes, at("2026-09-02T00:00:00Z"))).toBe(false);
  });

  it("goes by merge time, not number: an older pull request merged later is new", () => {
    const seen = newestMerge(parseWhatsNew([note(106, "2026-09-02T00:00:00Z")]));
    const later = parseWhatsNew([note(105, "2026-09-03T00:00:00Z"), note(106, "2026-09-02T00:00:00Z")]);
    expect(hasUnseen(later, seen)).toBe(true);
  });

  it("starts a device that never looked caught up", () => {
    expect(hasUnseen(notes, null)).toBe(false);
    expect(hasUnseen([], 3)).toBe(false);
  });
});
