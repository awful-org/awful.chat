import { describe, expect, it } from "vitest";
import {
  MAX_WIRE_NAME_LENGTH,
  normalizeWireName,
  stripWireControls,
} from "./wire-name";

describe("normalizeWireName", () => {
  it("keeps an ordinary name untouched", () => {
    expect(normalizeWireName("  Alice  ")).toBe("Alice");
  });

  it("returns an empty string for a non-string", () => {
    expect(normalizeWireName(undefined)).toBe("");
    expect(normalizeWireName(42)).toBe("");
    expect(normalizeWireName({ toString: () => "nope" })).toBe("");
  });

  it("strips C0 control characters", () => {
    expect(normalizeWireName("a\u0000b\u001Fc")).toBe("abc");
  });

  it("strips C1 control characters", () => {
    expect(normalizeWireName("a\u007Fb\u009Fc")).toBe("abc");
  });

  it("strips bidi overrides and isolates", () => {
    // RLO around "gpj" is the trojan-source trick: it renders as "jpg".
    expect(normalizeWireName("photo\u202Egpj\u202C.exe")).toBe("photogpj.exe");
    expect(normalizeWireName("a\u2066b\u2069c")).toBe("abc");
  });

  it("caps the length", () => {
    const long = "x".repeat(MAX_WIRE_NAME_LENGTH + 50);
    expect(normalizeWireName(long)).toHaveLength(MAX_WIRE_NAME_LENGTH);
  });

  it("caps AFTER stripping, so padding with controls cannot shorten it", () => {
    const name = "\u0000".repeat(100) + "y".repeat(MAX_WIRE_NAME_LENGTH);
    expect(normalizeWireName(name)).toBe("y".repeat(MAX_WIRE_NAME_LENGTH));
  });
});

describe("stripWireControls", () => {
  it("leaves emoji and ordinary punctuation alone", () => {
    expect(stripWireControls("hi \u{1F44B}!")).toBe("hi \u{1F44B}!");
  });

  it("does not trim or cap - that is normalizeWireName's job", () => {
    expect(stripWireControls("  spaced  ")).toBe("  spaced  ");
  });
});
