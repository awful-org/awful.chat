import { describe, it, expect } from "vitest";
import { MessageType, type Message } from "$lib/types/message";
import { QUOTE_SHOWN_CHARS, getQuotableText, trimContent } from "./quote-helper";
import { stripMarkdown } from "./markdown";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "test-msg",
    roomCode: "test-room",
    senderId: "sender-1",
    senderName: "Alice",
    timestamp: 1000,
    lamport: 1,
    type: MessageType.Text,
    content: "",
    attachments: [],
    ...overrides,
  };
}

describe("quote helper", () => {
  it("quotes a plugin card by plugin name, never its JSON payload", () => {
    const quoted = getQuotableText(
      makeMessage({
        type: MessageType.PluginCard,
        content: JSON.stringify({ pluginId: "some-plugin", data: { x: 1 } }),
      })
    );
    expect(quoted).toBe("[Plugin: some-plugin]");
    expect(quoted).not.toContain("{");
  });

  it("quotes a malformed plugin card with a generic placeholder", () => {
    expect(
      getQuotableText(
        makeMessage({ type: MessageType.PluginCard, content: "not json" })
      )
    ).toBe("[Plugin: plugin]");
  });

  it("returns text content for a normal text message", () => {
    const msg = makeMessage({ content: "Hello, world!" });
    expect(getQuotableText(msg)).toBe("Hello, world!");
  });

  it("returns trimmed text for long content (160+ chars)", () => {
    const longText = "a".repeat(165);
    const msg = makeMessage({ content: longText });
    const result = getQuotableText(msg);
    expect(result).toBe("a".repeat(157) + "...");
    expect(result.length).toBe(160);
  });

  it("returns exactly 160 chars when trimming", () => {
    const text = "a".repeat(170);
    const msg = makeMessage({ content: text });
    const result = getQuotableText(msg);
    expect(result.length).toBe(160);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns [image] for a message with just a URL (from GIF picker)", () => {
    const gifUrl = "https://media.example.com/cat.gif";
    const msg = makeMessage({ content: gifUrl });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("returns [image] for a bare http gif/webp link too", () => {
    const httpUrl = "http://example.com/image.webp?w=200";
    const msg = makeMessage({ content: httpUrl });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("quotes a shared link as itself - only image links are pictures", () => {
    const link = "https://example.com/some-article";
    const msg = makeMessage({ content: link });
    expect(getQuotableText(msg)).toBe(link);
  });

  it("returns [image] for empty messages with no attachments", () => {
    const msg = makeMessage({ content: "" });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("returns filename for file attachment messages", () => {
    const msg = makeMessage({
      type: MessageType.File,
      content: "",
      meta: {
        files: [
          {
            filename: "document.pdf",
            mimeType: "application/pdf",
            size: 1024,
            infoHash: "abc123",
          },
        ],
      },
    });
    expect(getQuotableText(msg)).toBe("[document.pdf]");
  });

  it("returns [file] when file has no filename", () => {
    const msg = makeMessage({
      type: MessageType.File,
      content: "",
      meta: {
        files: [
          {
            filename: "",
            mimeType: "application/octet-stream",
            size: 512,
            infoHash: "def456",
          },
        ],
      },
    });
    expect(getQuotableText(msg)).toBe("[file]");
  });

  it("returns first file's name when multiple files attached", () => {
    const msg = makeMessage({
      type: MessageType.File,
      content: "",
      meta: {
        files: [
          {
            filename: "first.txt",
            mimeType: "text/plain",
            size: 100,
            infoHash: "hash1",
          },
          {
            filename: "second.txt",
            mimeType: "text/plain",
            size: 100,
            infoHash: "hash2",
          },
        ],
      },
    });
    expect(getQuotableText(msg)).toBe("[first.txt]");
  });

  it("returns [image] for file messages with empty attachments array", () => {
    const msg = makeMessage({
      type: MessageType.File,
      content: "",
      meta: { files: [] },
    });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("returns [image] for file messages with no meta", () => {
    const msg = makeMessage({
      type: MessageType.File,
      content: "",
      meta: undefined,
    });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("preserves text with numbers and special chars", () => {
    const msg = makeMessage({ content: "Check this: 123-abc!@#" });
    expect(getQuotableText(msg)).toBe("Check this: 123-abc!@#");
  });

  it("preserves whitespace in normal text", () => {
    const msg = makeMessage({ content: "  Leading and trailing  " });
    expect(getQuotableText(msg)).toBe("  Leading and trailing  ");
  });

  it("returns [image] for URL-like content in File message (URL takes precedence)", () => {
    // Even if it's marked as File type, if content is a URL, return [image]
    const msg = makeMessage({
      type: MessageType.File,
      content: "https://example.com/test.gif",
    });
    expect(getQuotableText(msg)).toBe("[image]");
  });

  it("handles text content that contains 'http' but isn't a URL", () => {
    // Text content that mentions http but isn't a URL should be preserved
    const msg = makeMessage({
      content: "Check out the http docs for details",
    });
    expect(getQuotableText(msg)).toBe("Check out the http docs for details");
  });

  it("distinguishes between URLs and text mentioning http", () => {
    // A bare image URL is treated as the picture it renders as
    const urlMsg = makeMessage({ content: "https://example.com/image.gif" });
    expect(getQuotableText(urlMsg)).toBe("[image]");

    // Text that mentions https but doesn't start with it is preserved
    const textMsg = makeMessage({ content: "I posted https://example.com/image" });
    expect(getQuotableText(textMsg)).toBe("I posted https://example.com/image");
  });
});

describe("trimContent", () => {
  const pad = (n: number) => "x ".repeat(n);

  it("backs off before a link it would cut in half", () => {
    const cut = trimContent(pad(70) + "see [the full plan](https://example.com/a/very/long/path) now");
    expect(cut).toBe(pad(70).trimEnd() + " see...");
    expect(stripMarkdown(cut)).not.toContain("[");
  });

  it("backs off before a code span or a fence it would leave open", () => {
    expect(trimContent(pad(75) + "`" + "c".repeat(40) + "`")).toBe(pad(75).trimEnd() + "...");
    expect(trimContent(pad(70) + "```js\n" + "c".repeat(60) + "\n```")).toBe(pad(70).trimEnd() + "...");
  });

  it("closes a fence or code span the message opens with, rather than quote only \"...\"", () => {
    const fenced = trimContent("```js\n" + "c".repeat(300) + "\n```");
    expect(stripMarkdown(fenced)).toBe("c".repeat(151) + "...");
    expect(trimContent("`" + "c".repeat(300) + "`")).toBe("`" + "c".repeat(156) + "...`");
  });

  it("does not back off to a backtick or bracket that never closes", () => {
    expect(trimContent("don`t " + pad(100))).toBe(("don`t " + pad(100)).slice(0, 157).trimEnd() + "...");
    expect(trimContent("ok :[ " + pad(100))).toBe(("ok :[ " + pad(100)).slice(0, 157).trimEnd() + "...");
  });

  it("does not count the backticks inside a closed fence", () => {
    const text = "```\nit's `odd\n```\n" + pad(100);
    expect(trimContent(text)).toBe(text.slice(0, 157).trimEnd() + "...");
  });

  it("keeps markup that closes inside the cut", () => {
    const text = "[a](https://a.bc) `x` " + "y".repeat(200);
    expect(trimContent(text).startsWith("[a](https://a.bc) `x` ")).toBe(true);
  });

  it("takes far more for a quote shown on screen, still cut safely", () => {
    const long = "z".repeat(300);
    expect(getQuotableText(makeMessage({ content: long }), QUOTE_SHOWN_CHARS)).toBe(long);
    const huge = "hi\n```js\n" + "c".repeat(5000) + "\n```";
    const shown = stripMarkdown(getQuotableText(makeMessage({ content: huge }), QUOTE_SHOWN_CHARS));
    expect(shown.length).toBeLessThan(2100);
    expect(shown).not.toContain("```");
  });
});
