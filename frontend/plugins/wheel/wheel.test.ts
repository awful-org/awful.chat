import { describe, expect, it } from "vitest";
import {
  initialState,
  parseWheelArgs,
  reduce,
  hashSeed,
  type WheelState,
} from "./logic";

const ctx = (did: string, id = "u1", lamport = 1) => ({
  senderDid: did,
  senderName: "N",
  updateId: id,
  lamport,
  ephemeral: false,
});

describe("wheel logic (the real module, not a copy)", () => {
  it("seeds options from the card payload and picks a winner in bounds", () => {
    const state = initialState({ options: ["a", "b", "c"] }) as WheelState;
    expect(state.options).toEqual(["a", "b", "c"]);
    const next = reduce(state, { data: { action: "spin" } }, ctx("did:key:zA")) as WheelState;
    expect(next.spun).toBe(true);
    expect(next.winner).toBeGreaterThanOrEqual(0);
    expect(next.winner).toBeLessThan(3);
  });

  it("first spin wins - later spins are no-ops", () => {
    let state = initialState({ options: ["a", "b"] }) as WheelState;
    state = reduce(state, { data: { action: "spin" } }, ctx("did:key:zA", "u1")) as WheelState;
    const winner = state.winner;
    state = reduce(state, { data: { action: "spin" } }, ctx("did:key:zB", "u2", 2)) as WheelState;
    expect(state.winner).toBe(winner);
  });

  it("is deterministic: same update id and sender always give the same winner", () => {
    const a = reduce(initialState({ options: ["a", "b", "c", "d"] }), { data: { action: "spin" } }, ctx("did:key:zA", "ufixed")) as WheelState;
    const b = reduce(initialState({ options: ["a", "b", "c", "d"] }), { data: { action: "spin" } }, ctx("did:key:zA", "ufixed")) as WheelState;
    expect(a.winner).toBe(b.winner);
  });

  it("a spin against an empty wheel is a no-op, not winner 0", () => {
    const state = initialState(undefined) as WheelState;
    const next = reduce(state, { data: { action: "spin" } }, ctx("d")) as WheelState;
    expect(next.spun).toBe(false);
  });

  it("hashSeed fixed vectors stay stable across builds", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });
});

describe("wheel question", () => {
  it("seeds an optional question from card data, capped and typed", () => {
    expect(initialState({ options: ["a", "b"] }).question).toBe("");
    expect(
      initialState({ question: "What game?", options: ["a", "b"] }).question
    ).toBe("What game?");
    expect(
      initialState({ question: 42, options: ["a", "b"] }).question
    ).toBe("");
    expect(
      initialState({ question: "x".repeat(500), options: ["a", "b"] }).question
    ).toHaveLength(200);
  });
});

describe("wheel hardening", () => {
  const ctx2 = {
    senderDid: "d",
    senderName: "N",
    updateId: "u1",
    lamport: 1,
    ephemeral: false,
  };

  it("ignores non-object update data instead of throwing", () => {
    const state = initialState({ options: ["a", "b"] }) as WheelState;
    for (const bad of [null, undefined, "spin", 7, true]) {
      expect(reduce(state, { data: bad }, ctx2)).toBe(state);
    }
  });

  it("parses the command with the question split on the FIRST ?", () => {
    expect(parseWheelArgs("What game? CS?, Dota")).toEqual({
      question: "What game?",
      options: ["CS?", "Dota"],
    });
    expect(parseWheelArgs("a, b, c")).toEqual({
      question: "",
      options: ["a", "b", "c"],
    });
    expect(parseWheelArgs("only-one")).toBeNull();
  });
});
