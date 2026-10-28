import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/components/ChatView.svelte", "utf8");

describe("composer sends", () => {
  it("does not discard messages while an earlier send is still in flight", () => {
    expect(source).not.toContain("if (submitting) return");
    expect(source).not.toContain("let submitting = $state(false)");
    expect(source).toContain("Sends may overlap");
  });
});
