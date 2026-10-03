import { beforeEach, describe, expect, it } from "vitest";
import {
  allowSyncReaction,
  RepairBackoff,
  REPAIR_BACKOFF_MAX_MS,
  REPAIR_BACKOFF_MIN_MS,
  SYNC_REACTION_MIN_MS,
  _resetSyncThrottle,
} from "./sync-throttle";

beforeEach(() => _resetSyncThrottle());

describe("allowSyncReaction", () => {
  it("allows the first reaction and blocks repeats inside the window", () => {
    expect(allowSyncReaction("push|p|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|p|r", 1000 + SYNC_REACTION_MIN_MS - 1)).toBe(
      false
    );
    expect(allowSyncReaction("push|p|r", 1000 + SYNC_REACTION_MIN_MS)).toBe(
      true
    );
  });

  it("a blocked attempt does not extend the window", () => {
    // The window measures from the last ALLOWED reaction: a peer hammering
    // frames must not push its own next allowance further away (or closer).
    allowSyncReaction("k", 1000);
    allowSyncReaction("k", 5000); // blocked
    expect(allowSyncReaction("k", 1000 + SYNC_REACTION_MIN_MS)).toBe(true);
  });

  it("scopes windows per key", () => {
    expect(allowSyncReaction("push|a|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|b|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|a|r2", 1000)).toBe(true);
    expect(allowSyncReaction("push|a|r", 1001)).toBe(false);
  });
});

describe("RepairBackoff", () => {
  /** When a pair that never finds anything missing exchanges a repair digest. */
  function quietDigests(backoff: RepairBackoff, until: number): number[] {
    const sent: number[] = [];
    // The repair tick runs every 15s.
    for (let now = 0; now <= until; now += 15_000) {
      if (!backoff.due("p", "r", now)) continue;
      backoff.wait("p", "r", now);
      sent.push(now);
    }
    return sent;
  }

  it("spaces out digests to a quiet peer, up to five minutes apart", () => {
    const sent = quietDigests(new RepairBackoff(), 60 * 60_000);
    const gaps = sent.slice(1).map((t, i) => t - sent[i]);
    expect(gaps.slice(0, 4)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(Math.max(...gaps)).toBe(REPAIR_BACKOFF_MAX_MS);
    // An hour of a quiet pair: about 15 digests, where it used to be 240.
    expect(sent.length).toBeLessThan(20);
  });

  it("starts over when the room moves", () => {
    const backoff = new RepairBackoff();
    quietDigests(backoff, 20 * 60_000);
    expect(backoff.due("p", "r", 20 * 60_000 + 1)).toBe(false);
    backoff.reset("p", "r");
    expect(backoff.due("p", "r", 20 * 60_000 + 1)).toBe(true);
    backoff.wait("p", "r", 0);
    expect(backoff.due("p", "r", REPAIR_BACKOFF_MIN_MS)).toBe(true);
  });

  it("keeps rooms and peers apart, and forgets a peer that leaves", () => {
    const backoff = new RepairBackoff();
    backoff.wait("p", "r", 0);
    expect(backoff.due("p", "r", 1)).toBe(false);
    expect(backoff.due("p", "other", 1)).toBe(true);
    expect(backoff.due("q", "r", 1)).toBe(true);
    backoff.forgetPeer("p");
    expect(backoff.due("p", "r", 1)).toBe(true);
  });
});
