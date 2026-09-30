import { describe, expect, it } from "vitest";
import { LobbyDialBudget } from "./dm-lobby-budget";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

describe("LobbyDialBudget", () => {
  it("tries one peer once per retry window", () => {
    const budget = new LobbyDialBudget();
    expect(budget.allow("lobby", "p1", T0)).toBe(true);
    expect(budget.mayTry("p1", T0 + 9 * MIN)).toBe(false);
    expect(budget.allow("lobby", "p1", T0 + 9 * MIN)).toBe(false);
    expect(budget.allow("lobby", "p1", T0 + 10 * MIN)).toBe(true);
  });

  it("gives one lobby only a person's worth of devices per window", () => {
    const budget = new LobbyDialBudget();
    for (let i = 0; i < 4; i++) expect(budget.allow("lobby", `p${i}`, T0 + i)).toBe(true);
    expect(budget.allow("lobby", "p4", T0 + 5)).toBe(false);
    // Another lobby has its own allowance.
    expect(budget.allow("other", "q0", T0 + 6)).toBe(true);
    // And the lobby recovers once the window has passed.
    expect(budget.allow("lobby", "p4", T0 + 10 * MIN)).toBe(true);
  });

  it("caps introductions per minute across every lobby", () => {
    const budget = new LobbyDialBudget();
    let allowed = 0;
    for (let i = 0; i < 40; i++) if (budget.allow(`lobby${i}`, `p${i}`, T0 + i)) allowed++;
    expect(allowed).toBe(16);
    expect(budget.allow("lobby-late", "p-late", T0 + MIN)).toBe(true);
  });

  it("keeps a relay flooding a lobby with fresh ids down to a handful of dials", () => {
    const budget = new LobbyDialBudget();
    let dials = 0;
    for (let minute = 0; minute < 60; minute++) {
      for (let i = 0; i < 1000; i++) {
        if (budget.allow("lobby", `fake-${minute}-${i}`, T0 + minute * MIN + i)) dials++;
      }
    }
    // 4 per 10-minute window, over an hour.
    expect(dials).toBe(24);
  });

  it("drops the oldest peers past its cap instead of forgetting everyone", () => {
    const budget = new LobbyDialBudget({ retryMs: 10 * MIN, perLobby: 1000, perMinute: 1000, maxPeers: 3 });
    for (let i = 0; i < 4; i++) budget.allow("lobby", `p${i}`, T0 + i);
    expect(budget.mayTry("p0", T0 + 10)).toBe(true); // evicted, the oldest
    expect(budget.mayTry("p1", T0 + 10)).toBe(false);
    expect(budget.mayTry("p3", T0 + 10)).toBe(false);
  });
});
