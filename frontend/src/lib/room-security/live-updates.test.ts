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

it("holds each author to a share of a room's set, and keeps a flood inside its room", () => {
  let now = 100_000;
  const gate = new LiveUpdateAdmission(() => now, 8, 3);
  for (let i = 0; i < 3; i++) expect(gate.accept("room", "did:key:m", "did:key:m", `f${i}`, now)).toBe(true);
  expect(gate.accept("room", "did:key:m", "did:key:m", "f3", now)).toBe(false);
  expect(gate.accept("room", "did:key:b", "did:key:b", "real", now)).toBe(true);
  // Sybils that fill one room's set leave every other room alone.
  for (const s of ["s1", "s2"]) for (let i = 0; i < 3; i++) gate.accept("room", `did:key:${s}`, `did:key:${s}`, `x${i}`, now);
  expect(gate.accept("room", "did:key:c", "did:key:c", "late", now)).toBe(false);
  expect(gate.accept("other", "did:key:c", "did:key:c", "elsewhere", now)).toBe(true);
  expect(gate.accept("other", "did:key:m", "did:key:m", "f4", now)).toBe(true);
  now += 60_001;
  expect(gate.accept("room", "did:key:m", "did:key:m", "later", now)).toBe(true);
});
