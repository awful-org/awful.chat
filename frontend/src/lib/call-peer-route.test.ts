import { describe, expect, it } from "vitest";
import { resetPeerQuality, setVoiceTurn, voiceRouteState } from "./call-peer-quality.svelte";

describe("voice route per person", () => {
  it("tracks who is heard through TURN, apart from quality, and clears with the call", () => {
    setVoiceTurn("ana", true);
    setVoiceTurn("bo", true);
    setVoiceTurn("bo", false);
    expect([...voiceRouteState.turn]).toEqual(["ana"]);
    const before = voiceRouteState.turn;
    setVoiceTurn("ana", true);
    expect(voiceRouteState.turn).toBe(before);
    resetPeerQuality();
    expect(voiceRouteState.turn.size).toBe(0);
  });
});
