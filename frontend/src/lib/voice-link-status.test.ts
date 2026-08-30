import { describe, it, expect } from "vitest";
import { applyVoiceLinkStatus } from "./voice-link-status";

describe("applyVoiceLinkStatus", () => {
  it("adds a peer on voice-ice-connected", () => {
    const next = applyVoiceLinkStatus(new Set(), {
      type: "voice-ice-connected",
      peerId: "12D3KooWabc",
    });
    expect(next.has("12D3KooWabc")).toBe(true);
  });

  it("removes the same peer on voice-peer-left when both use the full id", () => {
    const connected = new Set(["12D3KooWabc"]);
    const next = applyVoiceLinkStatus(connected, {
      type: "voice-peer-left",
      peerId: "12D3KooWabc",
    });
    expect(next.has("12D3KooWabc")).toBe(false);
  });

  it("removes the same peer on voice-connection-failed", () => {
    const connected = new Set(["12D3KooWabc"]);
    const next = applyVoiceLinkStatus(connected, {
      type: "voice-connection-failed",
      peerId: "12D3KooWabc",
    });
    expect(next.has("12D3KooWabc")).toBe(false);
  });

  it("regression: a truncated peerId on the leave event does not remove the full id - the set only ever grows", () => {
    // This is the exact shape of voice-audit finding 8 before the upstream
    // fix: voice.ts published a slice(-8) id on teardown while the ICE event
    // that inserted the peer used the full id. If this ever regresses, the
    // deletion silently no-ops and the tile renders as connected forever.
    const connected = new Set(["12D3KooWabcdef123"]);
    const next = applyVoiceLinkStatus(connected, {
      type: "voice-connection-failed",
      peerId: "abcdef123", // truncated form - must NOT match the stored key
    });
    expect(next.has("12D3KooWabcdef123")).toBe(true);
    expect(next).toBe(connected); // no-op: unknown key, same set instance back
  });

  it("leaves other peers untouched when one peer disconnects", () => {
    const connected = new Set(["peer-a", "peer-b"]);
    const next = applyVoiceLinkStatus(connected, {
      type: "voice-peer-left",
      peerId: "peer-a",
    });
    expect(next.has("peer-a")).toBe(false);
    expect(next.has("peer-b")).toBe(true);
  });

  it("ignores unrelated status events", () => {
    const connected = new Set(["peer-a"]);
    const next = applyVoiceLinkStatus(connected, { type: "voice-degraded", peerId: "peer-a" });
    expect(next).toBe(connected);
  });

  it("is a no-op re-insert when the peer is already connected", () => {
    const connected = new Set(["peer-a"]);
    const next = applyVoiceLinkStatus(connected, {
      type: "voice-ice-connected",
      peerId: "peer-a",
    });
    expect(next).toBe(connected);
  });
});
