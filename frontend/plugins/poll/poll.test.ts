import { describe, expect, it } from "vitest";
import { initialState, parsePollArgs, reduce, type PollState } from "./logic";

const ctx = (did: string, name = "N", id = "u1", lamport = 1) => ({
  senderDid: did,
  senderName: name,
  updateId: id,
  lamport,
  ephemeral: false,
});

describe("poll logic (the real module, not a copy)", () => {
  it("seeds question and options from the card payload, and votes count", () => {
    const state = initialState({
      question: "Which game?",
      options: ["Valorant", "CS2"],
    }) as PollState;
    expect(state.options).toEqual(["Valorant", "CS2"]);

    const next = reduce(
      state,
      { data: { action: "vote", vote: 1 } },
      ctx("did:key:zA", "A")
    ) as PollState;
    // The original initialState ignored the payload, options stayed empty,
    // and the bounds check rejected every vote.
    expect(next.votes.get("did:key:zA")?.vote).toBe(1);
  });

  it("keeps the LAST vote per did", () => {
    let state = initialState({ question: "q", options: ["a", "b"] }) as PollState;
    state = reduce(state, { data: { action: "vote", vote: 0 } }, ctx("did:key:zA")) as PollState;
    state = reduce(state, { data: { action: "vote", vote: 1 } }, ctx("did:key:zA", "A", "u2", 2)) as PollState;
    expect(state.votes.size).toBe(1);
    expect(state.votes.get("did:key:zA")?.vote).toBe(1);
  });

  it("rejects NaN, floats, strings and out-of-range votes", () => {
    const state = initialState({ question: "q", options: ["a", "b"] }) as PollState;
    for (const bad of [NaN, 0.5, "1", null, -1, 2]) {
      const next = reduce(
        state,
        { data: { action: "vote", vote: bad } },
        ctx("d")
      ) as PollState;
      expect(next.votes.size).toBe(0);
    }
  });

  it("ignores non-vote actions", () => {
    const state = initialState({ question: "q", options: ["a", "b"] }) as PollState;
    const next = reduce(state, { data: { action: "reset" } }, ctx("d"));
    expect(next).toBe(state);
  });

  it("ignores non-object update data instead of throwing", () => {
    const state = initialState({ question: "q", options: ["a", "b"] }) as PollState;
    for (const bad of [null, undefined, "vote", 7, true]) {
      expect(reduce(state, { data: bad }, ctx("d"))).toBe(state);
    }
  });

  it("caps the question at 200 chars like wheel does", () => {
    const state = initialState({
      question: "x".repeat(500),
      options: ["a", "b"],
    }) as PollState;
    expect(state.question).toHaveLength(200);
  });
});

describe("poll command parsing", () => {
  it("splits on the FIRST question mark only", () => {
    // split("?") regression: "A?" in an option used to swallow B and C.
    expect(parsePollArgs("What now? A?, B, C")).toEqual({
      question: "What now",
      options: ["A?", "B", "C"],
    });
  });

  it("rejects input without a question or with fewer than 2 options", () => {
    expect(parsePollArgs("no question here")).toBeNull();
    expect(parsePollArgs("Question? only-one")).toBeNull();
    expect(parsePollArgs("Question? , ,")).toBeNull();
  });
});
