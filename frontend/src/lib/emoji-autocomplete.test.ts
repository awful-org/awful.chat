import { describe, expect, it } from "vitest";
import { emojiToken, insertEmoji } from "./emoji-autocomplete";

describe("emoji shortcode at the caret", () => {
  it("opens on a colon and narrows as a name is typed", () => {
    expect(emojiToken("Hello :", 7)).toEqual({ start: 6, end: 7, query: "", closed: false });
    expect(emojiToken("Hello :smi", 10)?.query).toBe("smi");
    expect(emojiToken(":smile:", 7)?.closed).toBe(true);
  });
  it.each(["https:", "12:30", "hello:smile", "`code :smile", "```\n:smile", "::", ":smile "])("does not complete inside %s", (text) => {
    expect(emojiToken(text, text.length)).toBeNull();
  });
  it("does not replace selected text", () => {
    expect(emojiToken(":smile", 3, 6)).toBeNull();
  });
  it("preserves text after the cursor and puts the caret after a multicodepoint emoji", () => {
    const text = "Hi :heart there";
    const token = emojiToken(text, 9)!;
    expect(insertEmoji(text, token, "❤️")).toEqual({ value: "Hi ❤️ there", caret: 5 });
  });
  it("allows alias punctuation and names after parentheses", () => {
    expect(emojiToken("(:+1", 4)?.query).toBe("+1");
    expect(emojiToken(":sweat_smile", 12)?.query).toBe("sweat_smile");
  });
});
