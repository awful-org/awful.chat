import { describe, expect, it } from "vitest";
import { canOpenAsPage, safeBlobType } from "./safe-mime";

describe("safeBlobType", () => {
  it("keeps images, audio, video, PDF and plain text", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "video/mp4", "application/pdf", "text/plain"]) {
      expect(safeBlobType(type)).toBe(type);
    }
    expect(safeBlobType("Text/Plain; charset=utf-8")).toBe("text/plain");
  });

  it("turns anything that could run as a page into a download", () => {
    for (const type of ["text/html", "application/xhtml+xml", "text/xml", "application/javascript", "text/javascript",
      "application/xml", "text/html; charset=utf-8", "multipart/x-mixed-replace", "", "garbage", undefined, 42]) {
      expect(safeBlobType(type)).toBe("application/octet-stream");
    }
  });

  it("keeps SVG displayable in an <img> but never openable as a page", () => {
    expect(safeBlobType("image/svg+xml")).toBe("image/svg+xml");
    expect(canOpenAsPage("image/svg+xml")).toBe(false);
  });
});

describe("canOpenAsPage", () => {
  it("allows raster images, audio, video, PDF and text, and nothing else", () => {
    expect(canOpenAsPage("image/png")).toBe(true);
    expect(canOpenAsPage("video/webm")).toBe(true);
    expect(canOpenAsPage("application/pdf")).toBe(true);
    expect(canOpenAsPage("text/plain")).toBe(true);
    expect(canOpenAsPage("text/html")).toBe(false);
    expect(canOpenAsPage("application/octet-stream")).toBe(false);
    expect(canOpenAsPage(undefined)).toBe(false);
  });
});
