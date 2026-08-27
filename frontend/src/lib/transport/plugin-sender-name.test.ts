import { describe, expect, it } from "vitest";
import {
  cachePluginSenderName,
  immediatePluginSenderName,
} from "./plugin-sender-name";

describe("plugin teardown sender names", () => {
  it("retains the latest non-empty, non-Anonymous nickname", () => {
    expect(cachePluginSenderName("Old name", "  New name  ")).toBe("New name");
    expect(cachePluginSenderName("Old name", "Anonymous")).toBe("Old name");
    expect(cachePluginSenderName("Old name", "   ")).toBe("Old name");
  });

  it("uses the cached name for an immediate teardown update", () => {
    expect(immediatePluginSenderName("Waffle fan", "did:me", "peer-id")).toBe(
      "Waffle fan"
    );
  });

  it("falls back deterministically without emitting Anonymous", () => {
    expect(immediatePluginSenderName("", "did:example:alice", "peer-id")).toBe(
      "did:example:"
    );
    expect(immediatePluginSenderName("", null, "peer-identifier")).toBe(
      "peer-identif"
    );
    expect(immediatePluginSenderName("", null, "")).toBe("Unknown");
  });
});
