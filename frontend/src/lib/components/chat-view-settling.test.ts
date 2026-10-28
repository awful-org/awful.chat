import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/components/ChatView.svelte", "utf8");

function body(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

describe("conversation settling cover", () => {
  it("does not flash the skeleton over a conversation that settles immediately", () => {
    const begin = body("beginSettling");
    expect(begin).toContain("settlingCover = false");
    expect(begin).toContain("settleCoverTimer = setTimeout");
    expect(begin).toContain("SETTLE_COVER_DELAY_MS");
    // The cover is a separate, delayed decision - not the settling flag
    // itself, which used to make it visible on every room change.
    expect(source).toContain("{#if settlingCover}");
    expect(source).not.toContain("{#if settling}");
  });

  it("cancels the delayed cover when settling finishes or the view is destroyed", () => {
    expect(body("endSettling")).toContain("clearTimeout(settleCoverTimer)");
    expect(body("endSettling")).toContain("settlingCover = false");
    const destroy = source.slice(source.indexOf("onDestroy(() => {", source.indexOf("function checkSettled")));
    expect(destroy).toContain("clearTimeout(settleCoverTimer)");
  });
});
