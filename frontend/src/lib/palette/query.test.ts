import { describe, expect, it } from "vitest";
import { parseQuery, parseRoomCode } from "./query";

describe("query", () => {
  describe("parseQuery", () => {
    it("has no sigil and one term per word when nothing scopes the search", () => {
      const parsed = parseQuery("hello world");
      expect(parsed.sigil).toBeNull();
      expect(parsed.body).toBe("hello world");
      expect(parsed.terms).toEqual([
        { text: "hello", exact: false },
        { text: "world", exact: false },
      ]);
    });

    it("strips the # sigil out of the body", () => {
      const parsed = parseQuery("#room");
      expect(parsed.sigil).toBe("#");
      expect(parsed.body).toBe("room");
      expect(parsed.terms).toEqual([{ text: "room", exact: false }]);
    });

    it("strips the @ sigil out of the body", () => {
      const parsed = parseQuery("@alice");
      expect(parsed.sigil).toBe("@");
      expect(parsed.body).toBe("alice");
      expect(parsed.terms).toEqual([{ text: "alice", exact: false }]);
    });

    it("strips the > sigil out of the body", () => {
      const parsed = parseQuery(">audio");
      expect(parsed.sigil).toBe(">");
      expect(parsed.body).toBe("audio");
      expect(parsed.terms).toEqual([{ text: "audio", exact: false }]);
    });

    it("strips the ? sigil out of the body", () => {
      const parsed = parseQuery("?shortcuts");
      expect(parsed.sigil).toBe("?");
      expect(parsed.body).toBe("shortcuts");
      expect(parsed.terms).toEqual([{ text: "shortcuts", exact: false }]);
    });

    it("yields zero terms for a sigil typed alone", () => {
      const parsed = parseQuery("#");
      expect(parsed.sigil).toBe("#");
      expect(parsed.body).toBe("");
      expect(parsed.terms).toEqual([]);
    });

    it("splits on whitespace into several terms", () => {
      expect(parseQuery("join room").terms).toEqual([
        { text: "join", exact: false },
        { text: "room", exact: false },
      ]);
    });

    it("collapses repeated inner whitespace between terms", () => {
      const parsed = parseQuery("  hello   world  ");
      expect(parsed.body).toBe("hello   world");
      expect(parsed.terms).toEqual([
        { text: "hello", exact: false },
        { text: "world", exact: false },
      ]);
    });

    it("turns a quoted segment into one exact term", () => {
      expect(parseQuery('"settings"').terms).toEqual([
        { text: "settings", exact: true },
      ]);
    });

    it("keeps a quoted segment containing a space as one term", () => {
      expect(parseQuery('"join room"').terms).toEqual([
        { text: "join room", exact: true },
      ]);
    });

    it("still parses usefully when a quote is never closed", () => {
      expect(parseQuery('"unterminated').terms).toEqual([
        { text: "unterminated", exact: true },
      ]);
    });

    it("mixes quoted and bare terms in one query", () => {
      expect(parseQuery('"exact" bare').terms).toEqual([
        { text: "exact", exact: true },
        { text: "bare", exact: false },
      ]);
    });

    it("lowercases term text but preserves raw verbatim", () => {
      const parsed = parseQuery("MixedCase Query");
      expect(parsed.raw).toBe("MixedCase Query");
      expect(parsed.terms).toEqual([
        { text: "mixedcase", exact: false },
        { text: "query", exact: false },
      ]);
    });

    it("returns zero terms for empty input", () => {
      expect(parseQuery("").terms).toEqual([]);
    });

    it("returns zero terms for whitespace-only input", () => {
      expect(parseQuery("   ").terms).toEqual([]);
    });
  });

  describe("parseRoomCode", () => {
    it("accepts a bare valid 6-hex code", () => {
      expect(parseRoomCode("a1b2c3")).toBe("a1b2c3");
    });

    it("normalises an uppercase code to lowercase", () => {
      expect(parseRoomCode("A1B2C3")).toBe("a1b2c3");
    });

    it("pulls the code out of a full invite URL", () => {
      expect(parseRoomCode("https://awful.chat/r/a1b2c3")).toBe("a1b2c3");
    });

    it("pulls the code out of a web+awfl:// link", () => {
      expect(parseRoomCode("web+awfl://a1b2c3")).toBe("a1b2c3");
    });

    it("drops a trailing slash left on a pasted URL", () => {
      expect(parseRoomCode("https://awful.chat/r/a1b2c3/")).toBe("a1b2c3");
    });

    it("drops a trailing query string left on a pasted URL", () => {
      expect(parseRoomCode("https://awful.chat/r/a1b2c3?ref=x")).toBe("a1b2c3");
    });

    it("drops a trailing fragment left on a pasted URL", () => {
      expect(parseRoomCode("https://awful.chat/r/a1b2c3#frag")).toBe("a1b2c3");
    });

    it("rejects a 5-character code", () => {
      expect(parseRoomCode("a1b2c")).toBeNull();
    });

    it("rejects a 7-character code", () => {
      expect(parseRoomCode("a1b2c3d")).toBeNull();
    });

    it("rejects a 6-character string that is not hex", () => {
      expect(parseRoomCode("gggggg")).toBeNull();
    });

    it("rejects empty input", () => {
      expect(parseRoomCode("")).toBeNull();
    });

    it("rejects whitespace-only input", () => {
      expect(parseRoomCode("   ")).toBeNull();
    });
  });
});
