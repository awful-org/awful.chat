import { describe, expect, it } from "vitest";
import {
  decode,
  encode,
  hex,
  normalizeAvatarUrl,
  normalizeNicknameColor,
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
