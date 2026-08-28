import { describe, expect, it } from "vitest";
import {
  decode,
  encode,
  hex,
  normalizeAvatarUrl,
  normalizeNicknameColor,
  sniffImageMime,
  unhex,
} from "./utils";

describe("hex codec", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(unhex(hex(bytes))).toEqual(bytes);
  });

  it("throws on odd-length input", () => {
    expect(() => unhex("abc")).toThrow();
  });
});

describe("json wire codec", () => {
  it("round-trips objects", () => {
    const obj = { a: 1, b: "two", c: [3] };
    expect(decode(encode(obj))).toEqual(obj);
  });
});

describe("normalizeAvatarUrl", () => {
  it("accepts http(s) urls", () => {
    expect(normalizeAvatarUrl("https://x.test/a.png")).toBe(
      "https://x.test/a.png"
    );
  });

  it("rejects javascript: and non-image data: urls", () => {
    expect(normalizeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeAvatarUrl("data:text/html,<script>")).toBeUndefined();
  });

  // An avatar picked from the device travels inline as a data: URL. Rejecting
  // those meant uploaded pictures never reached anyone.
  it("accepts base64 raster data: urls", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(normalizeAvatarUrl(png)).toBe(png);
    expect(normalizeAvatarUrl("data:image/jpeg;base64,AAAA")).toBe(
      "data:image/jpeg;base64,AAAA"
    );
  });

  it("rejects svg data: urls and oversized payloads", () => {
    expect(
      normalizeAvatarUrl("data:image/svg+xml;base64,PHN2Zz4=")
    ).toBeUndefined();
    expect(
      normalizeAvatarUrl("data:image/png;base64," + "A".repeat(1_500_000))
    ).toBeUndefined();
  });

  it("rejects non-strings and garbage", () => {
    expect(normalizeAvatarUrl(42)).toBeUndefined();
    expect(normalizeAvatarUrl("not a url")).toBeUndefined();
  });

  it("accepts every raster type that profile-meta also allows", () => {
    // Keep avatar and banner MIME type lists in sync. The DATA_AVATAR_RE
    // regex must match exactly what validateProfileMeta's DATA_BANNER_RE accepts.
    for (const type of ["png", "jpeg", "jpg", "gif", "webp", "avif"]) {
      const url = `data:image/${type};base64,iVBORw0KGgo=`;
      expect(normalizeAvatarUrl(url)).toBe(url);
    }
  });

  it("rejects malformed and non-base64 data: images", () => {
    expect(normalizeAvatarUrl("data:image/png,notbase64")).toBeUndefined();
    expect(normalizeAvatarUrl("data:image/png;base64,ab cd")).toBeUndefined();
  });
});

describe("normalizeNicknameColor", () => {
  it("accepts 6-digit hex and lowercases it", () => {
    expect(normalizeNicknameColor("#AB12CD")).toBe("#ab12cd");
    expect(normalizeNicknameColor("#aabbcc")).toBe("#aabbcc");
  });

  it("rejects anything a style attribute could abuse", () => {
    expect(normalizeNicknameColor("red")).toBeUndefined();
    expect(normalizeNicknameColor("url(javascript:alert(1))")).toBeUndefined();
    expect(normalizeNicknameColor("#12345")).toBeUndefined();
    expect(normalizeNicknameColor("#1234567")).toBeUndefined();
    expect(normalizeNicknameColor("rgb(1,2,3)")).toBeUndefined();
    expect(normalizeNicknameColor("")).toBeUndefined();
    expect(normalizeNicknameColor(42)).toBeUndefined();
    expect(normalizeNicknameColor(null)).toBeUndefined();
    expect(normalizeNicknameColor(undefined)).toBeUndefined();
  });
});

describe("sniffImageMime", () => {
  it("recognizes PNG magic bytes", () => {
    // PNG: 0x89 0x50 0x4E 0x47 (89 50 4E 47)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMime(png)).toBe("image/png");
  });

  it("recognizes JPEG magic bytes", () => {
    // JPEG: 0xFF 0xD8
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
  });

  it("recognizes GIF magic bytes", () => {
    // GIF: 0x47 0x49 0x46 (GIF)
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(sniffImageMime(gif)).toBe("image/gif");
  });

  it("recognizes WebP magic bytes", () => {
    // WebP: RIFF....WEBP
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size
      0x57, 0x45, // WE (part of WEBP)
      0x42, 0x50, // BP (part of WEBP)
    ]);
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("recognizes AVIF magic bytes", () => {
    // AVIF: ftyp at offset 4, avif at offset 8
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, // size
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x61, 0x76, 0x69, 0x66, // avif
      0x00, 0x00, 0x00, 0x00, // more data
    ]);
    expect(sniffImageMime(avif)).toBe("image/avif");
  });

  it("defaults to image/jpeg for unrecognized bytes", () => {
    const unknown = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffImageMime(unknown)).toBe("image/jpeg");
  });
});
