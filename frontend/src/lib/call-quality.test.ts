import { describe, it, expect } from "vitest";
import {
  applyCallQualityStatus,
  noteTrackAdded,
  worstQuality,
  type PeerVoiceQuality,
} from "./call-quality";

function m(
  entries: [string, PeerVoiceQuality][] = []
): Map<string, PeerVoiceQuality> {
  return new Map(entries);
}

describe("applyCallQualityStatus", () => {
  it("records a p2p verdict on a direct ICE connect", () => {
    const next = applyCallQualityStatus(m(), {
      type: "voice-ice-connected",
      peerId: "a",
      relayed: false,
    });
    expect(next.get("a")).toBe("p2p");
  });

  it("records a relayed verdict when the ICE event says relayed", () => {
    const next = applyCallQualityStatus(m(), {
      type: "voice-ice-connected",
      peerId: "a",
      relayed: true,
    });
    expect(next.get("a")).toBe("relayed");
  });

  it("removes only the named peer on voice-peer-left", () => {
    const peers = m([
      ["a", "degraded"],
      ["b", "p2p"],
    ]);
    const next = applyCallQualityStatus(peers, {
      type: "voice-peer-left",
      peerId: "a",
    });
    expect(next.has("a")).toBe(false);
    expect(next.get("b")).toBe("p2p");
  });

  it("one peer's degraded event never touches another peer's entry", () => {
    const peers = m([["b", "p2p"]]);
    const next = applyCallQualityStatus(peers, {
      type: "voice-degraded",
      peerId: "a",
    });
    expect(next.get("a")).toBe("degraded");
    expect(next.get("b")).toBe("p2p");
  });
});

describe("noteTrackAdded", () => {
  it("regression: an unrelated peer's track arriving must not erase this peer's degraded verdict", () => {
    // This is the exact defect from voice-audit finding 8: a single shared
    // quality value let ANY peer's trackAdded repaint the whole badge "p2p",
    // erasing a real, unrelated degradation.
    let peers = m([["a", "degraded"]]);
    peers = noteTrackAdded(peers, "b") as Map<string, PeerVoiceQuality>;
    expect(peers.get("a")).toBe("degraded");
    expect(peers.get("b")).toBe("p2p");
  });

  it("does not downgrade a peer's own existing verdict", () => {
    const peers = m([["a", "failed"]]);
    const next = noteTrackAdded(peers, "a");
    expect(next.get("a")).toBe("failed");
  });

  it("fills in a first verdict for a peer with none yet", () => {
    const next = noteTrackAdded(m(), "a");
    expect(next.get("a")).toBe("p2p");
  });
});

describe("worstQuality", () => {
  it("returns null when nobody has a verdict", () => {
    expect(worstQuality(m())).toBeNull();
  });

  it("picks failed over degraded over healthy", () => {
    expect(
      worstQuality(
        m([
          ["a", "p2p"],
          ["b", "degraded"],
          ["c", "failed"],
        ])
      )
    ).toBe("failed");
  });

  it("treats p2p and relayed as equally healthy", () => {
    expect(
      worstQuality(
        m([
          ["a", "relayed"],
          ["b", "p2p"],
        ])
      )
    ).not.toBe("degraded");
  });
});
