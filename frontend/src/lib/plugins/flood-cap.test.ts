import { describe, expect, it } from "vitest";
import {
  CARD_FLOOD_LIMIT,
  CARD_FLOOD_WINDOW,
  UPDATE_FLOOD_LIMIT,
  UPDATE_FLOOD_WINDOW,
  createFloodCap,
  createPluginFloodCaps,
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
