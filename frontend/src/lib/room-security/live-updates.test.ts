import { expect, it } from "vitest";
import { LiveUpdateAdmission } from "./live-updates";

it("rejects forwarding another author's live update and repeated delivery", () => {
  const gate = new LiveUpdateAdmission(() => 100_000);
  expect(gate.accept("room", "did:key:alice", "did:key:bob", "id", 100_000)).toBe(false);
  expect(gate.accept("room", "did:key:alice", "did:key:alice", "id", 100_000)).toBe(true);
  expect(gate.accept("room", "did:key:alice", "did:key:alice", "id", 100_000)).toBe(false);
  expect(gate.accept("other", "did:key:alice", "did:key:alice", "id", 100_000)).toBe(true);
});

it("fails closed at capacity without evicting replay protection, then expires stale entries", () => {
  let now = 100_000;
  const gate = new LiveUpdateAdmission(() => now, 1);
  expect(gate.accept("room", "did:key:a", "did:key:a", "first", now)).toBe(true);
  expect(gate.accept("room", "did:key:a", "did:key:a", "next", now)).toBe(false);
  now += 60_001;
  expect(gate.accept("room", "did:key:a", "did:key:a", "first", 100_000)).toBe(false);
  expect(gate.accept("room", "did:key:a", "did:key:a", "next", now)).toBe(true);
});

it("rejects stale, future, missing and nonfinite freshness values", () => {
  const gate = new LiveUpdateAdmission(() => 100_000);
  for (const timestamp of [39_999, 110_001, NaN, Infinity]) {
    expect(gate.accept("room", "did:key:a", "did:key:a", "id", timestamp)).toBe(false);
  }
});
