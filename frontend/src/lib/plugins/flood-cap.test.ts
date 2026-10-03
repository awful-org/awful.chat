import { describe, expect, it } from "vitest";
import {
  CARD_FLOOD_LIMIT,
  CARD_FLOOD_WINDOW,
  SEND_SLACK_MS,
  UPDATE_FLOOD_LIMIT,
  UPDATE_FLOOD_WINDOW,
  createFloodCap,
  createPluginFloodCaps,
  createPluginSendCaps,
  createSendCap,
} from "./flood-cap";

describe("a flood cap", () => {
  it("lets so many through per window, and starts over with the next", () => {
    let t = 0;
    const allow = createFloodCap(3, 1000, () => t);
    expect([allow("k"), allow("k"), allow("k"), allow("k")]).toEqual([true, true, true, false]);
    expect(allow("other")).toBe(true);
    t = 1000;
    expect(allow("k")).toBe(true);
  });

  // A live send arrives twice, gossip and direct batch: both copies used to
  // count, so an honest sender got half the window - and a peer replaying
  // someone's message could spend that someone's window for them.
  it("counts a message once, however many copies arrive", () => {
    let t = 0;
    const allow = createFloodCap(2, 1000, () => t);
    expect(allow("k", "a")).toBe(true);
    expect(allow("k", "a")).toBe(true);
    expect(allow("k", "b")).toBe(true);
    for (let i = 0; i < 5; i++) expect(allow("k", "a")).toBe(true);
    expect(allow("k", "c")).toBe(false);
    // ... and a copy of a message it dropped is dropped too.
    expect(allow("k", "c")).toBe(false);
  });
});

// S10.1 / M15: the persisted-update cap was keyed on the pluginId too, which
// is whatever the sender wrote - a made-up plugin per update was a fresh
// window per update - and cards had no cap at all.
describe("the plugin caps", () => {
  it("hold a sender to one update window per room, whatever plugin each names", () => {
    let t = 0;
    const caps = createPluginFloodCaps(() => t);
    for (let i = 0; i < UPDATE_FLOOD_LIMIT; i++) {
      expect(caps.update("room-1", "did:key:zMallory", `u${i}`)).toBe(true);
    }
    expect(caps.update("room-1", "did:key:zMallory", "one-more")).toBe(false);
    // Someone else, or the same sender in another room, has their own.
    expect(caps.update("room-1", "did:key:zAna", "u0")).toBe(true);
    expect(caps.update("room-2", "did:key:zMallory", "u0")).toBe(true);
    t = UPDATE_FLOOD_WINDOW;
    expect(caps.update("room-1", "did:key:zMallory", "later")).toBe(true);
  });

  it("cap cards per room and sender", () => {
    let t = 0;
    const caps = createPluginFloodCaps(() => t);
    for (let i = 0; i < CARD_FLOOD_LIMIT; i++) {
      expect(caps.card("room-1", "did:key:zMallory", `c${i}`)).toBe(true);
    }
    expect(caps.card("room-1", "did:key:zMallory", "c-flood")).toBe(false);
    expect(caps.card("room-1", "did:key:zAna", "c0")).toBe(true);
    t = CARD_FLOOD_WINDOW;
    expect(caps.card("room-1", "did:key:zMallory", "c-later")).toBe(true);
  });

  it("keep ephemerals per plugin, a window apart from updates and cards", () => {
    const caps = createPluginFloodCaps(() => 0);
    for (let i = 0; i < 4; i++) expect(caps.ephemeral("wheel", "peer")).toBe(true);
    expect(caps.ephemeral("wheel", "peer")).toBe(false);
    expect(caps.ephemeral("poll", "peer")).toBe(true);
    expect(caps.update("room-1", "peer", "u")).toBe(true);
    expect(caps.card("room-1", "peer", "c")).toBe(true);
  });
});

/** Repeatable randomness: mulberry32. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The receiving caps dropped an honest sender's excess without a word, and
// the dropped row seldom came back: nothing on the sending side kept to them.
describe("the sending side of a cap", () => {
  it("refuses past the limit, says how long to wait, and frees slots as they age", () => {
    let t = 0;
    const take = createSendCap(3, 1000, () => t);
    for (let i = 0; i < 3; i++) {
      expect(take("k").ok).toBe(true);
      t += 100;
    }
    // The first slot was taken at 0 and ages out at the window plus slack.
    expect(take("k")).toEqual({ ok: false, waitMs: 1000 + SEND_SLACK_MS - 300 });
    expect(take("other").ok).toBe(true);
    t = 1000 + SEND_SLACK_MS;
    expect(take("k").ok).toBe(true);
    expect(take("k").ok).toBe(false);
  });

  it("gives a slot back for a send that never went out", () => {
    const take = createSendCap(2, 1000, () => 0);
    const first = take("k");
    expect(take("k").ok).toBe(true);
    expect(take("k").ok).toBe(false);
    if (!first.ok) throw new Error("unreachable");
    first.release();
    first.release();
    expect(take("k").ok).toBe(true);
    expect(take("k").ok).toBe(false);
  });

  // What the sending cap is for: whatever moment a receiver's window starts
  // at, and however the arrivals bunch up (by less than the slack), nothing
  // that was sent gets dropped.
  it.each([
    ["updates", UPDATE_FLOOD_LIMIT, UPDATE_FLOOD_WINDOW],
    ["cards", CARD_FLOOD_LIMIT, CARD_FLOOD_WINDOW],
  ])("keeps %s inside every receiver's window", (_kind, limit, windowMs) => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = random(seed);
      let t = 0;
      const take = createSendCap(limit, windowMs, () => t);
      const arrivals: Array<{ at: number; id: string }> = [];
      for (let i = 0; i < 1500; i++) {
        // Mostly bursts, now and then a pause.
        t += rand() < 0.85 ? rand() * 300 : rand() * windowMs;
        if (take("room|me").ok) arrivals.push({ at: t + rand() * SEND_SLACK_MS, id: `m${i}` });
      }
      expect(arrivals.length).toBeGreaterThan(limit * 4);
      arrivals.sort((a, b) => a.at - b.at);
      let now = 0;
      const receive = createFloodCap(limit, windowMs, () => now);
      for (const { at, id } of arrivals) {
        now = at;
        expect(receive("room|me", id), `seed ${seed}, ${id} at ${at}`).toBe(true);
      }
    }
  });

  it("counts updates and cards per room and sender, apart", () => {
    const caps = createPluginSendCaps(() => 0);
    for (let i = 0; i < UPDATE_FLOOD_LIMIT; i++) expect(caps.update("room-1", "me").ok).toBe(true);
    expect(caps.update("room-1", "me").ok).toBe(false);
    expect(caps.update("room-2", "me").ok).toBe(true);
    for (let i = 0; i < CARD_FLOOD_LIMIT; i++) expect(caps.card("room-1", "me").ok).toBe(true);
    expect(caps.card("room-1", "me").ok).toBe(false);
  });
});
