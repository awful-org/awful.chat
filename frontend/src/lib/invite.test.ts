import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShortCode,
  looksLikeShortCode,
  normalizeShortCode,
  parseJoinInput,
  createInvite,
  resolveInvite,
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("room join input", () => {
  it("treats full links identically regardless of how they were pasted", () => {
    for (const input of ["https://chat.example/r/#6BMB3GST2JRJZ", "/r/#6BMB3GST2JRJZ", "web+awfl://6BMB3GST2JRJZ", "6bmb-3gst-2jrj-z"]) {
      expect(parseJoinInput(input)).toEqual({ kind: "room", code: "6BMB3GST2JRJZ" });
    }
    expect(parseJoinInput("https://chat.example/r/a1b2c3?ref=x#unrelated")).toEqual({ kind: "room", code: "a1b2c3" });
  });
  it("keeps ambiguous bare legacy codes distinct from explicit legacy links", () => {
    expect(parseJoinInput("a1b2c3")).toEqual({ kind: "short", code: "A1B2C3", legacySixHex: true });
    expect(parseJoinInput("7qk3-m9")).toEqual({ kind: "short", code: "7QK3M9", legacySixHex: false });
    for (const input of ["", "hello", "https://example.com/", "6BMB3GST2JRJZ/junk"]) expect(parseJoinInput(input)).toEqual({ kind: "invalid" });
  });
  it("starts invite expiry before the request, not after its round trip", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.stubGlobal("fetch", vi.fn(async () => {
      clock.mockReturnValue(4000);
      return new Response(JSON.stringify({ code: "7QK3M9", ttl: 300 }));
    }));
    expect((await createInvite("6BMB3GST2JRJZ")).expiresAt).toBe(301000);
  });
  it("distinguishes unknown/expired aliases from rate-limited requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 })).mockResolvedValueOnce(new Response("{}", { status: 429 })));
    expect(await resolveInvite("7QK3M9")).toBeNull();
    await expect(resolveInvite("7QK3M9")).rejects.toThrow("Wait a minute");
  });
});
