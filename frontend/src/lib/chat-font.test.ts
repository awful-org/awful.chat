import { describe, expect, it } from "vitest";
import {
  FONT_STACKS,
  FONT_STACK_IDS,
  DEFAULT_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MAX_CHAT_FONT_SIZE,
  clampChatFontSize,
  sanitizeFontFamily,
  resolveChatFontStack,
} from "./chat-font";

describe("clampChatFontSize", () => {
  it("passes an in-range number through unchanged", () => {
    expect(clampChatFontSize(16)).toBe(16);
  });

  it("clamps below the minimum", () => {
    expect(clampChatFontSize(1)).toBe(MIN_CHAT_FONT_SIZE);
  });

  it("clamps above the maximum", () => {
    expect(clampChatFontSize(999)).toBe(MAX_CHAT_FONT_SIZE);
  });

  it("accepts a numeric string, as read from localStorage", () => {
    expect(clampChatFontSize("18")).toBe(18);
  });

  it("rounds a fractional value", () => {
    expect(clampChatFontSize(15.6)).toBe(16);
  });

  it("falls back to the default for anything that isn't a real, finite number", () => {
    expect(clampChatFontSize("not a number")).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(clampChatFontSize(null)).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(clampChatFontSize(undefined)).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(clampChatFontSize(NaN)).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(clampChatFontSize(Infinity)).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(clampChatFontSize({})).toBe(DEFAULT_CHAT_FONT_SIZE);
  });
});

describe("sanitizeFontFamily", () => {
  it("passes a plain family through", () => {
    expect(sanitizeFontFamily("Comic Sans MS")).toBe("Comic Sans MS");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeFontFamily("  Comic Sans MS  ")).toBe("Comic Sans MS");
  });

  it("collapses inner whitespace runs to one space", () => {
    expect(sanitizeFontFamily("Comic   Sans\t\tMS")).toBe("Comic Sans MS");
  });

  // Every one of these must reject on its own: a filter that only catches
  // some of them would still let an injection through.
  const forbiddenChars = [
    ";",
    "{",
    "}",
    "<",
    ">",
    "(",
    ")",
    '"',
    "'",
    "\\",
    "\n",
    "\r",
  ];
  for (const ch of forbiddenChars) {
    it(`rejects a family containing ${JSON.stringify(ch)}`, () => {
      expect(sanitizeFontFamily(`Comic${ch}Sans`)).toBeNull();
    });
  }

  it("rejects url(...) regardless of case", () => {
    expect(sanitizeFontFamily("url(evil.com)")).toBeNull();
    expect(sanitizeFontFamily("UrL(evil.com)")).toBeNull();
    expect(sanitizeFontFamily("a font named url")).toBeNull();
  });

  it("caps an over-long value instead of rejecting it", () => {
    const long = "a".repeat(100);
    const result = sanitizeFontFamily(long);
    expect(result).toHaveLength(64);
    expect(result).toBe("a".repeat(64));
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(sanitizeFontFamily("")).toBeNull();
    expect(sanitizeFontFamily("   ")).toBeNull();
  });

  it("rejects a non-string value", () => {
    expect(sanitizeFontFamily(null)).toBeNull();
    expect(sanitizeFontFamily(undefined)).toBeNull();
    expect(sanitizeFontFamily(42)).toBeNull();
  });
});

describe("resolveChatFontStack", () => {
  const monoStack = FONT_STACKS.find((f) => f.id === "mono")!.stack;

  it("resolves every known id to its own stack", () => {
    for (const id of FONT_STACK_IDS) {
      const expected = FONT_STACKS.find((f) => f.id === id)!.stack;
      expect(resolveChatFontStack(id)).toBe(expected);
    }
  });

  it("resolves an unknown-but-safe family to a quoted family plus the mono fallback tail", () => {
    expect(resolveChatFontStack("Comic Sans MS")).toBe(
      `"Comic Sans MS", ${monoStack}`,
    );
  });

  it("falls back to the mono stack for a dangerous value", () => {
    expect(resolveChatFontStack('Comic";color:red;--x:"Sans')).toBe(
      monoStack,
    );
  });

  it("falls back to the mono stack for an empty string", () => {
    expect(resolveChatFontStack("")).toBe(monoStack);
  });
});

describe("FONT_STACKS", () => {
  it("has unique ids", () => {
    const ids = FONT_STACKS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists mono first", () => {
    expect(FONT_STACKS[0].id).toBe("mono");
  });

  it("guarantees a generic CSS family as a real fallback in every stack", () => {
    // Checked as containment, not strict suffix: `sans` deliberately
    // appends quoted emoji-glyph font names after its generic `sans-serif`
    // token, for color emoji coverage, so the generic keyword is not
    // literally the last word even though it still guarantees the
    // fallback the other stacks provide by ending with it.
    const generic = /\b(monospace|sans-serif|serif)\b/;
    for (const { stack } of FONT_STACKS) {
      expect(stack).toMatch(generic);
    }
  });
});
