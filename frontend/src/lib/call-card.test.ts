import { describe, expect, it } from "vitest";
import {
  callCardState,
  callCardSummary,
  encodeCallCard,
  foldCallCards,
  formatCallDuration,
  newCallId,
  parseCallCard,
  type CallCardPayload,
} from "./call-card";

const T = "call_event";
const start = (callId: string, at = 1_000): CallCardPayload => ({ v: 1, callId, phase: "start", at });
const end = (callId: string, at = 61_000): CallCardPayload => ({ v: 1, callId, phase: "end", at });
const row = (id: string, card: CallCardPayload | string, type = T) => ({
  id, type, senderId: "did:key:z", content: typeof card === "string" ? card : encodeCallCard(card),
});

describe("call card payloads", () => {
  it("round-trips, and mints ids the parser accepts", () => {
    const card = start(newCallId());
    expect(parseCallCard(encodeCallCard(card))).toEqual(card);
  });

  it("refuses anything that is not a card: rows are untrusted", () => {
    for (const bad of ["", "{", "null", '{"v":2}', '{"v":1,"callId":"x","phase":"start","at":1}',
      '{"v":1,"callId":"abcdefgh","phase":"ring","at":1}', '{"v":1,"callId":"abcdefgh","phase":"start","at":-1}',
      "x".repeat(300)]) {
      expect(parseCallCard(bad)).toBeNull();
    }
  });
});

describe("folding a call's end into its start", () => {
  it("folds the end row away and pairs it with the start", () => {
    const { calls, foldedEnds } = foldCallCards([row("s", start("abcdefgh")), row("e", end("abcdefgh"))], T);
    expect(foldedEnds).toEqual(new Set(["e"]));
    expect(calls.get("abcdefgh")?.end?.card.at).toBe(61_000);
  });

  it("keeps an end whose start is not held, and takes the earliest of two ends", () => {
    expect(foldCallCards([row("e", end("abcdefgh"))], T).foldedEnds.size).toBe(0);
    const both = foldCallCards([row("s", start("abcdefgh")), row("e1", end("abcdefgh", 90_000)), row("e2", end("abcdefgh", 70_000))], T);
    expect(both.calls.get("abcdefgh")?.end?.card.at).toBe(70_000);
    expect(both.foldedEnds).toEqual(new Set(["e1", "e2"]));
  });

  it("maps each start to its end, and holds only the newest unended call open", () => {
    const fold = foldCallCards([
      row("old", start("oldcall1", 1_000)), // lost its end: a closed tab
      row("s", start("newcall1", 5_000)),
    ], T);
    expect(fold.open?.row.id).toBe("s");
    const ended = foldCallCards([row("s", start("abcdefgh")), row("e", end("abcdefgh"))], T);
    expect(ended.endOf.get("s")?.at).toBe(61_000);
    expect(ended.open).toBeNull();
  });

  it("ignores other rows and malformed cards", () => {
    const { calls } = foldCallCards([row("t", start("abcdefgh"), "text"), row("b", "not json")], T);
    expect(calls.size).toBe(0);
  });
});

describe("what a card says", () => {
  it("is in progress while anyone is in it, until its end arrives", () => {
    expect(callCardState({ start: start("abcdefgh"), ongoing: true, joined: false, mine: false })).toEqual({ kind: "ongoing", since: 1_000 });
    expect(callCardState({ start: start("abcdefgh"), end: end("abcdefgh"), ongoing: true, joined: true, mine: false }).kind).toBe("ended");
  });

  it("reads missed only for a call this side neither started nor joined", () => {
    expect(callCardState({ start: start("abcdefgh"), end: end("abcdefgh"), ongoing: false, joined: false, mine: false }).kind).toBe("missed");
    expect(callCardState({ start: start("abcdefgh"), end: end("abcdefgh"), ongoing: false, joined: false, mine: true }))
      .toEqual({ kind: "ended", duration: 60_000 });
  });

  it("says ended without a length when nobody posted the end", () => {
    expect(callCardState({ start: start("abcdefgh"), ongoing: false, joined: true, mine: false }).kind).toBe("ended-unknown");
  });

  it("formats durations and summaries", () => {
    expect(formatCallDuration(45_000)).toBe("45 s");
    expect(formatCallDuration(12 * 60_000)).toBe("12 min");
    expect(formatCallDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(formatCallDuration(2 * 3_600_000)).toBe("2 h");
    expect(callCardSummary(start("abcdefgh"), false)).toBe("Started a call");
    expect(callCardSummary(end("abcdefgh"), true)).toBe("Call ended");
  });
});

describe("an end card that knows when its call started", () => {
  const ended = (startedAt?: number): CallCardPayload => ({ v: 1, callId: "abcdefgh", phase: "end", at: 181_000, startedAt });

  it("keeps a sane startedAt and drops one after its end", () => {
    expect(parseCallCard(encodeCallCard(ended(1_000)))?.startedAt).toBe(1_000);
    expect(parseCallCard(JSON.stringify({ ...ended(), startedAt: 999_999 }))?.startedAt).toBeUndefined();
    expect(parseCallCard(JSON.stringify({ ...start("abcdefgh"), startedAt: 5 }))?.startedAt).toBeUndefined();
  });

  it("previews as the call's length, or as missed for a call this device took no part in", () => {
    expect(callCardSummary(ended(1_000), true)).toBe("Call · 3 min");
    expect(callCardSummary(ended(1_000), false)).toBe("Missed call");
    expect(callCardSummary(ended(), true)).toBe("Call ended");
  });

  it("gives a stand-alone end its length", () => {
    expect(callCardState({ end: ended(1_000), ongoing: false, joined: true, mine: false }))
      .toEqual({ kind: "ended", duration: 180_000 });
  });
});

describe("a call's length, by the device that measured it", () => {
  const measured = (duration: unknown, at = 181_000) =>
    parseCallCard(JSON.stringify({ v: 1, callId: "abcdefgh", phase: "end", at, duration }));

  it("prefers the poster's own measure over two cards' times", () => {
    // The start says 1_000 by the caller's clock; the end's poster measured
    // 90 s on its own. Its clock being off does not matter.
    const end = measured(90_000)!;
    expect(callCardState({ start: start("abcdefgh"), end, ongoing: false, joined: true, mine: false }))
      .toEqual({ kind: "ended", duration: 90_000 });
    expect(callCardSummary(end, true)).toBe("Call · 2 min");
  });

  it("refuses a length that is negative, not a number or longer than a week", () => {
    for (const bad of [-1, "90", Number.MAX_SAFE_INTEGER, null]) expect(measured(bad)?.duration).toBeUndefined();
    expect(measured(0)?.duration).toBe(0);
  });
});
