import { describe, expect, it } from "vitest";
import {
  MAX_TYPERS_PER_ROOM,
  TYPING_SEND_INTERVAL_MS,
  TYPING_TTL_MS,
  TypingAnnouncer,
  TypingSender,
  TypingTracker,
  typingFrameChannel,
  typingKey,
  typingLine,
} from "./typing";

describe("TypingSender", () => {
  it("announces the first keystroke, then at most once per interval", () => {
    const s = new TypingSender();
    expect(s.input(true, 1_000)).toBe("start");
    expect(s.input(true, 1_500)).toBeNull();
    expect(s.input(true, 1_000 + TYPING_SEND_INTERVAL_MS - 1)).toBeNull();
    expect(s.input(true, 1_000 + TYPING_SEND_INTERVAL_MS)).toBe("start");
  });

  it("says stop when the draft empties, once", () => {
    const s = new TypingSender();
    s.input(true, 0);
    expect(s.input(false, 100)).toBe("stop");
    expect(s.input(false, 200)).toBeNull();
  });

  it("never says stop for a burst it never started", () => {
    expect(new TypingSender().input(false, 0)).toBeNull();
  });

  it("starts fresh after a reset, without waiting out the interval", () => {
    const s = new TypingSender();
    s.input(true, 0);
    expect(s.reset()).toBe(true);
    expect(s.reset()).toBe(false);
    expect(s.input(true, 10)).toBe("start");
  });
});

describe("TypingAnnouncer", () => {
  it("sends the stop to where the burst started, not where the composer is now", () => {
    const sent: [string, boolean][] = [];
    const a = new TypingAnnouncer<string>((to, on) => sent.push([to, on]));
    let room = "r1";
    a.input(true, 0, () => room);
    room = "r2";
    a.stop();
    a.stop();
    expect(sent).toEqual([["r1", true], ["r1", false]]);
  });

  it("stops when the draft empties", () => {
    const sent: [string, boolean][] = [];
    const a = new TypingAnnouncer<string>((to, on) => sent.push([to, on]));
    a.input(true, 0, () => "r");
    a.input(false, 100, () => "r");
    expect(sent).toEqual([["r", true], ["r", false]]);
  });

  it("asks again on the next keystroke when the conversation was unreachable", () => {
    const sent: [string, boolean][] = [];
    const a = new TypingAnnouncer<string>((to, on) => sent.push([to, on]));
    a.input(true, 0, () => null);
    a.input(true, 10, () => "r");
    expect(sent).toEqual([["r", true]]);
  });
});

describe("TypingTracker", () => {
  it("reports a change only when someone starts or stops", () => {
    const t = new TypingTracker();
    expect(t.note("r", "a", true, 0)).toBe(true);
    expect(t.note("r", "a", true, 1_000)).toBe(false);
    expect(t.note("r", "a", false, 2_000)).toBe(true);
    expect(t.note("r", "a", false, 3_000)).toBe(false);
  });

  it("lists typers in the order they started, per room", () => {
    const t = new TypingTracker();
    t.note("r", "b", true, 0);
    t.note("r", "a", true, 0);
    t.note("other", "c", true, 0);
    t.note("r", "b", true, 100);
    expect(t.typers("r", 200)).toEqual(["b", "a"]);
    expect(t.typers("other", 200)).toEqual(["c"]);
    expect(t.typers("nowhere", 200)).toEqual([]);
  });

  it("forgets a typer who goes quiet, and a repeat keeps them", () => {
    const t = new TypingTracker();
    t.note("r", "a", true, 0);
    t.note("r", "b", true, 0);
    t.note("r", "b", true, 4_000);
    expect(t.typers("r", TYPING_TTL_MS)).toEqual(["b"]);
    expect(t.nextExpiry()).toBe(TYPING_TTL_MS);
    expect(t.prune(TYPING_TTL_MS)).toBe(true);
    expect(t.nextExpiry()).toBe(4_000 + TYPING_TTL_MS);
    expect(t.prune(TYPING_TTL_MS)).toBe(false);
    expect(t.prune(4_000 + TYPING_TTL_MS)).toBe(true);
    expect(t.nextExpiry()).toBeNull();
  });

  it("clears a typer when their message lands", () => {
    const t = new TypingTracker();
    t.note("r", "a", true, 0);
    expect(t.clear("r", "a")).toBe(true);
    expect(t.clear("r", "a")).toBe(false);
    expect(t.typers("r", 1)).toEqual([]);
  });

  it("stops listing new typers past the cap, but keeps refreshing the listed", () => {
    const t = new TypingTracker();
    for (let i = 0; i < MAX_TYPERS_PER_ROOM; i++) t.note("r", `d${i}`, true, 0);
    expect(t.note("r", "late", true, 0)).toBe(false);
    expect(t.typers("r", 1)).toHaveLength(MAX_TYPERS_PER_ROOM);
    t.note("r", "d0", true, 5_000);
    expect(t.typers("r", TYPING_TTL_MS)).toEqual(["d0"]);
  });

  it("clears everything at once", () => {
    const t = new TypingTracker();
    expect(t.clearAll()).toBe(false);
    t.note("r", "a", true, 0);
    expect(t.clearAll()).toBe(true);
    expect(t.typers("r", 1)).toEqual([]);
  });
});

describe("typingLine", () => {
  it("names up to three people, then counts", () => {
    expect(typingLine([])).toBeNull();
    expect(typingLine(["Ana"])).toBe("Ana is typing…");
    expect(typingLine(["Ana", "Bo"])).toBe("Ana and Bo are typing…");
    expect(typingLine(["Ana", "Bo", "Cy"])).toBe("Ana, Bo and Cy are typing…");
    expect(typingLine(["Ana", "Bo", "Cy", "Di"])).toBe("4 people are typing…");
  });
});

describe("typing per channel", () => {
  it("keeps the room's own key for its original chat, and a key of its own per channel", () => {
    expect(typingKey("rd2_room")).toBe("rd2_room");
    expect(typingKey("rd2_room", "")).toBe("rd2_room");
    expect(typingKey("rd2_room", "aaaaaaaaaaaaaaaa")).not.toBe("rd2_room");
    expect(typingKey("rd2_room", "aaaaaaaaaaaaaaaa")).not.toBe(typingKey("rd2_room", "bbbbbbbbbbbbbbbb"));
  });

  it("does not show one channel's typer in another", () => {
    const t = new TypingTracker();
    t.note(typingKey("r", "aaaaaaaaaaaaaaaa"), "did:bob", true, 0);
    expect(t.typers(typingKey("r", "aaaaaaaaaaaaaaaa"), 1)).toEqual(["did:bob"]);
    expect(t.typers(typingKey("r"), 1)).toEqual([]);
  });

  it("reads a frame's channel: none is the original chat, a malformed one drops it", () => {
    const isId = (v: unknown) => typeof v === "string" && /^[a-z0-9]{8,32}$/.test(v);
    expect(typingFrameChannel(undefined, isId)).toBe("");
    expect(typingFrameChannel("aaaaaaaaaaaaaaaa", isId)).toBe("aaaaaaaaaaaaaaaa");
    expect(typingFrameChannel("", isId)).toBeNull();
    expect(typingFrameChannel(42, isId)).toBeNull();
  });
});
