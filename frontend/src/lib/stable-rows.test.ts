import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./stable-rows";

describe("keepUnchanged", () => {
  const row = { did: "did:key:a", name: "Ann", avatarUrl: null, isOnline: true };

  it("hands back the previous object when every field is the same", () => {
    // A keyed list repaints a row whenever its item is a new object, equal or
    // not; the member list rebuilt every row, avatars included, on each tick.
    const previous = { ...row };
    expect(keepUnchanged(previous, { ...row })).toBe(previous);
  });

  it("takes the new row when any field changed", () => {
    const previous = { ...row };
    const next = { ...row, isOnline: false };
    expect(keepUnchanged(previous, next)).toBe(next);
  });

  it("takes the new row when there is nothing to compare against", () => {
    const next = { ...row };
    expect(keepUnchanged(undefined, next)).toBe(next);
  });

  it("takes the new row when the fields differ, not just their values", () => {
    const previous = { ...row } as Record<string, unknown>;
    const next = { ...row, extra: undefined } as Record<string, unknown>;
    expect(keepUnchanged(previous, next)).toBe(next);
  });
});
