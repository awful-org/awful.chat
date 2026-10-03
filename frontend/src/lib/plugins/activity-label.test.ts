import { describe, expect, it } from "vitest";
import { MAX_ACTIVITY, cleanActivity } from "./activity-label";

describe("cleanActivity", () => {
  it("keeps one plain line", () => {
    expect(cleanActivity("Playing  Jeopardy\n")).toBe("Playing Jeopardy");
    expect(cleanActivity("a‮b​c d")).toBe("a b c d");
  });

  it("bounds by characters, not UTF-16 units, and never splits a pair", () => {
    const label = cleanActivity("🎲".repeat(MAX_ACTIVITY + 5));
    expect([...label!]).toHaveLength(MAX_ACTIVITY);
    expect(label).toBe("🎲".repeat(MAX_ACTIVITY));
  });

  it("keeps an emoji sequence whole, and counts it as one", () => {
    const coder = "\u{1F469}\u200D\u{1F4BB}";
    expect(cleanActivity(`Playing ${coder}`)).toBe(`Playing ${coder}`);
    expect(cleanActivity(coder.repeat(3), 2)).toBe(coder.repeat(2));
  });

  it("is null for nothing at all", () => {
    for (const bad of [null, undefined, 3, {}, "", "   ", "\u0000​"]) expect(cleanActivity(bad)).toBeNull();
  });
});
