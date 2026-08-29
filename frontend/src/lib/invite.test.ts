import { describe, expect, it } from "vitest";
import {
  formatShortCode,
  looksLikeShortCode,
  normalizeShortCode,
} from "./invite";

describe("short invite codes", () => {
  it("normalizes case, separators and look-alikes", () => {
    expect(normalizeShortCode(" 7qk3-m9 ")).toBe("7QK3M9");
    expect(normalizeShortCode("7QK3 M9")).toBe("7QK3M9");
    expect(normalizeShortCode("OIlo")).toBe("0110");
  });

  it("recognizes a short code, including a legacy 6-char hex room code", () => {
    expect(looksLikeShortCode("7qk3-m9")).toBe(true);
    expect(looksLikeShortCode("a1b2c3")).toBe(true);
    expect(looksLikeShortCode("3f9a1c2b4d5e6f70")).toBe(false);
    expect(looksLikeShortCode("7QK3M")).toBe(false);
    expect(looksLikeShortCode("7QK3MU")).toBe(false); // U is not in the alphabet
  });

  it("formats for reading aloud", () => {
    expect(formatShortCode("7QK3M9")).toBe("7QK3-M9");
  });
});
