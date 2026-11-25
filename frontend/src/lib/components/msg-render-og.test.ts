import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/components/MsgRender.svelte", "utf8");
const chat = readFileSync("src/lib/components/ChatView.svelte", "utf8");

describe("Open Graph preview layout", () => {
  it("marks the whole request lifecycle for the conversation settling gate", () => {
    expect(source).toContain("let ogLoading = $state(false)");
    expect(source).toContain("ogLoading = true");
    expect(source).toContain("data-og-loading={ogLoading ? \"true\" : undefined}");
    expect(source).toContain("ogLoading = false;");
    expect(chat).toContain("!el.querySelector('[data-og-loading=\"true\"]')");
  });

  it("reserves the image's aspect ratio from OG metadata before it decodes", () => {
    expect(source).toContain("width={ogPreview.imageWidth}");
    expect(source).toContain("height={ogPreview.imageHeight}");
  });

  it("clears loading on success, on failure and while told to wait", () => {
    const fetching = source.slice(source.indexOf("fetchOgPreview(previewUrl"));
    expect(fetching.match(/ogLoading = false/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("gives a video element only what it can play, and links the rest", () => {
    expect(source).toContain("playableVideo(ogPreview)");
    expect(source).toContain("src={ogVideo}");
    expect(source).not.toContain("src={ogPreview.video}");
  });
});
