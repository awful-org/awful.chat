import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFUSED_MAX_SENDERS,
  REFUSED_TTL_MS,
  _clearRefused,
  _noteRefused,
  _withRefused,
} from "./refused-lamports";

beforeEach(() => {
  _clearRefused();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refused lamport claims", () => {
  it("folds a claim into the watermarks we advertise", () => {
    _noteRefused("room-a", "did:key:zAlice", 42);
    expect(_withRefused("room-a", {})).toEqual({ "did:key:zAlice": 42 });
  });

  it("keeps the highest claim and never lowers a stored watermark", () => {
    _noteRefused("room-a", "did:key:zAlice", 42);
    _noteRefused("room-a", "did:key:zAlice", 7);
    expect(_withRefused("room-a", {})).toEqual({ "did:key:zAlice": 42 });
    expect(_withRefused("room-a", { "did:key:zAlice": 99 })).toEqual({
      "did:key:zAlice": 99,
    });
  });

  it("does not leak claims between rooms", () => {
    _noteRefused("room-a", "did:key:zAlice", 42);
    expect(_withRefused("room-b", {})).toEqual({});
  });

  // The sender cap used to be a single global counter that was never
  // decremented, so ONE frame naming REFUSED_MAX_SENDERS invented senders
  // disarmed the anti-storm mechanism for every room for the rest of the
  // session - cheaper and far more durable than the blackhole it guarded.
  it("caps senders per room, so one flooded room cannot disarm another", () => {
    for (let i = 0; i < REFUSED_MAX_SENDERS + 50; i++) {
      _noteRefused("spam-room", `did:key:invented-${i}`, 1);
    }
    expect(Object.keys(_withRefused("spam-room", {})).length).toBe(
      REFUSED_MAX_SENDERS
    );

    _noteRefused("real-room", "did:key:zAlice", 42);
    expect(_withRefused("real-room", {})).toEqual({ "did:key:zAlice": 42 });
  });

  // Claims are uncorroborated by design, so a forged one has to self-heal
  // rather than blackhole a victim's history for the whole session.
  it("expires claims after the TTL", () => {
    _noteRefused("room-a", "did:key:zAlice", 42);
    vi.advanceTimersByTime(REFUSED_TTL_MS - 1000);
    expect(_withRefused("room-a", {})).toEqual({ "did:key:zAlice": 42 });

    vi.advanceTimersByTime(2000);
    expect(_withRefused("room-a", {})).toEqual({});
  });

  it("starts a fresh window after an expiry rather than staying empty", () => {
    _noteRefused("room-a", "did:key:zAlice", 42);
    vi.advanceTimersByTime(REFUSED_TTL_MS + 1000);
    _noteRefused("room-a", "did:key:zBob", 7);
    expect(_withRefused("room-a", {})).toEqual({ "did:key:zBob": 7 });
  });
});
