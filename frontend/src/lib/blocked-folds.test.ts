import { describe, expect, it } from "vitest";
import { foldBlocked } from "./blocked-folds";

const msg = (id: string, senderId: string) => ({ id, senderId });
const blocked = new Set(["did:key:zMallory"]);
const blockedSender = (s: string) => (blocked.has(s) ? s : null);
const self = (s: string) => s === "did:key:zMe";

describe("folding a blocked person's messages", () => {
  it("folds an unbroken run into one line on its first message", () => {
    const folds = foldBlocked(
      [msg("1", "did:key:zMallory"), msg("2", "did:key:zMallory"), msg("3", "did:key:zMallory")],
      blockedSender, self, new Set(),
    );
    expect(folds.get("1")).toEqual({ count: 3, ids: ["1", "2", "3"] });
    expect(folds.get("2")).toBeNull();
    expect(folds.get("3")).toBeNull();
  });

  it("starts a new fold after someone else speaks, and leaves others alone", () => {
    const folds = foldBlocked(
      [msg("1", "did:key:zMallory"), msg("2", "did:key:zAna"), msg("3", "did:key:zMallory")],
      blockedSender, self, new Set(),
    );
    expect(folds.get("1")).toEqual({ count: 1, ids: ["1"] });
    expect(folds.has("2")).toBe(false);
    expect(folds.get("3")).toEqual({ count: 1, ids: ["3"] });
  });

  it("shows a run the reader opened, and never folds your own", () => {
    const folds = foldBlocked(
      [msg("1", "did:key:zMallory"), msg("2", "did:key:zMe")],
      (s) => s, self, new Set(["1"]),
    );
    expect(folds.size).toBe(0);
  });
});
