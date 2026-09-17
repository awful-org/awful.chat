import { expect, it } from "vitest";
import { clockJumped, reservationClockWarning } from "./clock-health";

it("detects forward and backward clock corrections but not ordinary elapsed time", () => {
  const start = { wall: 100_000, monotonic: 10_000 };
  expect(clockJumped(start, { wall: 130_000, monotonic: 40_000 })).toBe(false);
  expect(clockJumped(start, { wall: 3_730_000, monotonic: 40_000 })).toBe(true);
  expect(clockJumped(start, { wall: -3_470_000, monotonic: 40_000 })).toBe(true);
});

it("makes the nested reservation TTL error actionable without hiding other failures", () => {
  expect(reservationClockWarning(new Error("UnsupportedListenAddressesError: /p2p-circuit: InvalidParametersError: Tag ttl must be between greater than 0"))).toContain("automatic date and time");
  expect(reservationClockWarning(new Error("connection refused"))).toBeNull();
  const nested = new Error("UnsupportedListenAddressesError", {
    cause: new AggregateError([new Error("Tag ttl must be between greater than 0")]),
  });
  expect(reservationClockWarning(nested)).toContain("automatic date and time");
  const cyclic = new Error("unrelated");
  cyclic.cause = cyclic;
  expect(reservationClockWarning(cyclic)).toBeNull();
});
