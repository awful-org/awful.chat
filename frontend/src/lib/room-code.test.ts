import { describe, expect, it } from "vitest";
import {
  formatQuickCode,
  formatRoomCode,
  isQuickCode,
  newQuickCode,
  newRoomCode,
  normalizeQuickCode,
  normalizeRoomCode,
} from "./room-code";

describe("room codes", () => {
  it("is 13 Crockford base32 characters (65 bits)", () => {
    for (let i = 0; i < 50; i++) {
      expect(newRoomCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{13}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newRoomCode()));
    expect(seen.size).toBe(500);
  });

  it("formats for reading aloud and normalizes what was read", () => {
    const code = "6BMB3GST2JRJZ";
    expect(formatRoomCode(code)).toBe("6BMB-3GST-2JRJ-Z");
    expect(normalizeRoomCode(" 6bmb-3gst-2jrj-z ")).toBe(code);
    expect(normalizeRoomCode("6BMB 3GST 2JRJ Z")).toBe(code);
    // O for 0, l/I for 1
    expect(normalizeRoomCode("OBMB-3GST-2JRJ-l")).toBe("0BMB3GST2JRJ1");
  });

  it("leaves legacy hex codes and short invites untouched", () => {
    expect(normalizeRoomCode("3f9a1c2b4d5e6f70")).toBe("3f9a1c2b4d5e6f70");
    expect(normalizeRoomCode("a1b2c3")).toBe("a1b2c3");
    expect(formatRoomCode("3f9a1c2b4d5e6f70")).toBe("3f9a1c2b4d5e6f70");
  });
});

describe("quick codes", () => {
  it("is ten characters of the room alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = newQuickCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(normalizeQuickCode(code)).toBe(code);
    }
  });

  it("folds what a person types, look-alikes and all", () => {
    expect(normalizeQuickCode(" 7qk3-m9ab-2c ")).toBe("7QK3M9AB2C");
    expect(normalizeQuickCode("7qk3 m9ab 2c")).toBe("7QK3M9AB2C");
    // O/I/L never appear in a generated code, so a reader who wrote one down
    // meant the digit.
    expect(normalizeQuickCode("oqk3m9ab2c")).toBe("0QK3M9AB2C");
    expect(normalizeQuickCode("iqk3m9ab2l")).toBe("1QK3M9AB21");
  });

  it("refuses anything that is not one", () => {
    // A room code above all: 13 characters means a real room, and a quick
    // page that joined one would put a stranger in it.
    expect(normalizeQuickCode("6BMB3GST2JRJZ")).toBe("");
    expect(normalizeQuickCode("7QK3M9AB")).toBe("");
    expect(normalizeQuickCode("7QK3M9AB2C!")).toBe("");
    expect(normalizeQuickCode("")).toBe("");
    expect(isQuickCode("6BMB3GST2JRJZ")).toBe(false);
    expect(isQuickCode("7qk3-m9ab-2c")).toBe(true);
  });

  it("displays as three groups", () => {
    expect(formatQuickCode("7QK3M9AB2C")).toBe("7QK-3M9A-B2C");
    expect(formatQuickCode("not-a-code")).toBe("not-a-code");
  });
});
