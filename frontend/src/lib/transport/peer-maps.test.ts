import { describe, expect, it } from "vitest";
import { sameFields, withEntry } from "./peer-maps";

describe("withEntry", () => {
  it("hands back the same map when the frame repeats what it holds", () => {
    const names = new Map([["did:key:a", "Alice"]]);
    expect(withEntry(names, "did:key:a", "Alice")).toBe(names);
    // Nothing to remove is no change either.
    expect(withEntry(names, "did:key:b", undefined)).toBe(names);
  });

  it("makes a new map for a real change, leaving the old one alone", () => {
    const names = new Map([["did:key:a", "Alice"]]);
    const renamed = withEntry(names, "did:key:a", "Alicia");
    expect(renamed).not.toBe(names);
    expect(renamed.get("did:key:a")).toBe("Alicia");
    expect(names.get("did:key:a")).toBe("Alice");

    const added = withEntry(names, "did:key:b", "Bob");
    expect([...added.keys()]).toEqual(["did:key:a", "did:key:b"]);

    const removed = withEntry(names, "did:key:a", undefined);
    expect(removed.has("did:key:a")).toBe(false);
    expect(names.has("did:key:a")).toBe(true);
  });

  it("sets an empty string, which is a value", () => {
    const names = new Map<string, string>();
    expect(withEntry(names, "did:key:a", "").get("did:key:a")).toBe("");
  });

  it("compares records by their fields when asked to", () => {
    const meta = new Map([["did:key:a", { tagText: "mod", nameGlow: true }]]);
    const again = { tagText: "mod", nameGlow: true };
    expect(withEntry(meta, "did:key:a", again, sameFields)).toBe(meta);
    const changed = withEntry(meta, "did:key:a", { tagText: "mod" }, sameFields);
    expect(changed).not.toBe(meta);
    expect(changed.get("did:key:a")).toEqual({ tagText: "mod" });
  });
});

describe("sameFields", () => {
  it("is shallow equality of flat records", () => {
    expect(sameFields({}, {})).toBe(true);
    expect(sameFields({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    expect(sameFields({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameFields({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameFields({ a: undefined }, { b: undefined })).toBe(false);
  });
});
