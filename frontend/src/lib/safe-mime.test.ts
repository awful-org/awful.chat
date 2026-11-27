import { describe, expect, it } from "vitest";
import { canOpenAsPage, safeBlobType, showsAsImage } from "./safe-mime";

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

  it("never types a blob as SVG: the browser's own image actions open it as a page", () => {
    expect(safeBlobType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeBlobType("Image/SVG+XML; charset=utf-8")).toBe("application/octet-stream");
    expect(canOpenAsPage("image/svg+xml")).toBe(false);
  });

  it("returns no type a browser renders as a document that can hold script", () => {
    const claims = ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/xml",
      "image/svg", "application/rdf+xml", "text/xsl", "application/mathml+xml", "message/rfc822"];
    for (const claim of claims) {
      expect(safeBlobType(claim)).not.toMatch(/html|xml|svg|xsl|rfc822/);
    }
  });
});

describe("showsAsImage", () => {
  it("shows raster images inline and SVG as a file", () => {
    expect(showsAsImage("image/png")).toBe(true);
    expect(showsAsImage("image/gif")).toBe(true);
    expect(showsAsImage("image/svg+xml")).toBe(false);
    expect(showsAsImage("IMAGE/SVG+XML")).toBe(false);
    expect(showsAsImage("video/mp4")).toBe(false);
    expect(showsAsImage(undefined)).toBe(false);
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
