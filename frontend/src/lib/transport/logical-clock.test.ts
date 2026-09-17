import { expect, it } from "vitest";
import { issueLamport, observeLamport, remoteLamportAllowed, validLamport } from "./logical-clock";

it("accepts legacy counters without a wall clock but rejects remote exhaustion attacks", () => {
  expect(remoteLamportAllowed("remote-clock", Date.UTC(2036, 0, 1))).toBe(true);
  expect(remoteLamportAllowed("remote-clock", Number.MAX_SAFE_INTEGER - 1)).toBe(false);
  observeLamport("remote-clock", 2 ** 48);
  expect(remoteLamportAllowed("remote-clock", 2 ** 48 + 1)).toBe(true);
  expect(remoteLamportAllowed("remote-clock", 2 ** 48 + 1_000_001)).toBe(false);
});

it("orders causal sends and keeps conversation counters isolated", () => {
  expect(issueLamport("logical-a")).toBe(1);
  observeLamport("logical-a", 42);
  expect(issueLamport("logical-a")).toBe(43);
  observeLamport("logical-a", 2);
  expect(issueLamport("logical-a")).toBe(44);
  expect(issueLamport("logical-b")).toBe(1);
});

it("ignores invalid values and refuses exhaustion instead of reusing a sequence", () => {
  for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    expect(validLamport(bad)).toBe(false);
    observeLamport("invalid-clock", bad);
  }
  expect(issueLamport("invalid-clock")).toBe(1);
  observeLamport("exhausted-clock", Number.MAX_SAFE_INTEGER - 1);
  expect(() => issueLamport("exhausted-clock")).toThrow("exhausted");
});
